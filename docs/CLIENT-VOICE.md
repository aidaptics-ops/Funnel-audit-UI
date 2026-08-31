# Adding client emails

The generator imitates one person. Everything it knows about how he writes comes
from `seed/client-emails.txt` and the profile derived from it.

New batches arrive periodically. This is the whole procedure.

## The five steps

1. **Append to `seed/client-emails.txt`**, separated by a line containing only
   `---`. Paste them verbatim — the typos matter. "delvierables", "instatnly",
   "abandonding" are part of the signal that these are written fast by a person,
   and the profile explicitly notes them.

2. **Run the tests.** `npm test`

   `tests/voice.test.ts` validates the whole library against the generator's own
   guardrails. If a new email trips a hard violation, that is not a bad email —
   it means the validator would reject the voice it is being asked to imitate.
   Fix the validator, not the email. This has happened twice and both times the
   library was right.

3. **Regenerate the profile.** Sign in, then:

   ```
   curl -b cookies.txt -X POST http://localhost:3000/api/client-profile
   ```

   or press **Rebuild profile** on the Client Voice page. Takes ~100 seconds and
   about $0.10 of Claude, which the Expenditure page records.

4. **Commit the derived profile** into `seed/client-profile.json`. A deployment
   reads this before anyone presses anything, so an uncommitted profile means
   production is running on the old voice. A test fails if its `sampleCount`
   does not match the library.

5. **Deploy.** The seed file ships in the image.

## Why the seed file is merged rather than used as a fallback

`readSnapshot()` returns the **union** of the committed seed library and
whatever the operator added through the UI, matched on a content fingerprint.

It used to be "stored emails, or the seed if the store is empty", which broke
the thing the seed file exists for: any deployment that had ever written to its
own store — which is every long-lived one — never saw a newly committed email
again. The library silently stopped growing while appearing to work.

Deleting a seeded sample through the UI records its id in `dismissedSeedIds`,
so a deliberate deletion is not undone by the next merge.

## What the guardrails are protecting

The audit renders exactly one page. It never submits a form, never books, never
sees a confirmation page, and has no traffic, spend or conversion data.

His emails routinely discuss those later stages, so the rule is not "never
mention them" — it is a distinction between three things:

| | Allowed | Example |
| --- | --- | --- |
| **Absence** the rendered page evidences | yes | "the lack of pre-call consumption material" |
| **Opportunity** at a named later stage | yes | "a missed opportunity on your confirmation page to pre-handle objections" |
| **Content** of a page nobody loaded | never | "your confirmation page is a bare calendar embed" |

Measured across the five most recent emails, he makes **zero** claims of the
third kind. The rule is his own practice, not an imposition on it.

Two further rules follow from the same place:

- **No hedging the diagnosis.** "I suspect", "you might have", "I'm guessing"
  are rejected. But deleting the hedge is not the fix — a confident version of
  an invented claim is worse, because nothing marks it any more. The prompt
  tells the model to move the subject back to the page instead.
- **Hedging a number is still required.** "I've seen this lift show up rates by
  5-10%" is correct and stays correct. The distinction is what is being
  hedged: the magnitude, not the finding.

## Two registers

The library holds two. Samples 1–11 open "Hey \<Name\>", close "Best, Vlad", and
offer "another 5 low hanging fruits ... in a short loom audit". Samples 12–16
open on the bare name, add a bracketed credential, close on a target percentage
and sign off "let me know, -Vlad".

Both are his. The prompt tells the model to pick one and stay in it, preferring
the recent one. When a new batch changes the register again, the standing lines
need adding to `BOILERPLATE_PATTERNS` in `src/lib/email/voice.ts` — otherwise
the invented-metric rule rejects his own credential line, and the plagiarism
rule rejects his own signature. Both have happened; both are now tests.
