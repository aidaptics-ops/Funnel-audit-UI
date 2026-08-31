import "server-only";
import { getProvider } from "../llm/registry";
import { LlmError } from "../llm/types";
import { AppError } from "../errors";
import { saveProfile } from "./store";
import {
  EMPTY_DIAGNOSTIC,
  EMPTY_WRITING,
  type ClientEmail,
  type ClientProfile,
  type DiagnosticProfile,
  type WritingProfile,
} from "./types";

/**
 * Derives a reusable profile from the client's historical emails.
 *
 * Two distinct outputs, as the workflow requires:
 *   writing   — how this person sounds
 *   diagnostic — what this person notices, and how they turn it into outreach
 *
 * No embeddings, no vector store: a structured profile plus a handful of
 * verbatim examples is enough, and keeps the whole thing inspectable.
 */

const PROFILE_VERSION = 1;

/** Enough samples to be representative without blowing the context window. */
const MAX_SAMPLES = 25;
const MAX_SAMPLE_CHARS = 2200;

export async function buildClientProfile(emails: ClientEmail[]): Promise<ClientProfile> {
  if (emails.length === 0) {
    throw new AppError("invalid_body", "no emails to profile");
  }

  const samples = pickSamples(emails);
  const provider = getProvider();

  let parsed: unknown;
  try {
    const response = await provider.complete({
      jsonSchemaName: "client_profile",
      purpose: "Client voice profile",
      temperature: 0.2,
      messages: [
        { role: "system", content: PROFILE_SYSTEM },
        { role: "user", content: profilePrompt(samples) },
      ],
    });
    parsed = safeJson(response.text);
  } catch (error) {
    if (error instanceof LlmError && error.kind === "unavailable") {
      throw new AppError("llm_unavailable", error.message);
    }
    throw new AppError("llm_failed", error instanceof Error ? error.message : String(error));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new AppError("llm_bad_response", "profile response was not an object");
  }

  const record = parsed as Record<string, unknown>;
  const profile: ClientProfile = {
    version: PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    sampleCount: emails.length,
    generatedBy: provider.id,
    writing: coerceWriting(record.writing),
    diagnostic: coerceDiagnostic(record.diagnostic),
    notes: stringList(record.notes),
  };

  await saveProfile(profile);
  return profile;
}

/**
 * A spread of samples rather than the newest N: style is more reliably
 * captured across the whole library than from one recent batch.
 */
export function pickSamples(emails: ClientEmail[], limit = MAX_SAMPLES): ClientEmail[] {
  if (emails.length <= limit) return emails;
  const step = emails.length / limit;
  const picked: ClientEmail[] = [];
  for (let index = 0; index < limit; index += 1) {
    picked.push(emails[Math.floor(index * step)]!);
  }
  return picked;
}

const PROFILE_SYSTEM = `You analyse a sales professional's real outreach emails and produce a reusable profile of how they write and what they notice.

You are NOT writing an email. You are describing a person's habits, precisely and concretely, so another system can imitate them later.

Return ONLY a JSON object with exactly this shape:
{
  "writing": {
    "tone": string, "vocabulary": string, "sentence_style": string, "pacing": string,
    "greeting_style": string, "cta_style": string, "sign_off_style": string,
    "common_phrases": string[], "avoided_phrases": string[],
    "uses_emojis": boolean, "uses_bullets": boolean
  },
  "diagnostic": {
    "issues_noticed": string[], "framing": string,
    "commercially_meaningful": string[], "issue_to_impact": string,
    "observation_to_offer": string, "observation_structure": string,
    "directness": string, "downstream_reasoning": string
  },
  "notes": string[]
}

Rules:
- Describe only what the samples actually show. If something is not evident, say "not evident in the samples".
- "common_phrases" must be phrases that genuinely recur, quoted from the samples.
- "issues_noticed" is the kinds of funnel, landing-page, form and post-booking problems this person tends to point out. Include post-booking and confirmation-flow patterns when the samples show them.
- "observation_structure" is the slot-by-slot anatomy of ONE observation, in order, with the phrase they use to open each slot. Someone should be able to write a new observation from your description alone.
- "directness" is how bluntly they assert a problem, and the specific devices they use to soften it without weakening it.
- "downstream_reasoning" is how they raise stages of the funnel they could not have fully seen - which claims they are willing to make about a confirmation page, a follow-up or a call, and the exact grammar they use (absence, opportunity, recommendation) that keeps those from reading as guesses. Quote the constructions.
- Do not invent a persona. Do not flatter. Be specific and behavioural.`;

function profilePrompt(samples: ClientEmail[]): string {
  const blocks = samples.map((email, index) => {
    const subject = email.subject ? `Subject: ${email.subject}\n` : "";
    return `--- SAMPLE ${index + 1} ---\n${subject}${truncate(email.body, MAX_SAMPLE_CHARS)}`;
  });

  return [
    `You are given ${samples.length} real emails written by one person.`,
    "",
    "EMAIL SAMPLES",
    ...blocks,
    "",
    "Produce the JSON profile now.",
  ].join("\n");
}

/* ------------------------------- coercion -------------------------------- */

function coerceWriting(value: unknown): WritingProfile {
  if (!value || typeof value !== "object") return { ...EMPTY_WRITING };
  const record = value as Record<string, unknown>;
  return {
    tone: text(record.tone),
    vocabulary: text(record.vocabulary),
    sentence_style: text(record.sentence_style),
    pacing: text(record.pacing),
    greeting_style: text(record.greeting_style),
    cta_style: text(record.cta_style),
    sign_off_style: text(record.sign_off_style),
    common_phrases: stringList(record.common_phrases),
    avoided_phrases: stringList(record.avoided_phrases),
    uses_emojis: typeof record.uses_emojis === "boolean" ? record.uses_emojis : null,
    uses_bullets: typeof record.uses_bullets === "boolean" ? record.uses_bullets : null,
  };
}

function coerceDiagnostic(value: unknown): DiagnosticProfile {
  if (!value || typeof value !== "object") return { ...EMPTY_DIAGNOSTIC };
  const record = value as Record<string, unknown>;
  return {
    issues_noticed: stringList(record.issues_noticed),
    framing: text(record.framing),
    commercially_meaningful: stringList(record.commercially_meaningful),
    issue_to_impact: text(record.issue_to_impact),
    observation_to_offer: text(record.observation_to_offer),
    observation_structure: text(record.observation_structure),
    directness: text(record.directness),
    downstream_reasoning: text(record.downstream_reasoning),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Models wrap JSON in prose or fences often enough to be worth handling. */
export function safeJson(text: string): unknown {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
