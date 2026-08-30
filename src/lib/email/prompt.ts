import type { EmailContext } from "./context";

/**
 * Prompt construction. The field labels here are load-bearing: the mock
 * provider reads them back, and the validator's error messages refer to them.
 */

export const EMAIL_SYSTEM_PROMPT = `You write cold outreach emails as ONE specific person, using only what was actually observed on a prospect's page.

You will be given:
1. That person's writing profile and real past emails — this is HOW they sound and WHAT they tend to notice.
2. An automated audit of a NEW funnel — this is the ONLY evidence about this particular prospect.

Never mix these up. The past emails tell you what this person looks for and how they talk. They tell you NOTHING about whether this new funnel has those problems.

THE SHAPE OF THE EMAIL
Study the samples: they are one fixed skeleton with two original observations dropped into it.

  1. Greeting + why you were on the page
  2. "The first thing I noticed is ..." -> the observation -> the specific fix -> why the fix works
  3. "The second thing I noticed is ..." -> the observation -> the specific fix -> why the fix works
  4. The standing offer (more findings + free loom audit + the named clients who paid for it)
  5. Sign-off

Reuse the skeleton, the transitions and the closing offer - that wording is the client's signature and is meant to repeat.
NEVER reuse an observation, a diagnosis or an explanation from a sample. Those belong to another prospect's funnel. Yours must be written from THIS funnel's evidence.

HARD RULES
- Use only facts from the OBSERVED EVIDENCE section. If it is not there, you may not assert it.
- Never state the prospect's current performance as fact - no "your conversion rate is X", "you're losing X%", "this is costing you $X". The audit measures none of that.
- You MAY reference a likely improvement the way the client does, but only as a clearly-marked estimate ("I've seen this lift...", "I believe this is sitting around..."). Never as a measurement.
- Never assert anything about what happens AFTER a form is submitted or a call is booked. The audit never submitted a form and never booked anything. Raise that topic as an open question if you want to raise it at all.
- Do not claim you booked a call, bought the product or signed up unless the brief explicitly says the operator did.
- Never state the number of problems found in the audit. This is a note from a person, not a report.
- Do not lead with minor technical SEO housekeeping.

WHAT TO WRITE
- Pick the strongest ONE or TWO observations. Not three, not eight.
- For each one: name what you saw on the page, give the specific fix, and say why it works. The samples always do all three.
- Be concrete about THIS page - quote its headline, its button text, its form. That is what proves you looked.
- Sound like the person in the samples: same greeting, rhythm, sentence length, sign-off, level of formality.

OUTPUT
Return ONLY a JSON object:
{
  "subject": string,
  "email": string,
  "angle": string,
  "personalization_points": string[]
}
- "subject": the final subject line.
- "email": the complete body, with line breaks. No placeholders like [Name] unless a real name was provided.
- "angle": one or two sentences, for internal use, explaining why you chose this angle.
- "personalization_points": the specific observations you used, quoted from the evidence.`;

export function buildEmailPrompt(context: EmailContext): string {
  const { audit, profile, examples, observations, evidence, unobserved } = context;
  const parts: string[] = [];

  parts.push("CLIENT WRITING PROFILE");
  if (profile) {
    const writing = profile.writing;
    parts.push(
      `- Tone: ${writing.tone ?? "unknown"}`,
      `- Vocabulary: ${writing.vocabulary ?? "unknown"}`,
      `- Sentence style: ${writing.sentence_style ?? "unknown"}`,
      `- Pacing: ${writing.pacing ?? "unknown"}`,
      `- Greeting style: ${writing.greeting_style ?? "unknown"}`,
      `- CTA style: ${writing.cta_style ?? "unknown"}`,
      `- Sign-off style: ${writing.sign_off_style ?? "unknown"}`,
      `- Common phrases: ${list(writing.common_phrases)}`,
      `- Phrases they avoid: ${list(writing.avoided_phrases)}`,
      `- Uses emojis: ${writing.uses_emojis ?? "unknown"}`,
      `- Uses bullets: ${writing.uses_bullets ?? "unknown"}`,
    );
  } else {
    parts.push("- No profile has been generated yet. Infer the voice from the samples below.");
  }

  parts.push("", "CLIENT DIAGNOSTIC PATTERNS (what this person tends to notice, NOT facts about this funnel)");
  if (profile) {
    const diagnostic = profile.diagnostic;
    parts.push(
      `- Issues they typically notice: ${list(diagnostic.issues_noticed)}`,
      `- How they frame an issue: ${diagnostic.framing ?? "unknown"}`,
      `- What they treat as commercially meaningful: ${list(diagnostic.commercially_meaningful)}`,
      `- How they connect issue to impact: ${diagnostic.issue_to_impact ?? "unknown"}`,
      `- How they move from observation to offer: ${diagnostic.observation_to_offer ?? "unknown"}`,
      "- REMINDER: these are habits, not findings. Only raise one of these topics if the evidence below supports it.",
    );
  } else {
    parts.push("- Not available.");
  }

  if (examples.length > 0) {
    parts.push("", "EMAIL SAMPLES (imitate the voice, not the content)");
    examples.forEach((email, index) => {
      const subject = email.subject ? `Subject: ${email.subject}\n` : "";
      parts.push(`--- SAMPLE ${index + 1} ---`, `${subject}${truncate(email.body, 1500)}`);
    });
  }

  // The recipient block comes before the funnel so the greeting rule is the
  // first thing the model reads about this prospect.
  parts.push("", "THE RECIPIENT");
  const identity = context.identity;
  if (identity?.safeToAddressByName && identity.owner) {
    parts.push(
      `- Address them as: ${identity.owner.firstName}`,
      `- Full name: ${identity.owner.fullName}${identity.owner.role ? ` (${identity.owner.role})` : ""}`,
      `- How this was established: ${identity.reason}`,
      "- Open with their first name, the way the samples do.",
    );
  } else {
    parts.push(
      "- The owner's name is NOT known.",
      identity ? `- ${identity.reason}` : "- Identity resolution did not run.",
      "- Do NOT invent a name and do NOT guess one from the brand or domain.",
      "- Open without a name, e.g. \"Hey — I was going through your page…\".",
    );
  }
  if (identity?.company.brand) parts.push(`- Company: ${identity.company.brand}`);

  parts.push(
    "",
    "THE NEW FUNNEL",
    `- Operator personally completed this funnel's conversion action: ${
      context.operatorPerformedAction ? "YES - you may open the way the samples do" : "NO - do not claim you booked, bought or signed up"
    }`,
    `- URL: ${audit.finalUrl}`,
    `- Domain: ${audit.domain || "unknown"}`,
    `- Brand: ${audit.brand ?? "not detected"}`,
    `- Funnel type: ${audit.funnelType ?? "unknown"}`,
    `- Page type: ${audit.pageType ?? "unknown"}`,
    `- Conversion goal: ${audit.conversionGoal ?? "unknown"}`,
    `- Page title: ${audit.pageTitle ?? "not detected"}`,
    `- Headline: ${audit.headline ?? "not detected"}`,
    `- Subheadline: ${audit.subheadline ?? "not detected"}`,
    `- Value proposition clarity: ${audit.valueProposition.clarity ?? "unknown"}`,
    `- Primary CTA: ${audit.primaryCta ?? "not detected"}`,
  );

  parts.push("", "PRIORITISED OBSERVATIONS (choose ONE or TWO)");
  if (observations.length === 0) {
    parts.push(
      "- The audit found nothing of commercial significance. Write a short, genuine note based on the page copy instead, and do not manufacture a problem.",
    );
  } else {
    observations.forEach((issue, index) => {
      parts.push(
        `${index + 1}. ${issue.title} [${issue.severity}]`,
        `   what was seen: ${issue.description}`,
        `   evidence: ${issue.evidence.slice(0, 3).join(" | ")}`,
        issue.impact ? `   likely impact: ${issue.impact}` : "   likely impact: not stated",
      );
    });
  }

  parts.push("", "OBSERVED EVIDENCE (the complete set of facts you may assert)");
  for (const line of evidence.slice(0, 60)) parts.push(`- ${line}`);

  parts.push("", "NOT OBSERVED (you may not assert any of this)");
  for (const line of unobserved) parts.push(`- ${line}`);
  parts.push(
    "- No conversion rate, traffic level, revenue, ad spend or customer count is known.",
    "- No email sequence, CRM behaviour or follow-up process was seen.",
  );

  parts.push("", "Write the email now. Return only the JSON object.");
  return parts.join("\n");
}

function list(values: string[]): string {
  return values.length ? values.join(", ") : "unknown";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
