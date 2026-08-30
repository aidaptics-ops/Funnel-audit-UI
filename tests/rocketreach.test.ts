import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapLookup, mapSearch, type RrLookupResponse } from "../src/lib/enrichment/rocketreach-map";
import { resolveIdentity } from "../src/lib/identity/resolve";

/**
 * Built from a real RocketReach response. That lookup returned NINE addresses
 * for one person: four verified, four pattern guesses that fail SMTP, and a
 * private mailbox. Sorting those correctly is the whole job — the guesses are
 * exactly the addresses that bounce.
 */
const DOMAIN = "rocketreach.co";

const REAL_LOOKUP: RrLookupResponse = {
  id: 1430550,
  status: "complete",
  name: "Andrew Tso",
  current_title: "Founder",
  current_employer: "RocketReach.co",
  emails: [
    { email: "andrew@rocketreach.co", type: "professional", grade: "A", smtp_valid: "valid" },
    { email: "andy.tso@gmail.com", type: "personal", grade: "A", smtp_valid: "valid" },
    { email: "atso@rocketreach.co", type: "professional", grade: "F", smtp_valid: "invalid" },
    { email: "andrew.tso@rocketreach.co", type: "professional", grade: "F", smtp_valid: "invalid" },
    { email: "a.tso@rocketreach.co", type: "professional", grade: "F", smtp_valid: "invalid" },
    { email: "info@rocketreach.co", type: "role-based", grade: "B", smtp_valid: "valid" },
    { email: "burner@mailinator.com", type: "disposable", grade: "A", smtp_valid: "valid" },
  ],
};

describe("reading a RocketReach lookup", () => {
  const mapped = mapLookup(REAL_LOOKUP, DOMAIN);

  it("drops disposable addresses entirely", () => {
    assert.equal(
      mapped.emails.some((email) => email.address.includes("mailinator")),
      false,
      "a burner is not a lead worth a human decision",
    );
  });

  it("treats an SMTP-invalid grade-F address as a guess, not a find", () => {
    for (const address of ["atso@rocketreach.co", "andrew.tso@rocketreach.co", "a.tso@rocketreach.co"]) {
      const email = mapped.emails.find((entry) => entry.address === address)!;
      assert.equal(email.observed, false, `${address} should not count as observed`);
      assert.equal(email.confidence, "low");
    }
  });

  it("trusts an address whose mailbox answered and grades well", () => {
    const email = mapped.emails.find((entry) => entry.address === "andrew@rocketreach.co")!;
    assert.equal(email.observed, true);
    assert.equal(email.confidence, "high");
  });

  it("labels a role inbox as one", () => {
    assert.equal(mapped.emails.find((entry) => entry.address === "info@rocketreach.co")!.kind, "generic_inbox");
  });

  it("does not let a queued lookup look like an empty one", () => {
    const pending = mapLookup({ ...REAL_LOOKUP, status: "progress", emails: [] }, DOMAIN);
    assert.equal(pending.complete, false, "callers must be able to tell 'not ready' from 'nothing found'");
  });
});

describe("choosing from a RocketReach lookup", () => {
  const mapped = mapLookup(REAL_LOOKUP, DOMAIN);
  const { people } = mapSearch(
    { profiles: [{ id: 1430550, name: "Andrew Tso", current_title: "Founder", current_employer: "RocketReach.co" }] },
    DOMAIN,
  );

  const identity = resolveIdentity({
    people: [
      ...people,
      {
        fullName: "Andrew Tso",
        firstName: "Andrew",
        lastName: "Tso",
        role: "Founder",
        source: "team_page",
        confidence: "high",
        evidence: "Andrew Tso — Founder",
        foundOn: `https://${DOMAIN}/about`,
      },
    ],
    emails: mapped.emails,
    brand: "RocketReach",
    legalEntity: null,
    domain: DOMAIN,
    rootDomain: DOMAIN,
    pagesChecked: [],
  });

  it("picks the verified work address as the owner's", () => {
    assert.equal(identity.ownerEmail?.address, "andrew@rocketreach.co");
  });

  it("keeps a private mailbox only as the labelled fallback", () => {
    // Reaching someone at work is the professional choice; their Gmail is a
    // second option a human should have to accept deliberately.
    assert.equal(identity.fallbackEmail?.address, "andy.tso@gmail.com");
  });

  it("never proposes one of the four bouncing guesses", () => {
    const proposed = [identity.ownerEmail?.address, identity.fallbackEmail?.address];
    for (const guess of ["atso@rocketreach.co", "andrew.tso@rocketreach.co", "a.tso@rocketreach.co"]) {
      assert.equal(proposed.includes(guess), false, `${guess} must never be proposed`);
    }
  });
});

describe("reading a RocketReach search", () => {
  it("keeps names and titles but never invents contact details", () => {
    const { profiles, people } = mapSearch(
      {
        profiles: [
          { id: 1, name: "Dana Reeves", current_title: "Founder", current_employer: "Acme" },
          { id: 2, name: "This Is For You", current_title: "Heading" },
          { id: 3, name: "Host", current_title: "Host" },
        ],
      },
      "acme.com",
    );

    assert.equal(profiles.length, 1, "sentence fragments and job titles are not people");
    assert.equal(people[0]?.fullName, "Dana Reeves");
    // A provider is one source: it cannot make a name usable on its own.
    assert.equal(people[0]?.confidence, "medium");
  });
});
