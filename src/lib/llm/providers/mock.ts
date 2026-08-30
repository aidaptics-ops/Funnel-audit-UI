import type { LlmProvider, LlmRequest, LlmResponse } from "../types";

/**
 * The default provider until a real model is chosen.
 *
 * It is deliberately NOT a lorem-ipsum stub: it reads the structured context
 * the prompt builder passes in and assembles a realistic, evidence-only email
 * from it. That means the whole pipeline — context building, JSON parsing,
 * validation, the review UI — is exercised for real, and swapping in a model
 * changes the prose, not the plumbing.
 *
 * It can only ever repeat facts that were given to it, so it cannot invent a
 * claim. That property is what makes it a safe development default.
 */
export class MockLlmProvider implements LlmProvider {
  readonly id = "mock";
  readonly label = "Mock (no model configured)";

  isConfigured(): boolean {
    return true;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const prompt = request.messages.map((message) => message.content).join("\n\n");

    if (request.jsonSchemaName === "client_profile") {
      return { text: JSON.stringify(mockProfile(prompt)), model: "mock" };
    }
    return { text: JSON.stringify(mockEmail(prompt)), model: "mock" };
  }
}

/* --------------------------- context scraping ---------------------------- */
/** The prompt is built by us, so these markers are stable. */
function field(prompt: string, label: string): string | null {
  const match = prompt.match(new RegExp(`^- ${escape(label)}: (.+)$`, "mi"));
  const value = match?.[1]?.trim();
  return value && value !== "not detected" && value !== "unknown" ? value : null;
}

function section(prompt: string, heading: string): string[] {
  const start = prompt.indexOf(heading);
  if (start === -1) return [];
  // Skip the rest of the heading LINE, or a parenthetical in the heading
  // ("PRIORITISED OBSERVATIONS (choose ONE or TWO)") is read as content.
  const bodyStart = prompt.indexOf("\n", start);
  if (bodyStart === -1) return [];
  const rest = prompt.slice(bodyStart + 1);
  const end = rest.search(/\n[A-Z][A-Z \-/&()]{4,}\n/);
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter((line) => line.length > 3);
}

/** The numbered observation titles only — no severity tags, no detail lines. */
function observations(prompt: string): string[] {
  const start = prompt.indexOf("PRIORITISED OBSERVATIONS");
  if (start === -1) return [];
  const rest = prompt.slice(start);
  const end = rest.indexOf("\nOBSERVED EVIDENCE");
  const block = end === -1 ? rest : rest.slice(0, end);

  return block
    .split("\n")
    .map((line) => line.match(/^\s*\d+\.\s+(.+?)\s*(?:\[[a-z]+\])?\s*$/i)?.[1])
    .filter((title): title is string => Boolean(title && title.length > 3));
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mockEmail(prompt: string): Record<string, unknown> {
  const brand = field(prompt, "Brand") ?? field(prompt, "Domain") ?? "your page";
  const funnelType = field(prompt, "Funnel type") ?? "page";
  const headline = field(prompt, "Headline");
  const greeting = titleCase(field(prompt, "Greeting style") ?? "Hey");
  const signOff = titleCase(field(prompt, "Sign-off style") ?? "Best");
  const converted = /Operator personally completed[^\n]*YES/i.test(prompt);
  // Only ever the name the prompt explicitly authorised — never derived.
  const recipient = field(prompt, "Address them as");

  const findings = observations(prompt).slice(0, 2);
  const primary = findings[0] ?? "a couple of things on the page";
  const secondary = findings[1] ?? null;

  // Mirrors the skeleton the samples use, with the observations left as the
  // only variable content. A real model writes the prose; this proves the shape.
  const opener = recipient ? `${greeting} ${recipient},` : `${greeting} —`;
  const lines = [
    converted
      ? `${opener} I just went through your ${funnelType} and noticed a couple of things.`
      : `${opener} I was going through your ${funnelType} and noticed a couple of things.`,
    "",
  ];

  if (headline) {
    lines.push(`Your page opens with "${truncate(headline, 90)}", so the promise lands early.`, "");
  }

  lines.push(`The first thing I noticed is ${lower(primary)}.`, "");

  if (secondary) {
    lines.push(`The second thing I noticed is ${lower(secondary)}.`, "");
  }

  lines.push(
    "There's another few low hanging fruits I spotted stunting your conversions, I'm happy to break it down even further in a short loom audit.",
    "",
    signOff + ",",
  );

  return {
    subject: `Quick note on ${brand}`,
    email: lines.join("\n"),
    angle: `Led with the highest-weight audit finding (${truncate(primary, 70)}) and kept it to ${
      secondary ? "two observations" : "one observation"
    }, following the client's usual two-observation skeleton.`,
    personalization_points: [primary, secondary].filter(Boolean),
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function mockProfile(prompt: string): Record<string, unknown> {
  const emails = section(prompt, "EMAIL SAMPLES");
  const body = emails.join(" ");
  const sentences = body.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgWords = sentences.length
    ? Math.round(sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length)
    : 0;

  const greetings = collect(body, /\b(hey|hi|hello|good morning|morning)\b/gi);
  const signOffs = collect(body, /\b(cheers|thanks|best|regards|talk soon|speak soon)\b/gi);

  return {
    writing: {
      tone: avgWords > 0 && avgWords < 14 ? "direct and conversational" : "conversational",
      vocabulary: "plain business English, few adjectives",
      sentence_style: avgWords ? `mostly short sentences (~${avgWords} words)` : "unknown",
      pacing: "short paragraphs, one idea each",
      greeting_style: greetings[0] ?? "unknown",
      cta_style: /\?\s*$/m.test(body) ? "closes with a question rather than a hard ask" : "unknown",
      sign_off_style: signOffs[0] ?? "unknown",
      common_phrases: uniqueTop(body, 6),
      avoided_phrases: ["guarantee", "revolutionary", "10x", "skyrocket"],
      uses_emojis: /[\u{1F300}-\u{1FAFF}]/u.test(body),
      uses_bullets: /^\s*[-*•]/m.test(body),
    },
    diagnostic: {
      issues_noticed: derivedIssues(body),
      framing: "states the observation plainly, then what it likely costs in practice",
      commercially_meaningful: ["offer clarity", "conversion friction", "what happens after the form"],
      issue_to_impact: "links the observation to a concrete visitor experience, not to a made-up number",
      observation_to_offer: "ends with a small, low-commitment question",
    },
    notes: [
      "Derived by the mock provider from simple text statistics.",
      "Configure a real LLM_PROVIDER for a genuine style analysis.",
    ],
  };
}

function derivedIssues(body: string): string[] {
  const checks: [RegExp, string][] = [
    [/\bconfirmation|thank[- ]you|after (they|you) book/i, "unclear next steps after booking"],
    [/\bcalendly|booking|calendar/i, "booking flow friction"],
    [/\bheadline|above the fold|hero/i, "weak or unclear headline"],
    [/\btestimonial|proof|case stud/i, "missing social proof"],
    [/\bcta|button|call to action/i, "CTA problems"],
    [/\bform|fields?\b/i, "form friction"],
    [/\bpixel|tracking|analytics/i, "tracking gaps"],
  ];
  const found = checks.filter(([pattern]) => pattern.test(body)).map(([, label]) => label);
  return found.length ? found : ["not enough samples to infer patterns"];
}

function collect(text: string, pattern: RegExp): string[] {
  return [...new Set((text.match(pattern) ?? []).map((value) => value.toLowerCase()))];
}

function uniqueTop(text: string, limit: number): string[] {
  const stop = new Set(["the", "and", "you", "your", "that", "this", "with", "for", "was", "are", "have", "just", "but"]);
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/\b[a-z']{4,}\b/g) ?? []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function lower(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
