import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { recordSpend } from "../cost/meter";
import { safeJson } from "../client-knowledge/profile";
import { stripLoneSurrogates, toLlmError } from "../llm/providers/anthropic";
import { looksLikePersonName, parsePersonName } from "../identity/patterns";
import { scoreOwner } from "../enrichment/owner-score";
import { retryOnceIf } from "../retry";

/**
 * Who runs this business, according to the open web.
 *
 * This is the step the providers cannot do. Hunter and RocketReach only know
 * what is in their index, and for the small coaching and agency funnels this
 * tool is aimed at the answer is usually "nothing". A search engine does know
 * — the founder's name is in a podcast bio, a press release, a LinkedIn
 * snippet, an "our story" page — it just isn't in a contact database.
 *
 * So the model searches, and is held to the same rule as everything else here:
 * a name is only worth having if it comes with a source. The prompt demands a
 * citation per claim, the schema has an explicit "not found" shape, and
 * anything that arrives without evidence is dropped on this side regardless of
 * how confident the model sounded.
 */

/** Opus 5 supports the filtering variant; older models take the basic one. */
const WEB_SEARCH_TOOL = "web_search_20260209";
/*
 * Six. It was cut to four to save tokens, and that was the wrong economy.
 *
 * Every search result does come back INTO the context, so this number drives
 * the input-token bill more than anything else in the run - 70-88k input
 * tokens against 10-11k for writing the email. But a live run on
 * section8mastery.io spent all four and said so in its own answer: "I've hit
 * the search tool limit for this turn." A domain whose brand name collides
 * with a video game needs more attempts, not fewer, and the run that gives up
 * early has spent its money and bought nothing.
 *
 * It is also free in wall-clock terms. This leg runs concurrently with the
 * two-page analysis and finished 15-48s AHEAD of it on both measured runs, so
 * the extra searches hide entirely behind a stage that was going to run
 * anyway. The saving was tokens only, and it cost findable founders.
 */
const MAX_SEARCHES = 6;

/**
 * How long to wait before the one rate-limit retry below.
 *
 * This call runs on the SAME Anthropic account as the two-page funnel
 * analysis, and /api/analyze now races them concurrently (route.ts) for
 * speed — the first time this codebase could put two expensive, high-effort
 * calls on one account in flight at the same moment. A few seconds is enough
 * for a transient per-second rate limit to clear without meaningfully
 * lengthening a run that was going to succeed anyway.
 */
const RATE_LIMIT_RETRY_DELAY_MS = 3_000;

export interface FounderEvidence {
  claim: string;
  source: string;
}

export interface FounderFinding {
  /** The trading name as the open web knows it. */
  companyName: string | null;
  founderName: string | null;
  founderTitle: string | null;
  /** Addresses the model actually saw published, never constructed. */
  emails: string[];
  linkedinUrl: string | null;
  /**
   * Other domains the same business trades under.
   *
   * Small operators run a funnel on one domain, a brand site on another, and
   * a personal site on a third. The founder's real mailbox is usually on the
   * personal or brand domain, not the ad funnel — so these are worth searching
   * even though the funnel domain is what we were handed.
   */
  relatedDomains: string[];
  /** The model's own confidence, kept separate from ours. */
  statedConfidence: "high" | "medium" | "low" | "none";
  evidence: FounderEvidence[];
  /** Why it failed, when it did. Shown to the operator verbatim. */
  reason: string;
  searchesUsed: number;
}

export interface FounderQuery {
  domain: string;
  /** Whatever the funnel and the providers already believe. */
  companyName?: string | null;
  legalEntity?: string | null;
  headline?: string | null;
  /** Names already found on the site, so the model can confirm or contradict. */
  knownNames?: string[];
}

const SYSTEM = `You identify who owns a small business, using web search, for a cold-outreach tool.

Getting this WRONG is worse than returning nothing. A wrong name produces an email addressed to a stranger, which is instantly recognisable as automated and burns the prospect. "I could not determine this" is a correct and useful answer.

METHOD
1. Establish the company's real trading name. The domain is often not the brand, and the brand is often not the legal entity.
2. Search for who founded or owns it. Useful shapes: "<company> founder", "<company> owner", "<company> about us", "<company> CEO", "<company> linkedin".
3. If, and only if, you have a confident founder name, search for a published email: "<company> <founder> email", "<founder> contact".

HARD RULES
- Every claim needs a source URL you actually retrieved. No source, no claim.
- NEVER construct an email address. Do not infer first@domain, firstlast@domain, or any other pattern, however obvious it looks. Report only addresses you SAW written down.
- Do not report a person from a DIFFERENT company with a similar name. Confirm the company matches the domain.
- A generic inbox (info@, support@, hello@) is not a founder's address. You may report it, but say what it is.
- If the business is anonymous — many advertising funnels deliberately are — say so and return nulls. This is common and expected.
- List every OTHER domain the same business runs in "relatedDomains" (brand site, personal site, sister funnels). Bare hostnames, no scheme or path. These are often where the owner's real mailbox lives.
- Prefer the company's own site, LinkedIn, Crunchbase, press coverage and podcast bios over aggregators and scraped directories.

OUTPUT
Return ONLY a JSON object, no prose around it:
{
  "companyName": string | null,
  "founderName": string | null,
  "founderTitle": string | null,
  "emails": string[],
  "linkedinUrl": string | null,
  "relatedDomains": string[],
  "statedConfidence": "high" | "medium" | "low" | "none",
  "evidence": [{ "claim": string, "source": string }],
  "reason": string
}
"founderTitle" is the job title ONLY, as written on the source (e.g. "Founder", "CEO", "Principal") — at most five words, no caveats. Put any doubt about the title in "reason" or "evidence" instead.
"reason" explains in one sentence what you found or why you could not. "evidence" must contain one entry per substantive claim, each with the URL that supports it.`;

export function isResearchConfigured(): boolean {
  return Boolean(config.llm.apiKey && config.llm.model);
}

export async function researchFounder(query: FounderQuery): Promise<FounderFinding> {
  if (!isResearchConfigured()) {
    return empty("No model is configured, so the web could not be searched.");
  }

  const client = new Anthropic({
    apiKey: config.llm.apiKey,
    timeout: config.llm.timeoutMs,
  });

  const context = [
    `Domain: ${query.domain}`,
    query.companyName ? `Company name from the page or a provider: ${query.companyName}` : null,
    query.legalEntity ? `Legal entity from the copyright line: ${query.legalEntity}` : null,
    query.headline ? `The funnel's headline: "${query.headline}"` : null,
    query.knownNames?.length
      ? `Names already found on the site (confirm or contradict these): ${query.knownNames.join(", ")}`
      : null,
    "",
    "Identify the company and who owns it. Return the JSON object described in your instructions.",
  ]
    .filter(Boolean)
    .join("\n");

  let message: Anthropic.Message;
  try {
    // One bounded retry, and only for an actual rate limit — never for an
    // auth failure, a bad request, or a refusal, which a retry cannot fix and
    // would only double the wait before the honest "no owner found" outcome.
    // Classified by SDK type (Anthropic.RateLimitError), not by matching text
    // in a message, so it survives the provider rewording its errors.
    message = await retryOnceIf(
      () =>
        client.messages
          .stream({
            model: config.llm.model,
            max_tokens: 8000,
            thinking: { type: "adaptive" },
            // Research rewards thoroughness and the whole call costs cents,
            // so this is one of the few places worth paying for maximum
            // effort.
            output_config: { effort: "high" },
            system: SYSTEM,
            tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: MAX_SEARCHES }],
            // Page headlines carry broken emoji often enough that an
            // unpaired surrogate here would fail the whole request as
            // invalid JSON.
            messages: [{ role: "user", content: stripLoneSurrogates(context) }],
          })
          .finalMessage(),
      (error) => error instanceof Anthropic.RateLimitError,
      RATE_LIMIT_RETRY_DELAY_MS,
    );
  } catch (error) {
    throw toLlmError(error);
  }

  /*
   * Searches are billed per REQUEST, not per content block.
   *
   * Each search leaves two blocks behind — the server_tool_use that asked and
   * the web_search_tool_result that answered — so counting blocks reports
   * double. The usage field is what Anthropic actually charges for; the block
   * count survives only as a fallback for a response that omits it.
   */
  const searchesUsed =
    message.usage.server_tool_use?.web_search_requests ??
    message.content.filter((block) => block.type === "server_tool_use").length;

  // Recorded before the refusal and parse checks below: a declined or
  // unreadable answer still consumed the searches and the tokens.
  recordSpend("anthropic", "Founder research (web search)", {
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_write_tokens: message.usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: message.usage.cache_read_input_tokens ?? 0,
    web_searches: searchesUsed,
  });

  if (message.stop_reason === "refusal") {
    return { ...empty("The model declined to research this domain."), searchesUsed };
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== "object") {
    return { ...empty("The research came back in a form that could not be read."), searchesUsed };
  }

  return { ...sanitise(parsed as Record<string, unknown>, query), searchesUsed };
}

/**
 * Trust nothing that arrives without a source.
 *
 * The model is instructed to cite, but instructions are not a guarantee. A
 * founder name with no evidence behind it is exactly the confident-sounding
 * guess this whole system exists to refuse, so it is dropped here rather than
 * being passed on with a caveat nobody reads.
 */
function sanitise(record: Record<string, unknown>, query: FounderQuery): FounderFinding {
  const evidence = readEvidence(record.evidence);
  const reason = typeof record.reason === "string" ? record.reason.slice(0, 400) : "";

  const rawName = typeof record.founderName === "string" ? record.founderName.trim() : "";
  const named = rawName && looksLikePersonName(rawName) ? parsePersonName(rawName) : null;

  // A name is only kept when something was cited. No citation, no name.
  const founderName = named && evidence.length > 0 ? named.fullName : null;

  return {
    companyName: cleanString(record.companyName),
    founderName,
    // Titles arrive with caveats attached surprisingly often ("Principal —
    // though 'founder' was not confirmed on a first-party page"). The caveat
    // belongs in the reason; the field itself has to stay short enough to sit
    // beside a name in the UI.
    founderTitle: shortTitle(record.founderTitle),
    // Only addresses on this domain or clearly attributed; never constructed.
    emails: readEmails(record.emails),
    linkedinUrl: readLinkedIn(record.linkedinUrl),
    relatedDomains: readDomains(record.relatedDomains, query.domain),
    statedConfidence: readConfidence(record.statedConfidence),
    evidence,
    reason:
      founderName || !rawName
        ? reason || describeOutcome(founderName, query.domain)
        : `A name was proposed without a source, so it was discarded. ${reason}`.trim(),
    searchesUsed: 0,
  };
}

function describeOutcome(founderName: string | null, domain: string): string {
  return founderName
    ? `Identified ${founderName} as the person behind ${domain}.`
    : `No owner could be established for ${domain} from public sources.`;
}

function readEvidence(value: unknown): FounderEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = entry as Record<string, unknown>;
      const claim = cleanString(record?.claim);
      const source = cleanString(record?.source);
      // A citation without a URL is not a citation.
      return claim && source && /^https?:\/\//i.test(source) ? { claim, source } : null;
    })
    .filter((entry): entry is FounderEvidence => entry !== null)
    .slice(0, 8);
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function readEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => EMAIL.test(entry)),
    ),
  ].slice(0, 6);
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function readDomains(value: unknown, exclude: string): string[] {
  if (!Array.isArray(value)) return [];
  const skip = exclude.toLowerCase().replace(/^www\./, "");
  return [
    ...new Set(
      value
        .map((entry) =>
          typeof entry === "string"
            ? entry.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? ""
            : "",
        )
        .filter((entry) => entry && entry !== skip && HOSTNAME.test(entry)),
    ),
  ].slice(0, 4);
}

function readLinkedIn(value: unknown): string | null {
  const url = cleanString(value);
  return url && /linkedin\.com\//i.test(url) ? url : null;
}

function readConfidence(value: unknown): FounderFinding["statedConfidence"] {
  return value === "high" || value === "medium" || value === "low" ? value : "none";
}

function shortTitle(value: unknown): string | null {
  const title = cleanString(value);
  if (!title) return null;
  const head = title.split(/[—–|;(]|\s-\s/)[0]?.trim() ?? title;
  const words = head.split(/\s+/).slice(0, 5).join(" ");
  return words.replace(/[,.]$/, "") || null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed.slice(0, 200) : null;
}

function empty(reason: string): FounderFinding {
  return {
    companyName: null,
    founderName: null,
    founderTitle: null,
    emails: [],
    linkedinUrl: null,
    relatedDomains: [],
    statedConfidence: "none",
    evidence: [],
    reason,
    searchesUsed: 0,
  };
}

/** How owner-like the researched title is, on the same scale as the providers. */
export function founderScore(finding: FounderFinding): number {
  return finding.founderName ? scoreOwner({ title: finding.founderTitle }).score : 0;
}
