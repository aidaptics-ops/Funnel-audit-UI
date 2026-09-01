import { evidenceText } from "../audit/normalize";
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
  4. The standing offer (more findings + free audit + the named clients who paid for it)
  5. Sign-off

There are two registers in the samples and BOTH are his. The recent ones open on the bare first name ("Brian,"), drop the pronoun on the touchpoint ("Just booked a strategy call with Sonny..."), add a bridge ("And I noticed you're doing a lot of things right, but I found something pretty critical that is wrecking your show up rate..."), carry a credential in brackets ("(I work with offer owners increase their show up rate past 85%..., so I have a good idea of what converts best)"), close on a target ("These 2 tweaks might sound simple but they get you closer to a 85% show rate, but there's 5 others things too...") and sign off "let me know, -Vlad". The older ones use "Hey <Name>", "There's another 5 low hanging fruits...", and "Best, Vlad". Pick one register and stay in it. Prefer the recent one.
He rotates the naming phrase: "The first thing I noticed is", "The second problem I saw is", "The second thing I spotted". Use them.

Reuse the skeleton, the transitions and the closing offer - that wording is the client's signature and is meant to repeat.
NEVER reuse an observation, a diagnosis or an explanation from a sample. Those belong to another prospect's funnel. Yours must be written from THIS funnel's evidence.

LOOK AT THE PAGE BEFORE YOU BELIEVE THE EVIDENCE LIST
When screenshots are attached, they are the page as a visitor sees it. The OBSERVED EVIDENCE and PRIORITISED OBSERVATIONS below are a machine reading of the HTML, and that reading is confidently wrong in specific, recognisable ways:

- A button whose click is handled in JavaScript has no href, so it is reported as "leads nowhere" or "no conversion path". If you can SEE a working opt-in button, there is one.
- A form inside a popup, a modal or an embedded widget does not exist in the HTML until it is opened, so it is reported as "0 forms".
- Testimonials, star ratings, logos and guarantees baked into an IMAGE are reported as zero social proof.
- Text rendered inside an image is invisible to the reading and plain to you.

THE SCREENSHOT WINS. If the evidence list says something is missing and you can see it in the picture, the evidence list is wrong — drop that observation entirely and pick a different one. Never tell a prospect their button, form or testimonials are missing when the screenshot shows them. That single mistake destroys the email's credibility and the sender's.

The reverse also holds: if the picture shows a real problem the evidence list missed — a headline hidden below a giant hero image, a CTA the same colour as its background, a wall of text with no visual break, a page that simply looks untrustworthy — that IS an observation you may use. Say what you saw.

If no screenshots are attached, work from the evidence list alone and be correspondingly careful about claiming something is absent.

PAGES REACHED AFTER THE CONVERSION STEP
Check the === POST-BOOKING / CONFIRMATION PAGE === section below and any evidence lines tagged "[post-booking]" before you decide that page is unseen - on some runs the operator has photographed it, and treating it as unseen anyway would be leaving out real evidence. Both mean the same thing: a page after the funnel's conversion step - a confirmation page, a booking screen, a thank-you page - is something the operator went through this funnel's conversion step himself to reach and photographed, captioned "OPERATOR SCREENSHOT". There is no crawl of that page; it is only ever his own photograph or nothing at all.

Treat it as first-hand evidence. For THAT page the usual restriction is lifted: you may say exactly what is on it and what is missing from it, the same way you would about the landing page. It is also what licenses the opening line that claims he booked or bought - see "Operator personally completed this funnel's conversion action" below.

  GOOD - "The confirmation page after booking is just the calendar summary - nothing prepares them for the call."
  GOOD - "Your thank-you page has the Zoom link and nothing else."

Two things still hold. Describe only what you can actually SEE in the photograph or that is actually cited - do not extrapolate to the confirmation email, the reminders, the call itself or anything else it does not show (see THE STAGES AFTER THIS PAGE below - those stay unseen regardless). And a stage with no screenshot supplied is still unseen: keep raising those as opportunities, never as descriptions. One rule is stricter here than on the landing page: never claim that page has NO X - a photograph can prove something is present, never that it is absent, however many screenshots exist.

HARD RULES
- Use only facts from the OBSERVED EVIDENCE section, or from the screenshots. If it is in neither, you may not assert it.
- Never state the prospect's current performance as fact - no "your conversion rate is X", "you're losing X%", "this is costing you $X". The audit measures none of that.
- Naming the metric a fix would move IS allowed and is how the client opens ("something pretty critical that is wrecking your show up rate"). Claiming to know where that metric currently sits is not.
- You MAY reference a likely improvement the way the client does, either as a projected result ("this gets you closer to a 5% conversion rate", "will lift your opt in rate by 3-5%") or as a marked estimate ("I've seen this lift..."). Never as a measurement of where they are today.

- Do not claim you booked a call, bought the product or signed up unless the brief explicitly says the operator did.
- Never state the number of problems found in the audit. This is a note from a person, not a report.
- Do not lead with minor technical SEO housekeeping.

NEVER SOUND LIKE YOU ARE GUESSING
The client's entire positioning is that he looked and he knows. These are banned outright:
  "you might have...", "I suspect...", "it could be that...", "you may have a problem with...", "I'm guessing...", "my guess is that...", "chances are...", "presumably", "perhaps you...", "maybe you...", "if I had to guess...", "from what I can tell", "it seems", "it looks like"

But DELETING THE HEDGE IS NOT THE FIX. If you catch yourself reaching for one, that sentence has left the page - and a confident version of an invented claim is worse than a hedged one, because now nothing marks it. Move the subject back to what you actually saw.

  WRONG:      "My guess is you hear your closers complain that people show up cold."
  ALSO WRONG: "You hear your closers complain that people show up cold."   <- hedge gone, invention still there
  RIGHT:      "Nothing on this page gives them a reason to trust anyone before the call."

If no page-anchored version of the claim exists, cut it. A shorter email that is certain beats a longer one that hedges.
This is separate from hedging a NUMBER, which is still required: "I've seen this lift show up rates by 5-10%" is correct.

NEVER ASSERT A REAL PERSON'S BEHAVIOUR OR EXPERIENCE
You may say what a CLASS of people does. You may not say what this prospect, their staff, their closers or their customers actually did, said or felt - you have never met them.
  GOOD - "A large percentage of guys will schedule a call but still have internal objections that stop them from showing up."
  BAD  - "Your reps waste the first ten minutes of every call building trust."
  BAD  - "Half the people who book never show up."   (a measurement of their business, with or without the number)

THE STAGES AFTER THIS PAGE
The audit always renders the landing page. There is no crawl of the page after the funnel's conversion step at all - on some runs the operator has photographed it himself, by actually going through the funnel, and on others nothing of it exists yet. Whether THIS run has one, and what it shows, is stated below in === POST-BOOKING / CONFIRMATION PAGE === and in the "[post-booking]"-tagged lines of OBSERVED EVIDENCE. Trust that section, not an assumption either way - do not default to "unseen" if it says otherwise, and do not describe that page if it says nothing was supplied.

What NO run ever sees, no matter how much of that page was read: a confirmation email, a follow-up sequence, a reminder email, a calendar invite, the call or meeting itself, onboarding, a CRM entry, an SMS. Those stay unseen even on a run that read the confirmation page top to bottom - reading a page proves what is on the page, not what happens in the messages or the conversation that follow it.

The client's best material lives in exactly those never-seen stages, so you ARE allowed to raise them - confidently, with no hedging. What you may never do is describe what is on a page, or in a message, nobody read. The line is between an OPPORTUNITY and a DESCRIPTION:

  GOOD - "The second problem I saw is the lack of pre-call consumption material."
         (an absence on the page you DID read: nothing on it points to any)
  GOOD - "The second thing I noticed is a missed opportunity on your call confirmation page to pre-handle objections."
         (names a stage, claims only that a technique is unused there)
  GOOD - "A superior way to educate and pre-sell prospects before the call is through a podcast VSL."
         (a recommendation; asserts nothing about them at all)
  GOOD - "You're asking 9 questions on that application - none of that has to go to waste after they book."
         (anchored to the form the audit actually read)
  GOOD, but ONLY when === POST-BOOKING / CONFIRMATION PAGE === below says that page was actually read -
        "The confirmation page after booking is just the calendar summary - nothing prepares them for the call."
         (a fact about a page this run genuinely opened, not one it guessed at)

  BAD  - "Your confirmation page is just a bare calendar embed."          (describes that page - check the section below before assuming it was never read)
  BAD  - "Your follow-up email doesn't reference their answers."          (describes a message - no run ever sees this, regardless of what else was read)
  BAD  - "After they book, there's nothing telling them what to prepare." (describes an unseen stage)
  BAD  - "You might not have a nurture sequence."                         (a guess, and it shows)

Rewriting rule: if a sentence needs you to know what is on a page or in a message nobody read, recast it as the opportunity that stage represents, or cut it. A claim about the confirmation page itself is only safe once you have confirmed, from the section below, that this run actually read it.
The DOWNSTREAM ANGLES section below gives you these already anchored to something observed. They are ANGLES, not findings - use one only if it fits this funnel, and never use one as your only observation.

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
  const { audit, profile, examples, observations, evidence, unobserved, downstream } = context;
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
      `- The anatomy of one observation: ${diagnostic.observation_structure ?? "unknown"}`,
      `- How direct they are: ${diagnostic.directness ?? "unknown"}`,
      `- How they raise stages they could not fully see: ${diagnostic.downstream_reasoning ?? "unknown"}`,
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
    "=== FUNNEL LANDING PAGE ===",
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
        `   evidence: ${issue.evidence.slice(0, 3).map(evidenceText).join(" | ")}`,
        issue.impact ? `   likely impact: ${issue.impact}` : "   likely impact: not stated",
      );
    });
  }

  if (downstream.length > 0) {
    parts.push(
      "",
      "DOWNSTREAM ANGLES (later stages, each already anchored to something observed)",
      "State these confidently if you use one. Do NOT describe what is on those pages.",
    );
    downstream.forEach((entry, index) => {
      parts.push(`${index + 1}. ${entry.angle}`, `   anchored to: ${entry.anchor}`);
    });
  }

  // The product owner's literal marker for the second page. Always printed,
  // so the model has one fixed place to check before assuming that page is
  // unseen — the failure/status branch below is exactly what "or the failure
  // status/reason when not observed" means: the section exists either way,
  // its CONTENT is what changes.
  parts.push("", "=== POST-BOOKING / CONFIRMATION PAGE ===");
  if (context.postBookingFindings.length > 0) {
    parts.push(
      "The operator went through this funnel's conversion step himself and photographed this page for this run. " +
        "There is no crawl of it - nobody but the operator ever reached it, so nothing below licenses claiming " +
        "the AUDIT converted. These are real, verified observations about what is on it:",
    );
    context.postBookingFindings.forEach((issue, index) => {
      parts.push(
        `${index + 1}. ${issue.title} [${issue.severity}]`,
        `   what was seen: ${issue.description}`,
        `   evidence: ${issue.evidence.slice(0, 3).map(evidenceText).join(" | ")}`,
      );
    });
    if (context.relationshipSummary) {
      parts.push("", `How the two pages relate: ${context.relationshipSummary}`);
    }
  } else {
    parts.push(postBookingStatusLine(context.suppliedPages.length));
  }

  const pageImageCount = context.landingImages.length;
  parts.push(
    "",
    pageImageCount > 0
      ? `SCREENSHOTS: ${context.landingImages.length} strip(s) of the landing page are attached above. ` +
        `Check every "missing"/"no X" finding below against them before you use it.`
      : "SCREENSHOTS: none were captured for this page, so the findings below could not be checked against what it looks like. Prefer observations about copy and structure over claims that something is absent.",
  );

  if (context.suppliedPages.length > 0) {
    parts.push(
      "",
      `OPERATOR-SUPPLIED PAGES: ${context.suppliedPages.map((label) => `"${label}"`).join(", ")}.`,
      "He went through this funnel himself and photographed these. They are first-hand evidence - describe them directly.",
    );
  }

  parts.push("", "OBSERVED EVIDENCE (the complete set of facts you may assert, each tagged with which page it describes)");
  for (const line of evidence.slice(0, 90)) parts.push(`- ${line}`);

  parts.push("", "NOT OBSERVED (you may not assert any of this)");
  // A supplied screenshot contradicts the standing "nothing after conversion
  // was seen" note, and leaving both in the prompt is a straight instruction
  // conflict — the model gets told to describe a page and not to, at once.
  const stillUnseen =
    context.suppliedPages.length > 0
      ? unobserved.filter((line) => !/confirmation|thank[- ]?you|after (?:a )?(?:visitor|someone) converts|booking flow/i.test(line))
      : unobserved;
  for (const line of stillUnseen) parts.push(`- ${line}`);
  parts.push(
    "- No conversion rate, traffic level, revenue, ad spend or customer count is known.",
    "- No email sequence, CRM behaviour or follow-up process was seen.",
  );

  parts.push("", "Write the email now. Return only the JSON object.");
  return parts.join("\n");
}

/**
 * What to tell the model about the post-booking page when the two-page
 * analysis produced no usable finding about it.
 *
 * Two different reasons land here, and they read differently: no screenshot
 * has been supplied at all, or one has but nothing on it cleared the bar for
 * a verified, commercially meaningful observation. Either way the OPERATOR-
 * SUPPLIED PAGES section below is the independent, separate licence to
 * describe a supplied screenshot directly — this line is only about what the
 * two-page analysis itself found.
 */
function postBookingStatusLine(suppliedCount: number): string {
  if (suppliedCount === 0) {
    return "No screenshot of the page after conversion has been supplied for this run. Treat everything past the landing page as fully unseen - see THE STAGES AFTER THIS PAGE above.";
  }
  return "A screenshot of the page after conversion has been supplied, but nothing on it cleared the bar for a verified, commercially meaningful observation in the two-page analysis. See OPERATOR-SUPPLIED PAGES below for what you may still say about it directly.";
}

function list(values: string[]): string {
  return values.length ? values.join(", ") : "unknown";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
