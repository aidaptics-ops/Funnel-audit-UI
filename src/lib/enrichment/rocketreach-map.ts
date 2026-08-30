import { looksLikePersonName, parsePersonName } from "../identity/patterns";
import type { Confidence, EmailCandidate, PersonCandidate } from "../identity/types";
import { OWNER_SCORE_BAR, scoreOwner } from "./owner-score";

/**
 * Turning RocketReach payloads into candidates.
 *
 * RocketReach splits cleanly into a free half and an expensive one, and this
 * app leans on that split:
 *
 *   search  — names, titles and LinkedIn URLs, no contact info, no credits.
 *   lookup  — the email addresses, one profile at a time, one credit each.
 *
 * So search runs freely and contributes *names*, which is what corroborates
 * the site's own copy. Lookup is only ever an explicit human decision.
 *
 * Pure and free of "server-only" so the judgement calls stay testable.
 */

/* -------------------------------- search --------------------------------- */

export interface RrSearchResponse {
  pagination?: { start?: number; next?: number; total?: number };
  profiles?: {
    id?: number;
    name?: string | null;
    current_title?: string | null;
    current_employer?: string | null;
    linkedin_url?: string | null;
    location?: string | null;
  }[];
}

/** A person RocketReach knows about, before we have paid for their address. */
export interface RrProfile {
  id: number;
  fullName: string;
  title: string | null;
  employer: string | null;
  linkedinUrl: string | null;
  /** How owner-like the title is. Decides who is worth a paid lookup. */
  ownerScore: number;
  ownerRationale: string;
}

/** True when at least one profile looks like the person who owns the business. */
export function hasOwnerCandidate(profiles: RrProfile[]): boolean {
  return profiles.some((profile) => profile.ownerScore >= OWNER_SCORE_BAR);
}

export function mapSearch(body: RrSearchResponse, domain: string): {
  profiles: RrProfile[];
  people: PersonCandidate[];
} {
  const profiles: RrProfile[] = [];
  const people: PersonCandidate[] = [];

  for (const entry of body.profiles ?? []) {
    const name = (entry.name ?? "").trim();
    if (!entry.id || !name || !looksLikePersonName(name)) continue;
    const parsed = parsePersonName(name);
    if (!parsed) continue;

    const score = scoreOwner({ title: entry.current_title ?? null });

    profiles.push({
      id: entry.id,
      fullName: parsed.fullName,
      title: entry.current_title ?? null,
      employer: entry.current_employer ?? null,
      linkedinUrl: entry.linkedin_url ?? null,
      ownerScore: score.score,
      ownerRationale: score.rationale,
    });

    people.push({
      ...parsed,
      role: entry.current_title ?? null,
      source: "enrichment_provider",
      // One provider is one source, whatever its own confidence. It reaches
      // "high" only by agreeing with something found on the site itself.
      confidence: "medium",
      evidence: `RocketReach: ${parsed.fullName}${entry.current_title ? ` — ${entry.current_title}` : ""}${
        entry.current_employer ? ` at ${entry.current_employer}` : ""
      } · ${score.rationale}`,
      foundOn: `rocketreach.co search:${domain}`,
    });
  }

  // Owner-shaped titles first: with three lookups a month, the operator should
  // be looking at the founder, not whoever the API happened to return first.
  profiles.sort((left, right) => right.ownerScore - left.ownerScore);
  people.sort(
    (left, right) =>
      scoreOwner({ title: right.role }).score - scoreOwner({ title: left.role }).score,
  );

  return { profiles, people };
}

/* -------------------------------- lookup --------------------------------- */

export interface RrLookupResponse {
  id?: number;
  status?: string;
  name?: string | null;
  current_title?: string | null;
  current_employer?: string | null;
  linkedin_url?: string | null;
  emails?: {
    email?: string;
    smtp_valid?: string | null;
    type?: string | null;
    grade?: string | null;
    last_validation_check?: string | null;
  }[];
}

export interface RrLookup {
  /** "complete" means the addresses are final; anything else is still working. */
  status: string;
  complete: boolean;
  person: PersonCandidate | null;
  emails: EmailCandidate[];
  cached: boolean;
  cachedAt: string | null;
}

export function mapLookup(body: RrLookupResponse, domain: string): RrLookup {
  const foundOn = `rocketreach.co lookup:${body.id ?? "?"}`;
  const status = body.status ?? "unknown";
  const emails: EmailCandidate[] = [];

  for (const entry of body.emails ?? []) {
    const address = entry.email?.toLowerCase().trim();
    if (!address) continue;

    const type = (entry.type ?? "").toLowerCase();
    // A disposable address is not a lead — it is a burner. Drop it entirely
    // rather than letting a human waste a decision on it.
    if (type === "disposable") continue;

    const smtp = (entry.smtp_valid ?? "").toLowerCase();
    const grade = (entry.grade ?? "").toUpperCase();

    emails.push({
      address,
      kind: type === "role-based" ? "generic_inbox" : type ? "personal" : "unknown",
      source: "enrichment_provider",
      confidence: emailConfidence(smtp, grade),
      // RocketReach never says where it saw an address, so "observed" has to
      // mean "independently checked": the mailbox answered, or the grade is
      // high enough that RocketReach is not merely guessing a pattern.
      observed: smtp === "valid" || /^[AB]/.test(grade),
      evidence: describe(type, smtp, grade, entry.last_validation_check ?? null),
      foundOn,
    });
  }

  const name = (body.name ?? "").trim();
  const parsed = name && looksLikePersonName(name) ? parsePersonName(name) : null;

  return {
    status,
    complete: status === "complete",
    person: parsed
      ? {
          ...parsed,
          role: body.current_title ?? null,
          source: "enrichment_provider",
          confidence: "medium",
          evidence: `RocketReach: ${parsed.fullName}${body.current_title ? ` — ${body.current_title}` : ""}`,
          foundOn: `rocketreach.co lookup:${domain}`,
        }
      : null,
    emails,
    cached: false,
    cachedAt: null,
  };
}

/**
 * RocketReach grades A-F and SMTP-checks separately. Only an address whose
 * mailbox actually answered AND that grades well is treated as strong; an
 * "accept-all" domain answers for every address, so it proves nothing.
 */
function emailConfidence(smtp: string, grade: string): Confidence {
  if (smtp === "invalid") return "low";
  if (smtp === "valid" && /^A/.test(grade)) return "high";
  if (smtp === "valid") return "medium";
  if (/^[AB]/.test(grade)) return "medium";
  return "low";
}

function describe(type: string, smtp: string, grade: string, checked: string | null): string {
  const parts = ["RocketReach"];
  if (grade) parts.push(`grade ${grade}`);
  if (type) parts.push(type);
  parts.push(smtp ? `SMTP ${smtp}` : "not SMTP-checked");
  if (checked) parts.push(`checked ${checked.slice(0, 10)}`);
  return parts.join(" · ");
}
