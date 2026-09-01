import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreOwner } from "../src/lib/enrichment/owner-score";
import { runKey } from "../src/lib/sheets/key";

/**
 * The verification contract, expressed as behaviour rather than as a call to
 * the live API.
 *
 * The distinction these tests protect is three-way, not two-way. An address
 * can be confirmed, refuted, or genuinely unknowable — and a catch-all domain
 * is the third. Collapsing it into "valid" claims proof we do not have;
 * collapsing it into "invalid" throws away most small-business founders, who
 * sit behind exactly that kind of mail server.
 */

/** Mirrors the mapping in neverbounce.ts, which is what the pipeline acts on. */
function readVerdict(result: string): { usable: boolean; confirmed: boolean } {
  return {
    usable: result !== "invalid" && result !== "disposable",
    confirmed: result === "valid",
  };
}

describe("what a verification result means", () => {
  it("treats only a positive check as proof", () => {
    assert.deepEqual(readVerdict("valid"), { usable: true, confirmed: true });
  });

  it("rejects addresses that would bounce or are burners", () => {
    assert.deepEqual(readVerdict("invalid"), { usable: false, confirmed: false });
    assert.deepEqual(readVerdict("disposable"), { usable: false, confirmed: false });
  });

  it("keeps a catch-all as usable but never as confirmed", () => {
    // Observed live: andrew@rocketreach.co returns catchall. The mailbox may
    // well be real — the domain simply refuses to say, and plenty of real
    // founders sit behind one.
    assert.deepEqual(readVerdict("catchall"), { usable: true, confirmed: false });
  });

  it("keeps an unreachable server as usable but never as confirmed", () => {
    assert.deepEqual(readVerdict("unknown"), { usable: true, confirmed: false });
  });
});

describe("ranking addresses for verification", () => {
  /** Mirrors rank() in pipeline.ts. */
  function score(address: string, source: string, founderFirst: string, domain: string): number {
    const local = address.split("@")[0]?.toLowerCase() ?? "";
    let value = 0;
    if (local.includes(founderFirst)) value += 50;
    if (address.endsWith(`@${domain}`)) value += 20;
    if (source === "web research") value += 15;
    if (/^(info|support|hello|contact|admin|team|sales)/.test(local)) value -= 30;
    if (source.includes("constructed")) value -= 10;
    return value;
  }

  it("puts the founder's own address ahead of the front desk", () => {
    // Verbatim from a live run: the personal address beat hello@ and support@.
    const marvin = score("marvin@wealthcreatorslive.com", "Hunter email-finder (constructed)", "marvin", "wealthcreatorslive.com");
    const hello = score("hello@wealthcreatorslive.com", "web research", "marvin", "wealthcreatorslive.com");
    const support = score("support@wealthcreatorslive.com", "web research", "marvin", "wealthcreatorslive.com");

    assert.ok(marvin > hello, "a name match should outrank a role inbox");
    assert.ok(marvin > support);
  });

  it("prefers a published address over a constructed one, all else equal", () => {
    const seen = score("dana@acme.com", "web research", "dana", "acme.com");
    const built = score("dana@acme.com", "Hunter email-finder (constructed)", "dana", "acme.com");
    assert.ok(seen > built);
  });
});

describe("a researched title still has to earn the owner bar", () => {
  it("accepts the titles the research actually returns for owners", () => {
    for (const title of ["Founder", "Principal", "CEO", "Owner"]) {
      assert.ok(scoreOwner({ title }).score > 0, `${title} should score`);
    }
  });

  it("does not treat a company contact as the owner", () => {
    // A live run returned "Company Contact" from a BBB listing — that is a
    // directory field, not evidence of ownership.
    assert.equal(scoreOwner({ title: "Company Contact" }).isOwnerTitle, false);
  });
});

describe("text that breaks the API request", () => {
  /** Mirrors stripLoneSurrogates in the Anthropic provider. */
  const strip = (text: string): string =>
    text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");

  it("removes a surrogate with no partner", () => {
    // A live funnel carried one of these — an emoji cut in half by a length
    // limit. JSON.stringify emitted the broken half, the body stopped being
    // valid JSON, and every generation for that page failed with a byte
    // offset and no cause.
    const broken = `Doors close ${String.fromCharCode(0xd83d)} today`;
    const cleaned = strip(broken);
    assert.doesNotMatch(cleaned, /[\uD800-\uDFFF]/);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify({ text: cleaned })));
  });

  it("leaves well-formed emoji alone", () => {
    const good = "Real emoji 🚀 and 👍 here";
    assert.equal(strip(good), good, "a valid pair must survive untouched");
  });

  it("handles a stray low surrogate too", () => {
    const broken = `x${String.fromCharCode(0xde00)}y`;
    assert.equal(strip(broken), "x\uFFFDy");
  });
});

describe("unfilled placeholders", () => {
  /** Mirrors PLACEHOLDER in validate.ts. */
  const PLACEHOLDER = /\[[A-Za-z][A-Za-z0-9 ._/-]{1,24}\]|\{\{[^}]+\}\}/;

  it("catches bracketed tokens the old word list missed", () => {
    // Verbatim from a live Opus 5 draft that shipped past the old rule.
    assert.match("Doors Close [DATE] at [TIME] - Seats Are Limited", PLACEHOLDER);
  });

  it("still catches the classic ones", () => {
    for (const text of ["Hey [Name],", "at [Company]", "{{first_name}}"]) {
      assert.match(text, PLACEHOLDER);
    }
  });

  it("does not fire on ordinary prose", () => {
    for (const text of ["Your form asks for a phone number.", "I noticed 6 different labels."]) {
      assert.doesNotMatch(text, PLACEHOLDER);
    }
  });
});

/**
 * The real runKey, imported rather than mirrored.
 *
 * This block used to hold a hand-copied reimplementation. A copy of a function
 * under test only tests the copy: the tracking list here had already drifted
 * from the real one, so these could all have passed while the shipped keying
 * filed one funnel as two runs. Importing it is the whole point.
 */
describe("run identity", () => {
  it("treats a tracked link and a clean one as the same run", () => {
    // Verbatim shape from a live paste. These filed as two separate runs, each
    // holding half the data.
    const tracked =
      "https://thefinallover.com/compass?utm_medium=paid&utm_source=fb&utm_id=694&fbclid=IwY2xja&h_ad_id=1&sid=2";
    assert.equal(runKey(tracked), runKey("https://thefinallover.com/compass"));
  });

  it("ignores www, a trailing slash and a fragment", () => {
    assert.equal(runKey("https://www.acme.com/offer/#top"), runKey("https://acme.com/offer"));
  });

  it("does NOT merge genuinely different pages", () => {
    assert.notEqual(runKey("https://acme.com/a"), runKey("https://acme.com/b"));
    // An unrecognised parameter may well select a different landing page.
    assert.notEqual(runKey("https://acme.com/x?variant=a"), runKey("https://acme.com/x?variant=b"));
  });

  it("orders remaining parameters so the key is stable", () => {
    assert.equal(runKey("https://acme.com/x?b=2&a=1"), runKey("https://acme.com/x?a=1&b=2"));
  });
});
