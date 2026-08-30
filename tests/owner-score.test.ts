import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTACTABLE_SCORE_BAR, OWNER_SCORE_BAR, scoreOwner } from "../src/lib/enrichment/owner-score";
import { mapDomainSearch, type DomainSearchResponse } from "../src/lib/enrichment/hunter-map";

/**
 * The whole point of the rework: a provider returns ten people and only one of
 * them decides anything. Picking the right one is what turns "we found an
 * email" into "we found the owner".
 */

describe("who counts as the owner", () => {
  const rank = (title: string) => scoreOwner({ title }).score;

  it("puts founders and owners above every employee title", () => {
    for (const title of ["Founder", "Co-Founder", "Owner", "CEO", "Chief Executive Officer"]) {
      assert.ok(rank(title) >= OWNER_SCORE_BAR, `${title} should clear the owner bar (got ${rank(title)})`);
    }
    for (const title of ["Head of Engineering", "VP of Sales", "Marketing Manager", "Account Executive"]) {
      assert.ok(rank(title) < OWNER_SCORE_BAR, `${title} should NOT clear the owner bar (got ${rank(title)})`);
    }
  });

  it("does not mistake a vice president for the president", () => {
    assert.ok(rank("President") > rank("Vice President"));
    assert.ok(rank("President") >= OWNER_SCORE_BAR);
    assert.ok(rank("Vice President") < OWNER_SCORE_BAR);
  });

  it("reads a combined title by its strongest half", () => {
    // Hunter returns these constantly: "Co-founder & CTO" is an owner.
    assert.ok(rank("Co-founder & CTO") >= OWNER_SCORE_BAR);
    assert.ok(rank("Founder and Head Coach") >= OWNER_SCORE_BAR);
  });

  it("pushes front-desk roles below the contactable bar", () => {
    // Easy to reach, and a dead end — a cold email stops there.
    for (const title of ["Customer Support Specialist", "Sales Development Rep", "Executive Assistant"]) {
      assert.ok(
        scoreOwner({ title, seniority: "senior" }).score < CONTACTABLE_SCORE_BAR,
        `${title} should rank below the contactable bar`,
      );
    }
  });

  it("treats a small company's chief executive as more owner-like", () => {
    const small = scoreOwner({ title: "CEO", companySize: "1-10" }).score;
    const large = scoreOwner({ title: "CEO", companySize: "10K-50K" }).score;
    assert.ok(small > large, "at ten people the CEO is the owner; at ten thousand they are not");
  });

  it("uses the provider's own signals, but never as a substitute for a title", () => {
    const flagged = scoreOwner({ title: "Regional Sales Manager", decisionMaker: true, seniority: "executive" });
    assert.ok(
      flagged.score < OWNER_SCORE_BAR,
      "a decision-maker flag on a sales manager must not make them the owner",
    );
    assert.equal(flagged.isOwnerTitle, false);
  });

  it("explains itself", () => {
    assert.match(scoreOwner({ title: "Founder", decisionMaker: true }).rationale, /founder/);
  });
});

describe("ranking a real Hunter payload", () => {
  const response: DomainSearchResponse = {
    data: {
      domain: "acme.com",
      organization: "Acme",
      accept_all: false,
      pattern: "{first}",
      emails: [
        {
          value: "support@acme.com",
          type: "generic",
          source_type: "found",
          confidence: 99,
          position: "Customer Support",
          sources: [{ uri: "https://acme.com/contact" }],
        },
        {
          value: "kate@acme.com",
          type: "personal",
          source_type: "found",
          confidence: 92,
          first_name: "Kate",
          last_name: "Mbeki",
          position: "Founder & CEO",
          seniority: "executive",
          department: "executive",
          decision_maker: true,
          verification: { status: "valid" },
          sources: [{ uri: "https://acme.com/about" }],
        },
        {
          value: "dan@acme.com",
          type: "personal",
          source_type: "found",
          confidence: 90,
          first_name: "Dan",
          last_name: "Ford",
          position: "Account Executive",
          seniority: "senior",
          department: "sales",
          verification: { status: "valid" },
          sources: [{ uri: "https://acme.com/team" }],
        },
      ],
    },
  };

  it("surfaces the founder first even though she is listed second", () => {
    const result = mapDomainSearch(response, "acme.com");
    assert.equal(result.people[0]?.fullName, "Kate Mbeki");
    assert.equal(result.ownerAddress, "kate@acme.com");
  });

  it("does not offer the sales rep as the owner", () => {
    const result = mapDomainSearch(response, "acme.com");
    assert.notEqual(result.ownerAddress, "dan@acme.com");
  });

  it("reports that it spent a credit", () => {
    assert.equal(mapDomainSearch(response, "acme.com").creditSpent, true);
  });
});

describe("an accept-all domain", () => {
  /**
   * A mail server that accepts every address answers "valid" for addresses
   * that do not exist. Treating that as verification is how a fabricated
   * address gets promoted.
   */
  const build = (acceptAll: boolean): DomainSearchResponse => ({
    data: {
      domain: "acme.com",
      accept_all: acceptAll,
      emails: [
        {
          value: "kate@acme.com",
          type: "personal",
          source_type: "found",
          confidence: 95,
          first_name: "Kate",
          last_name: "Mbeki",
          position: "Founder",
          verification: { status: "valid" },
          sources: [{ uri: "https://acme.com/about" }],
        },
      ],
    },
  });

  it("trusts an SMTP result only when the domain does not accept everything", () => {
    assert.equal(mapDomainSearch(build(false), "acme.com").emails[0]?.confidence, "high");
    assert.equal(
      mapDomainSearch(build(true), "acme.com").emails[0]?.confidence,
      "medium",
      "an accept-all domain cannot confirm an address",
    );
  });

  it("says so in the evidence, so the operator can see why", () => {
    assert.match(mapDomainSearch(build(true), "acme.com").emails[0]!.evidence, /accepts all mail/);
  });
});
