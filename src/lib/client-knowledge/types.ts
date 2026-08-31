/**
 * The client's historical emails, and the profile derived from them.
 *
 * These emails are NOT a bug database. They teach two things:
 *   1. how this specific person writes;
 *   2. what this person tends to notice and consider worth raising.
 * Evidence for any given new funnel always comes from that funnel's audit.
 */

export interface ClientEmail {
  id: string;
  /** Optional subject line if the source had one. */
  subject: string | null;
  body: string;
  /** "paste" | "txt" | "csv" — where it came from, for the UI only. */
  source: string;
  addedAt: string;
  /** Free-form label, e.g. a campaign name. */
  tag: string | null;
}

export interface WritingProfile {
  tone: string | null;
  vocabulary: string | null;
  sentence_style: string | null;
  pacing: string | null;
  greeting_style: string | null;
  cta_style: string | null;
  sign_off_style: string | null;
  common_phrases: string[];
  avoided_phrases: string[];
  uses_emojis: boolean | null;
  uses_bullets: boolean | null;
}

export interface DiagnosticProfile {
  /** The kinds of problems this client tends to notice and mention. */
  issues_noticed: string[];
  /** How they frame an observation when they raise it. */
  framing: string | null;
  /** Which observations they treat as commercially meaningful. */
  commercially_meaningful: string[];
  /** How they connect an issue to business impact. */
  issue_to_impact: string | null;
  /** How they move from an observation into the ask. */
  observation_to_offer: string | null;
  /**
   * The internal shape of ONE observation, slot by slot.
   *
   * "Framing" describes the stance; this describes the machine: name the
   * thing, say what it costs, give the fix, say why the fix works. It is what
   * makes a generated observation read like his rather than like a summary.
   */
  observation_structure: string | null;
  /** How blunt they are, and where they soften. */
  directness: string | null;
  /**
   * How they raise stages they could not have fully seen.
   *
   * The audit stops at the landing page, so this is the habit that has to be
   * imitated most carefully: which downstream claims they make, and how they
   * phrase them so that they are recommendations rather than assertions about
   * a page they never opened.
   */
  downstream_reasoning: string | null;
}

export interface ClientProfile {
  version: number;
  generatedAt: string;
  /** How many emails the profile was derived from. */
  sampleCount: number;
  /** Which provider produced it, so a mock-derived profile is obvious. */
  generatedBy: string;
  writing: WritingProfile;
  diagnostic: DiagnosticProfile;
  notes: string[];
}

export interface KnowledgeSnapshot {
  emails: ClientEmail[];
  profile: ClientProfile | null;
  /**
   * Seeded samples the operator deleted on purpose.
   *
   * The committed seed library is merged into the store on every read, so that
   * new samples added to the repo reach a deployment that has already written
   * to its own store. Without a record of deliberate deletions, that merge
   * would resurrect anything removed through the UI on the very next request.
   */
  dismissedSeedIds?: string[];
}

export const EMPTY_WRITING: WritingProfile = {
  tone: null,
  vocabulary: null,
  sentence_style: null,
  pacing: null,
  greeting_style: null,
  cta_style: null,
  sign_off_style: null,
  common_phrases: [],
  avoided_phrases: [],
  uses_emojis: null,
  uses_bullets: null,
};

export const EMPTY_DIAGNOSTIC: DiagnosticProfile = {
  issues_noticed: [],
  framing: null,
  commercially_meaningful: [],
  issue_to_impact: null,
  observation_to_offer: null,
  observation_structure: null,
  directness: null,
  downstream_reasoning: null,
};
