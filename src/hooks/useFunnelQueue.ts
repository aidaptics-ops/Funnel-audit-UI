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
  OwnerSearch,
  RocketReachProfile,
  ContactCandidate,
} from "@/lib/types";
import type { FunnelRecord } from "@/lib/sheets/types";
import { isPending, sortRuns, toRun, type RunSummary } from "@/lib/runs";
import { runKey } from "@/lib/sheets/key";

/**
 * A strictly sequential queue, driven here and stored on the server.
 *
 * The audit API runs MAX_CONCURRENT_ANALYSES=1, so more than one in-flight
 * request would only queue upstream and risk a 429 — hence one at a time.
 *
 * The ORDER is decided in this hook; the WORK is not owned by it. Every queued
 * funnel is written to the sheet the moment it is added, so closing the tab,
 * clicking through to Runs or losing the machine leaves the backlog intact and
 * the next page load picks it straight back up. It used to live only in this
 * component, which meant navigating away silently threw away everything still
 * waiting behind the funnel that happened to be running.
 */
/** How many past runs the Funnels page rehydrates. Enough to find yesterday's. */
const RESTORE_LIMIT = 25;

/**
 * A stored run, as a queue item.
 *
 * The audit is a trimmed copy — enough to show the findings and the contacts,
 * not the full capture — so the item is marked restored and the panels render
 * what is actually there rather than implying more.
 */
function fromRun(run: RunSummary, index: number): FunnelItem {
  return {
    id: `restored-${index}-${run.url}`,
    url: run.url,
    stage: run.stage,
    // Null on purpose: the stored audit is a summary, and the audit panel
    // reads fields the summary does not carry. It goes in restoredAudit,
    // which the UI renders on its own terms.
    audit: null,
    restoredAudit: run.audit,
    email: run.emailSubject
      ? ({
          subject: run.emailSubject,
          email: run.emailBody,
          angle: run.emailAngle,
          personalization_points: [],
          warnings: [],
        } as unknown as EmailPayload)
      : null,
    editedEmail: null,
    error: run.errorMessage ? { code: "failed", message: run.errorMessage } : null,
    notice: null,
    startedAt: null,
    finishedAt: null,
    performedAction: false,
    identity: null,
    // The name the extraction found, as stored. A restored run has no identity
    // object to re-derive it from, and the stored audit summary never carried
    // it — this column is where it actually lives.
    business: run.brand || null,
    confirmedName: run.ownerName || null,
    confirmedEmail: run.ownerEmail || null,
    approvedEmail: run.emailApproved ? run.ownerEmail : null,
    rejectedEmails: [],
    rocketReachProfiles: [],
    ownerSearch: null,
    contacts: run.contacts,
    restored: true,
  };
}

/**
 * A row the sheet says is still owed, rebuilt as live queue work.
 *
 * Deliberately not fromRun(): this is not history to display, it is a job to
 * execute. It carries no audit, no email and no `restored` flag, so the worker
 * picks it up exactly as though it had just been pasted in — which, from the
 * operator's point of view, it was.
 */
function fromPending(run: RunSummary, index: number): FunnelItem {
  return {
    id: `pending-${index}-${run.url}`,
    url: run.url,
    stage: "queued",
    audit: null,
    email: null,
    editedEmail: null,
    error: null,
    notice: null,
    startedAt: null,
    finishedAt: null,
    // Read back from the row. Losing it would silently turn "Just booked a
    // call with your team..." into a claim nobody made.
    performedAction: run.performedAction,
    identity: null,
    business: run.brand || null,
    confirmedName: null,
    confirmedEmail: null,
    approvedEmail: null,
    rejectedEmails: [],
    rocketReachProfiles: [],
    ownerSearch: null,
    contacts: [],
  };
}

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

  /**
   * Restores recent runs from the backend on mount.
   *
   * The queue used to exist only in this component, so leaving the page threw
   * a completed analysis away — the run was in the spreadsheet, but nothing
   * ever read it back. Now the sheet is the source of truth and this is a view
   * onto it: navigate away, come back, the work is still here.
   */
  useEffect(() => {
    let alive = true;

    void fetch("/api/records")
      .then((response) => response.json())
      .then((payload: ApiEnvelope<{ records: FunnelRecord[] }>) => {
        if (!alive || !payload.ok || !payload.data) return;
        const all = sortRuns(payload.data.records.map(toRun));
        if (all.length === 0) return;

        // Unfinished work is separated from history and is NEVER dropped by
        // the display limit: a fifty-URL batch must come back whole, however
        // many completed runs sit in front of it.
        const pending = all.filter((run) => isPending(run));
        const pendingUrls = new Set(pending.map((run) => run.url));
        const finished = all.filter((run) => !pendingUrls.has(run.url)).slice(0, RESTORE_LIMIT);

        setItems((current) => {
          // Anything queued in this session wins: it is either newer than the
          // sheet or actively running.
          //
          // Keyed on BOTH sides. A live item holds the href the operator
          // pasted, tracking parameters and all; the sheet holds the runKey of
          // the same funnel. Comparing one against the other never matched, so
          // a funnel already running in this tab was restored a second time
          // and analysed twice.
          const live = new Set(current.map((item) => runKey(item.url)));
          const isNew = (run: RunSummary): boolean => !live.has(runKey(run.url));
          const additions = [
            // Oldest first, so a restored backlog runs in the order it was
            // queued rather than backwards.
            ...[...pending].reverse().filter(isNew).map(fromPending),
            ...finished.filter(isNew).map(fromRun),
          ];
          return additions.length > 0 ? [...current, ...additions] : current;
        });
      })
      .catch(() => {
        // A restore failure must not stop someone queuing new work.
      });

    return () => {
      alive = false;
    };
  }, []);

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

  /**
   * Returns how many were added — a bulk paste usually contains repeats.
   *
   * The rows are written to the backend as well as to local state. Queueing
   * used to be a purely local act, so navigating to Runs — or closing the tab
   * — destroyed everything still waiting. State first so the list appears
   * instantly; the write follows and is what makes it survive.
   */
  const enqueue = useCallback((urls: string[], performedAction = false): number => {
    // Computed here, NOT inside the setItems updater. React runs that updater
    // during a later render, so anything assigned in it is still undefined
    // when this function returns — which silently sent an empty list to the
    // server and lost three of every four queued funnels.
    const seen = new Set(itemsRef.current.map((item) => runKey(item.url)));
    const fresh = urls.filter((url) => {
      const key = runKey(url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) return 0;

    const additions: FunnelItem[] = fresh.map((url, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}`,
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
      business: null,
      confirmedName: null,
      confirmedEmail: null,
      approvedEmail: null,
      rejectedEmails: [],
      rocketReachProfiles: [],
      ownerSearch: null,
      contacts: [],
    }));

    // The updater re-checks against the committed list, because itemsRef can
    // be one render behind if two pastes land in quick succession.
    setItems((current) => {
      const live = new Set(current.map((item) => runKey(item.url)));
      return [...current, ...additions.filter((item) => !live.has(runKey(item.url)))];
    });

    // One append for the whole batch, so fifty URLs cost one round trip.
    // Fire and forget: a storage failure must not stop the analysis that is
    // about to run anyway.
    void fetch("/api/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: fresh, performedAction }),
    }).catch(() => undefined);

    return additions.length;
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    // These three are finished work whose row stays in the sheet as history,
    // so clearing them from this session's list loses nothing.
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

      // Claim it on the server too. Two tabs both restoring the same queued
      // row would otherwise both run it, and pay for it twice.
      void fetch("/api/records", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: next.url, stage: "analyzing" }),
      }).catch(() => undefined);

      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: next.url,
            performedAction: next.performedAction,
          }),
        });

        const payload = (await response.json()) as ApiEnvelope<{
          audit: NormalizedAudit;
          identity: IdentityResult | null;
          ownerSearch: OwnerSearch | null;
          contacts: ContactCandidate[];
          email: EmailPayload | null;
          emailError: { code: string; message: string } | null;
          /**
           * Why no email exists, when none does. Carried onto the item so the
           * Outreach card can refuse to offer a button that would only be
           * refused again server-side.
           */
          emailBlocked?: { reason: string | null; message: string } | null;
          /** "incomplete" when the two-page analysis degraded. */
          auditStatus?: "complete" | "incomplete";
          /** Everything non-fatal this run wants to say about itself. */
          reasons?: string[];
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
          const { audit, identity, ownerSearch, contacts, email, emailError, emailBlocked } = payload.data;
          /*
           * The SERVER's verdict, carried through rather than re-inferred.
           *
           * /api/analyze has already written this row. This write is the
           * backstop for a server-side persist that failed, so it must state
           * what the server concluded and not a fresh guess: an inferred
           * "complete" plus a null error_message rewrote a degraded run into a
           * fully analysed one and erased the sentence explaining it.
           */
          const auditStatus = payload.data.auditStatus ?? "complete";
          const reason = emailError?.message ?? payload.data.reasons?.[0] ?? null;

          // Written now rather than only on approval, so closing the tab does
          // not lose the run.
          void persist({
            url: next.url,
            stage: "ready",
            audit,
            auditStatus,
            identity,
            email,
            warningCount: email?.warnings?.length ?? 0,
            errorMessage: reason,
          });
          if (!mountedRef.current) return;
          patch(next.id, {
            stage: "ready",
            audit,
            auditStatus,
            emailBlocked: emailBlocked ?? null,
            identity,
            business: identity?.company.brand ?? audit.brand ?? null,
            ownerSearch,
            contacts,
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
            // So the model call this triggers is charged to this funnel rather
            // than going unattributed on the Expenditure page.
            url: item.url,
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
        // The gate opened (a screenshot was uploaded, or the page really was
        // observed), so the reason it was closed no longer describes this run.
        patch(id, { stage: "ready", email: payload.data, editedEmail: null, emailBlocked: null });
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
        // Carried on every write that sends an audit. Omitting it lets the
        // records route infer "complete" from the audit's mere presence, which
        // silently promotes a degraded run to a fully analysed one.
        auditStatus: item.auditStatus,
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
            // The credits this spends belong to this funnel's total.
            url: item.url,
            // Gives the researcher the page's own words to anchor on.
            headline: item.audit?.headline ?? null,
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
          search: OwnerSearch | null;
        }>;

        if (!mountedRef.current) return;
        if (!payload.ok || !payload.data) {
          patch(id, { enriching: false, notice: payload.error?.message ?? "The contact lookup failed." });
          return;
        }

        const { identity, note, profiles, search } = payload.data;
        patch(id, {
          enriching: false,
          identity,
          notice: note,
          // A search returns profiles; a lookup does not, and must not wipe them.
          ...(profiles.length > 0 ? { rocketReachProfiles: profiles } : {}),
          ...(search ? { ownerSearch: search } : {}),
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
  /**
   * Approves one address, and persists it.
   *
   * The write is what matters: approval used to live only here, so it was
   * gone the moment the component unmounted. State is updated optimistically
   * and reconciled with whatever the server says.
   */
  const approveEmail = useCallback(
    async (id: string, address: string | null) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item) return;

      const optimistic = (item.contacts ?? []).map((entry) => ({
        ...entry,
        approved: address !== null && entry.address.toLowerCase() === address.toLowerCase(),
      }));
      patch(id, { approvedEmail: address, contacts: optimistic });

      try {
        const response = await fetch("/api/records", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: item.url, approveEmail: address }),
        });
        const payload = (await response.json()) as ApiEnvelope<{
          approved: string | null;
          contacts: ContactCandidate[];
        }>;
        if (!mountedRef.current) return;

        if (!payload.ok || !payload.data) {
          patch(id, { notice: payload.error?.message ?? "Could not save that approval." });
          return;
        }
        // The server's list is authoritative — it may have added an address
        // the operator typed that no provider had proposed.
        patch(id, { approvedEmail: payload.data.approved, contacts: payload.data.contacts, notice: null });
      } catch {
        if (mountedRef.current) patch(id, { notice: "Could not reach the server to save that approval." });
      }
    },
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
          auditStatus: item.auditStatus,
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

  /** Re-queues a failed run. */
  const retry = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item) return;
      patch(id, { stage: "queued", error: null, notice: null });
    },
    [patch],
  );

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
