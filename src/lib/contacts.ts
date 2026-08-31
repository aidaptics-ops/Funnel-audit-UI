/**
 * The candidate addresses for one funnel.
 *
 * Kept as its own small model because approval is a separate decision from
 * discovery, taken later and often on a different page. Holding these only in
 * component state is what made a finished run disappear when the operator
 * navigated away — so this shape is what gets written to and read back from
 * the spreadsheet.
 */

export interface ContactCandidate {
  address: string;
  /** Which provider produced it: Hunter, RocketReach, web research, … */
  source: string;
  /** NeverBounce's verdict, or null when it was never checked. */
  verification: string | null;
  /** Exactly one candidate may be approved at a time. */
  approved: boolean;
}

/** Compact enough for a spreadsheet cell, explicit enough to read by eye. */
export function serializeContacts(candidates: ContactCandidate[]): string {
  if (candidates.length === 0) return "";
  return JSON.stringify(
    candidates.map((entry) => ({
      a: entry.address,
      s: entry.source,
      v: entry.verification,
      ...(entry.approved ? { ok: 1 } : {}),
    })),
  );
}

export function parseContacts(raw: string): ContactCandidate[] {
  if (!raw || !raw.trim().startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw) as { a?: unknown; s?: unknown; v?: unknown; ok?: unknown }[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => ({
        address: typeof entry.a === "string" ? entry.a : "",
        source: typeof entry.s === "string" ? entry.s : "unknown",
        verification: typeof entry.v === "string" ? entry.v : null,
        approved: entry.ok === 1,
      }))
      .filter((entry) => entry.address.length > 0);
  } catch {
    // A hand-edited or truncated cell must not break the history page.
    return [];
  }
}

/**
 * Marks one address approved and every other one not.
 *
 * Approval designates which address the outreach will use, so it is exclusive
 * — but the others are kept rather than discarded, because the operator is
 * allowed to change their mind later.
 */
export function approveOne(candidates: ContactCandidate[], address: string): ContactCandidate[] {
  const target = address.trim().toLowerCase();
  const known = candidates.some((entry) => entry.address.toLowerCase() === target);

  const updated = candidates.map((entry) => ({
    ...entry,
    approved: entry.address.toLowerCase() === target,
  }));

  // An address typed by the operator is a legitimate choice even if no
  // provider proposed it.
  if (!known && target) {
    updated.push({ address: target, source: "entered by the operator", verification: null, approved: true });
  }
  return updated;
}

/** Clears every approval, leaving the candidates in place. */
export function clearApproval(candidates: ContactCandidate[]): ContactCandidate[] {
  return candidates.map((entry) => ({ ...entry, approved: false }));
}

export function approvedAddress(candidates: ContactCandidate[]): string | null {
  return candidates.find((entry) => entry.approved)?.address ?? null;
}
