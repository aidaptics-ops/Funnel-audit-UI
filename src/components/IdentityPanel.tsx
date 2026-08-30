"use client";

import { useState, type ReactNode } from "react";
import type { IdentityResult } from "@/lib/identity/types";
import type { EnrichProvider, RocketReachProfile } from "@/lib/types";
import { Button, Card, Field, Notice } from "./ui";

/**
 * Who the funnel belongs to, and how sure we are.
 *
 * The important state here is the unhappy one: when nothing cleared the bar,
 * this panel says so plainly and offers a confirm box, rather than quietly
 * letting a guess reach the greeting.
 */
export function IdentityPanel({
  identity,
  onConfirm,
  onEnrich,
  onApproveEmail,
  onRejectEmail,
  approvedEmail = null,
  profiles = [],
  busy,
  enriching = false,
  hunter,
  rocketreach,
}: {
  identity: IdentityResult;
  onConfirm: (name: string, email: string | null) => void;
  onEnrich?: (provider: EnrichProvider, profileId?: number) => void;
  onApproveEmail?: (address: string) => void;
  onRejectEmail?: (address: string) => void;
  approvedEmail?: string | null;
  profiles?: RocketReachProfile[];
  busy: boolean;
  enriching?: boolean;
  hunter?: { configured: boolean; creditsRemaining: number | null } | null;
  rocketreach?: { configured: boolean; lookupsRemaining: number | null } | null;
}) {
  const [name, setName] = useState(identity.owner?.fullName ?? "");
  const [email, setEmail] = useState(identity.ownerEmail?.address ?? "");

  const confirmed = identity.owner?.confidence === "confirmed";

  return (
    <Card
      title="Business owner"
      subtitle={
        identity.pagesChecked.length > 0
          ? `Checked: ${identity.pagesChecked.map(shorten).join(" · ")}`
          : "Only the landing page was available."
      }
    >
      <div className="mb-4">
        <Notice tone={identity.safeToAddressByName ? "success" : "warn"}>{identity.reason}</Notice>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field label="Brand" value={identity.company.brand} />
        <Field label="Legal entity" value={identity.company.legalEntity} />
        <Field label="Domain" value={identity.company.domain} mono />
        <Field
          label="Owner"
          value={
            identity.owner ? (
              <span>
                {identity.owner.fullName}
                {identity.owner.role ? ` · ${identity.owner.role}` : ""}{" "}
                <span className="text-ink-subtle">({identity.owner.confidence})</span>
              </span>
            ) : null
          }
        />
        <Field label="Owner email" value={identity.ownerEmail?.address ?? null} mono />
        <Field
          label="Greeting"
          value={
            identity.safeToAddressByName && identity.owner
              ? `"Hey ${identity.owner.firstName},"`
              : '"Hey —" (no name)'
          }
        />
      </dl>

      <ContactChoice
        identity={identity}
        approvedEmail={approvedEmail}
        onApprove={onApproveEmail}
        onReject={onRejectEmail}
        busy={busy}
      />

      {onEnrich && (
        <Lookups
          onEnrich={onEnrich}
          busy={busy || enriching}
          enriching={enriching}
          hunter={hunter}
          rocketreach={rocketreach}
          profiles={profiles}
          knownNames={identity.people.map((person) => person.fullName.toLowerCase())}
        />
      )}

      {identity.people.length > 0 && (
        <div className="mt-4 border-t border-line pt-3.5">
          <SectionLabel>Name candidates</SectionLabel>
          <ul className="mt-2 space-y-2">
            {identity.people.map((person, index) => (
              <li key={`${person.fullName}-${index}`} className="text-[13px]">
                <span className="font-medium text-ink">{person.fullName}</span>{" "}
                <span className="text-ink-subtle">
                  {person.confidence} · {person.source.replace(/_/g, " ")}
                </span>
                <p className="mt-0.5 line-clamp-2 font-mono text-xs text-ink-subtle">{person.evidence}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {identity.emails.length > 0 && (
        <div className="mt-4 border-t border-line pt-3.5">
          <SectionLabel>All addresses found</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {identity.emails.map((entry) => (
              <li key={entry.address} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-mono text-xs text-ink">{entry.address}</span>
                <Tag tone={entry.kind === "personal" ? "ok" : entry.kind === "generic_inbox" ? "muted" : "warn"}>
                  {entry.kind.replace(/_/g, " ")}
                </Tag>
                {!entry.observed && <Tag tone="warn">unverified guess</Tag>}
                {onApproveEmail && entry.address !== approvedEmail && (
                  <button
                    type="button"
                    onClick={() => onApproveEmail(entry.address)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    use this
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 border-t border-line pt-3.5">
        <SectionLabel>{confirmed ? "Confirmed owner" : "Confirm the owner"}</SectionLabel>
        <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
          Nothing is guessed. Type the owner&apos;s name to let the email address them personally.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Full name"
            className="min-w-[10rem] flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
          />
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email (optional)"
            className="min-w-[12rem] flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          />
          <Button onClick={() => onConfirm(name.trim(), email.trim() || null)} disabled={busy || name.trim() === ""}>
            Confirm &amp; rewrite
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * The contact address, as a decision rather than a result.
 *
 * The owner's own address is what we want and is offered first. When there
 * isn't one, a working business address is offered instead — clearly labelled
 * as second choice, because reaching info@ is still reaching the business, and
 * throwing it away would lose a usable lead. Neither is ever assumed: nothing
 * reaches the spreadsheet until someone accepts it here.
 */
function ContactChoice({
  identity,
  approvedEmail,
  onApprove,
  onReject,
  busy,
}: {
  identity: IdentityResult;
  approvedEmail: string | null;
  onApprove?: (address: string) => void;
  onReject?: (address: string) => void;
  busy: boolean;
}) {
  if (!onApprove || !onReject) return null;

  const owner = identity.ownerEmail;
  const proposed = owner ?? identity.fallbackEmail;
  const accepted = approvedEmail !== null && approvedEmail === proposed?.address;

  return (
    <div className="mt-4 border-t border-line pt-3.5">
      <SectionLabel>Contact address</SectionLabel>

      {!proposed && (
        <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
          No usable address yet. Addresses a provider guessed from a naming pattern are never proposed — those are
          the ones that bounce — but anything actually seen is listed below.
        </p>
      )}

      {proposed && (
        <div
          className={`mt-2 rounded-lg border p-3.5 ${
            accepted ? "border-done/40 bg-done-soft" : "border-line-strong bg-surface-sunken"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-medium text-ink">{proposed.address}</span>
            <Tag tone={owner ? "ok" : "warn"}>
              {owner ? "owner · personal" : `fallback · ${proposed.kind.replace(/_/g, " ")}`}
            </Tag>
            {accepted && <Tag tone="ok">approved</Tag>}
          </div>

          <p className="mt-1.5 font-mono text-xs text-ink-subtle">{proposed.evidence}</p>

          {!owner && (
            <p className="mt-1.5 text-xs text-ink-muted">
              This reaches the business, but it is not the owner&apos;s personal address.
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onApprove(proposed.address)} disabled={busy || accepted}>
              {accepted ? "Approved" : "Approve"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onReject(proposed.address)} disabled={busy}>
              Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Paid lookups, priced in the button.
 *
 * Nobody should have to remember which provider charges for what, so each
 * action states its own cost and the remaining balance sits beside it.
 */
function Lookups({
  onEnrich,
  busy,
  enriching,
  hunter,
  rocketreach,
  profiles,
  knownNames,
}: {
  onEnrich: (provider: EnrichProvider, profileId?: number) => void;
  busy: boolean;
  enriching: boolean;
  hunter?: { configured: boolean; creditsRemaining: number | null } | null;
  rocketreach?: { configured: boolean; lookupsRemaining: number | null } | null;
  profiles: RocketReachProfile[];
  knownNames: string[];
}) {
  if (!hunter?.configured && !rocketreach?.configured) return null;
  const lookupsLeft = rocketreach?.lookupsRemaining ?? 0;

  return (
    <div className="mt-4 border-t border-line pt-3.5">
      <SectionLabel>Find the owner</SectionLabel>
      <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
        The site&apos;s own pages were already checked for free. These go further.
      </p>

      <div className="mt-2.5 flex flex-wrap gap-2">
        {rocketreach?.configured && (
          <Button size="sm" variant="secondary" onClick={() => onEnrich("rocketreach_search")} disabled={busy}>
            {enriching ? "Working…" : "Find names · free"}
          </Button>
        )}
        {hunter?.configured && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onEnrich("hunter")}
            disabled={busy || hunter.creditsRemaining === 0}
          >
            Search addresses · 1 Hunter credit
            {hunter.creditsRemaining !== null ? ` (${hunter.creditsRemaining} left)` : ""}
          </Button>
        )}
      </div>

      {profiles.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-surface-sunken p-3">
          <p className="text-xs font-medium text-ink">
            {profiles.length} {profiles.length === 1 ? "person" : "people"} found at this company
          </p>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Names are free. Fetching one person&apos;s address costs 1 of {lookupsLeft} remaining lookups.
          </p>
          <ul className="mt-2.5 space-y-2">
            {profiles.map((profile) => (
              <li key={profile.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-[13px]">
                  <span className="font-medium text-ink">{profile.fullName}</span>
                  {profile.title && <span className="text-ink-subtle"> · {profile.title}</span>}
                  {knownNames.includes(profile.fullName.toLowerCase()) && (
                    <span className="ml-1.5 text-xs text-done">matches the site</span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onEnrich("rocketreach_lookup", profile.id)}
                  disabled={busy || lookupsLeft <= 0}
                  title={lookupsLeft <= 0 ? "No RocketReach lookups remaining this month" : undefined}
                >
                  Get address · 1 lookup
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">{children}</p>;
}

function Tag({ tone, children }: { tone: "ok" | "warn" | "muted"; children: ReactNode }) {
  const styles = {
    ok: "bg-done-soft text-done",
    warn: "bg-review-soft text-review",
    muted: "bg-surface-sunken text-ink-subtle ring-1 ring-line",
  }[tone];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles}`}>
      {children}
    </span>
  );
}

/** Page URLs and provider notes both land in pagesChecked; keep them short. */
function shorten(entry: string): string {
  if (!entry.startsWith("http")) return entry;
  try {
    return new URL(entry).pathname || "/";
  } catch {
    return entry;
  }
}
