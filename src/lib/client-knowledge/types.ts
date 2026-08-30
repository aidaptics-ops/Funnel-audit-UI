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
};
