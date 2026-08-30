"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveIdentity } from "@/lib/identity/resolve";
import type {
  ApiEnvelope,
  EmailPayload,
  EnrichProvider,
  FunnelItem,
  IdentityResult,
  NormalizedAudit,
  RocketReachProfile,
} from "@/lib/types";

/**
 * A strictly sequential queue that lives in the browser.
 *
 * The audit API runs MAX_CONCURRENT_ANALYSES=1, so more than one in-flight
 * request would only queue upstream and risk a 429. Keeping the queue here —
 * rather than on the server — also means it works on serverless hosting, where
 * a server-side queue would need a durable backend to exist at all.
 */
export function useFunnelQueue() {
  const [items, setItems] = useState<FunnelItem[]>([]);
  const [tick, setTick] = useState(0);

  // Mirrors state for callbacks that must not close over a stale render.
  // Assigned in an effect: refs may not be written during render.
  const itemsRef = useRef<FunnelItem[]>([]);
  const workingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Derived, not stored: one less state to keep in sync.
  const running = items.some((item) => item.stage === "analyzing" || item.stage === "generating");

  const patch = useCallback((id: string, changes: Partial<FunnelItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }, []);

  /**
   * Records a funnel in the spreadsheet.
   *
   * Failures here are swallowed on purpose: Sheets being unreachable must not
   * turn a completed audit into a failed one. The row is keyed on the URL, so
   * the next write for the same funnel corrects whatever this one missed.
   */
  const persist = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await fetch("/api/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ApiEnvelope<{ persisted: boolean }>;
      return Boolean(payload.data?.persisted);
    } catch {
      return false;
    }
  }, []);

  /** Returns how many were added — a bulk paste usually contains repeats. */
  const enqueue = useCallback((urls: string[], performedAction = false): number => {
    let added = 0;
    setItems((current) => {
      const seen = new Set(current.map((item) => item.url));
      const additions: FunnelItem[] = urls
        .filter((url) => !seen.has(url))
        .map((url) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          url,
          stage: "queued",
          audit: null,
          email: null,
          editedEmail: null,
          error: null,
          notice: null,
          startedAt: null,
          finishedAt: null,
          performedAction,
          identity: null,
          confirmedName: null,
          confirmedEmail: null,
          approvedEmail: null,
          rejectedEmails: [],
          rocketReachProfiles: [],
        }));
      added = additions.length;
      return [...current, ...additions];
    });
    return added;
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((current) => current.filter((item) => !["saved", "approved", "failed"].includes(item.stage)));
  }, []);

  /**
   * Runs one funnel at a time while anything is queued.
   *
   * The in-flight request deliberately survives re-renders. An earlier version
   * cancelled it in the effect cleanup, which deadlocked immediately: the first
   * patch() ("analyzing") changed `items`, the effect re-ran, its cleanup
   * cancelled the fetch that had just started, and the result was discarded
   * while the worker lock stayed held. Only unmounting stops the worker now.
   */
  useEffect(() => {
    if (workingRef.current) return;
    const next = items.find((item) => item.stage === "queued");
    if (!next) return;

    workingRef.current = true;

    void (async () => {
      patch(next.id, { stage: "analyzing", startedAt: Date.now(), error: null, notice: null });

      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: next.url, performedAction: next.performedAction }),
        });

        const payload = (await response.json()) as ApiEnvelope<{
          audit: NormalizedAudit;
          identity: IdentityResult | null;
          email: EmailPayload | null;
          emailError: { code: string; message: string } | null;
        }>;

        // Written before the mount check on purpose. The request is
        // deliberately not cancelled when the component unmounts, so a result
        // that arrives after someone navigates away is still a real result —
        // returning here first would silently throw away a finished audit that
        // has already been paid for. persist() touches no React state.
        if (!payload.ok || !payload.data) {
          const error = payload.error ?? { code: "internal_error", message: "Something went wrong." };
          void persist({ url: next.url, stage: "failed", errorMessage: error.message });
          if (!mountedRef.current) return;
          patch(next.id, { stage: "failed", error, finishedAt: Date.now() });
        } else {
          const { audit, identity, email, emailError } = payload.data;
          // Written now rather than only on approval, so closing the tab does
          // not lose the run.
          void persist({
            url: next.url,
            stage: "ready",
            audit,
            identity,
            email,
            warningCount: email?.warnings?.length ?? 0,
            errorMessage: emailError?.message ?? null,
          });
          if (!mountedRef.current) return;
          patch(next.id, {
            stage: "ready",
            audit,
            identity,
            email,
            notice: emailError ? `Audit succeeded, but the email failed: ${emailError.message}` : null,
            finishedAt: Date.now(),
          });
        }
      } catch {
        if (mountedRef.current) {
          patch(next.id, {
            stage: "failed",
            error: { code: "network", message: "Could not reach the server." },
            finishedAt: Date.now(),
          });
        }
      } finally {
        workingRef.current = false;
        // Releasing the lock is a ref change, which does not re-render. Bump a
        // counter so this effect re-runs and picks up the next queued funnel.
        if (mountedRef.current) setTick((value) => value + 1);
      }
    })();

  }, [items, tick, patch, persist]);

  const regenerate = useCallback(
    async (id: string, overrides?: { identity?: IdentityResult | null; performedAction?: boolean }) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item?.audit) return;

      patch(id, { stage: "generating", error: null, notice: null });
      try {
        const response = await fetch("/api/generate-email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            audit: item.audit,
            performedAction: overrides?.performedAction ?? item.performedAction,
            // React state has not settled yet when this is called straight
            // after a patch, so a caller that just built a new identity passes
            // it explicitly rather than racing the re-render.
            identity: overrides?.identity ?? item.identity,
            confirmedName: item.confirmedName,
          }),
        });
        const payload = (await response.json()) as ApiEnvelope<EmailPayload>;
        if (!payload.ok || !payload.data) {
          patch(id, { stage: "ready", notice: payload.error?.message ?? "Could not regenerate the email." });
          return;
        }
        patch(id, { stage: "ready", email: payload.data, editedEmail: null });
      } catch {
        patch(id, { stage: "ready", notice: "Could not reach the server." });
      }
    },
    [patch],
  );

  const edit = useCallback(
    (id: string, edited: { subject: string; email: string }) => patch(id, { editedEmail: edited }),
    [patch],
  );

  /**
   * Approving is a decision, so it is written down. Leaving it as local state
   * meant the sheet still said "ready" while the dashboard said "approved",
   * and the disagreement only surfaced on the Runs page.
   */
  const approve = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item) return;
      patch(id, { stage: "approved" });
      await persist({
        url: item.url,
        audit: item.audit,
        email: item.email ? { ...item.email, ...(item.editedEmail ?? {}) } : null,
        identity: item.identity,
        approvedEmail: item.approvedEmail,
        approved: true,
        edited: Boolean(item.editedEmail),
        stage: "approved",
        warningCount: item.email?.warnings?.length ?? 0,
      });
    },
    [patch, persist],
  );

  /** Records the operator's confirmed owner, then rewrites the email with it. */
  const confirmOwner = useCallback(
    async (id: string, name: string, email: string | null) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item?.identity) return;

      // Built by the resolver rather than by hand, so a typed address is
      // matched against what was actually found and becomes the contact
      // address. The hand-rolled version dropped the email entirely.
      const typed = email?.trim().toLowerCase() || null;
      const emails = typed && !item.identity.emails.some((entry) => entry.address === typed)
        ? [
            ...item.identity.emails,
            {
              address: typed,
              kind: "personal" as const,
              source: "contact_page" as const,
              confidence: "confirmed" as const,
              evidence: "Entered by the operator.",
              foundOn: "operator",
              observed: true,
            },
          ]
        : item.identity.emails;

      const identity = resolveIdentity({
        people: item.identity.people,
        emails,
        brand: item.identity.company.brand,
        legalEntity: item.identity.company.legalEntity,
        domain: item.identity.company.domain,
        rootDomain: item.identity.company.rootDomain,
        pagesChecked: item.identity.pagesChecked,
        confirmedName: name,
        confirmedEmail: typed,
        rejectedEmails: item.rejectedEmails,
      });

      patch(id, {
        identity,
        confirmedName: name,
        confirmedEmail: typed,
        // A confirmed address is by definition approved by the person typing it.
        approvedEmail: identity.ownerEmail?.address ?? typed ?? item.approvedEmail,
      });
      await regenerate(id, { identity });
    },
    [patch, regenerate],
  );

  /**
   * Spends one enrichment credit on this funnel's domain.
   *
   * Never automatic. The free path (the site's own /about and /team pages)
   * runs on every analysis; this is the operator saying "that found nothing,
   * try the paid one". The server merges the result through the same
   * resolver, so Hunter cannot single-handedly promote a name to usable.
   */
  const enrich = useCallback(
    async (id: string, provider: EnrichProvider, profileId?: number) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item?.identity || item.enriching) return;

      patch(id, { enriching: true, notice: null, error: null });
      try {
        const response = await fetch("/api/enrich", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identity: item.identity,
            provider,
            profileId,
            // Without these the server re-resolves from scratch and offers
            // back the very addresses the operator just refused.
            rejectedEmails: item.rejectedEmails,
            confirmedEmail: item.confirmedEmail,
          }),
        });
        const payload = (await response.json()) as ApiEnvelope<{
          identity: IdentityResult;
          note: string;
          profiles: RocketReachProfile[];
        }>;

        if (!mountedRef.current) return;
        if (!payload.ok || !payload.data) {
          patch(id, { enriching: false, notice: payload.error?.message ?? "The contact lookup failed." });
          return;
        }

        const { identity, note, profiles } = payload.data;
        patch(id, {
          enriching: false,
          identity,
          notice: note,
          // A search returns profiles; a lookup does not, and must not wipe them.
          ...(profiles.length > 0 ? { rocketReachProfiles: profiles } : {}),
        });

        // A name that now clears the bar changes the greeting, so the email is
        // no longer the right one for this prospect.
        if (identity.safeToAddressByName && !item.identity.safeToAddressByName) await regenerate(id);
      } catch {
        if (mountedRef.current) patch(id, { enriching: false, notice: "The contact lookup failed." });
      }
    },
    [patch, regenerate],
  );

  /**
   * The operator accepts the proposed contact address.
   *
   * Only an accepted address reaches the sheet. Nothing is written from a
   * heuristic alone — the whole point of proposing an owner address and a
   * fallback separately is that a human sees which one they are taking.
   */
  const approveEmail = useCallback(
    (id: string, address: string) => patch(id, { approvedEmail: address }),
    [patch],
  );

  /**
   * The operator refuses an address. It is remembered and never proposed
   * again for this funnel, so rejecting simply reveals the next candidate.
   */
  const rejectEmail = useCallback(
    (id: string, address: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item?.identity) return;

      const rejected = [...new Set([...item.rejectedEmails, address.toLowerCase()])];
      // Re-resolving is pure and instant, so it runs here rather than as a
      // round trip. Rejecting one address simply reveals the next candidate.
      const identity = resolveIdentity({
        people: item.identity.people,
        emails: item.identity.emails,
        brand: item.identity.company.brand,
        legalEntity: item.identity.company.legalEntity,
        domain: item.identity.company.domain,
        rootDomain: item.identity.company.rootDomain,
        pagesChecked: item.identity.pagesChecked,
        confirmedName: item.confirmedName,
        confirmedEmail: item.confirmedEmail,
        rejectedEmails: rejected,
      });

      patch(id, {
        identity,
        rejectedEmails: rejected,
        approvedEmail: item.approvedEmail === address.toLowerCase() ? null : item.approvedEmail,
      });
    },
    [patch],
  );

  const save = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item) return { persisted: false, message: "Nothing to save." };
      // Claim the save BEFORE awaiting. The button disables on `saving`, so a
      // second click during the round trip cannot start a second write — two
      // overlapping writes are what produced duplicate rows.
      if (item.saving) return { persisted: false, message: "Already saving…" };
      patch(id, { saving: true });

      const email = item.email ? { ...item.email, ...(item.editedEmail ?? {}) } : null;

      try {
        const persisted = await persist({
          url: item.url,
          audit: item.audit,
          email,
          approved: true,
          edited: Boolean(item.editedEmail),
          identity: item.identity,
          approvedEmail: item.approvedEmail,
          stage: "saved",
          warningCount: item.email?.warnings?.length ?? 0,
        });
        patch(id, { stage: "saved", saving: false });
        return {
          persisted,
          message: persisted
            ? "Saved to Google Sheets."
            : "Marked as saved, but nothing was written — check the Sheets connection.",
        };
      } catch {
        patch(id, { saving: false });
        return { persisted: false, message: "Could not reach the server." };
      }
    },
    [patch, persist],
  );

  const retry = useCallback((id: string) => patch(id, { stage: "queued", error: null, notice: null }), [patch]);

  return {
    items,
    running,
    enqueue,
    remove,
    clearFinished,
    regenerate,
    edit,
    approve,
    save,
    retry,
    confirmOwner,
    enrich,
    approveEmail,
    rejectEmail,
  };
}
