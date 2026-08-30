import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapDomainSearch, type DomainSearchResponse } from "../src/lib/enrichment/hunter-map";
import { resolveIdentity } from "../src/lib/identity/resolve";
import type { PersonCandidate } from "../src/lib/identity/types";

/**
 * Hunter is the first source that can hand us an address nobody ever published.
 * These tests exist to keep that distinction from eroding: everything here is
 * about refusing a plausible-looking answer, not about producing one.
 */

function response(emails: NonNullable<NonNullable<DomainSearchResponse["data"]>["emails"]>): DomainSearchResponse {
  return { data: { domain: "realsidecommunity.com", organization: "RealSide Real Estate", emails } };
}

const seen = [{ uri: "https://realsidecommunity.com/about", extracted_on: "2026-01-04" }];

describe("what Hunter saw vs what Hunter guessed", () => {
  it("marks an address with no public source as unobserved and low confidence", () => {
    const result = mapDomainSearch(
      response([
        {
          value: "marcus@realsidecommunity.com",
          type: "personal",
          confidence: 95,
          first_name: "Marcus",
          last_name: "Webb",
          position: "Founder",
          sources: [],
          verification: { status: "accept_all" },
        },
      ]),
      "realsidecommunity.com",
    );

    const email = result.emails[0]!;
    // 95/100 and "accept_all" look convincing. Neither is evidence that anyone
    // ever published this address — Hunter inferred it from the domain pattern.
    assert.equal(email.observed, false);
    assert.equal(email.confidence, "low");
    assert.match(email.evidence, /inferred from the domain pattern/);
  });

  it("trusts a verified address that was actually seen on a page", () => {
    const result = mapDomainSearch(
      response([
        {
          value: "marcus@realsidecommunity.com",
          type: "personal",
          confidence: 92,
          first_name: "Marcus",
          last_name: "Webb",
          position: "Founder",
          sources: seen,
          verification: { status: "valid" },
        },
      ]),
      "realsidecommunity.com",
    );

    assert.equal(result.emails[0]!.observed, true);
    assert.equal(result.emails[0]!.confidence, "high");
  });

  it("never lets a generic inbox rise above low", () => {
    const result = mapDomainSearch(
      response([
        {
          value: "info@realsidecommunity.com",
          type: "generic",
          confidence: 99,
          sources: seen,
          verification: { status: "valid" },
        },
      ]),
      "realsidecommunity.com",
    );

    assert.equal(result.emails[0]!.kind, "generic_inbox");
    assert.equal(result.emails[0]!.confidence, "low");
    assert.equal(result.people.length, 0, "a role inbox names nobody");
  });

  it("rejects a job title sitting in the name fields", () => {
    const result = mapDomainSearch(
      response([
        {
          value: "host@realsidecommunity.com",
          type: "personal",
          confidence: 88,
          first_name: "Host",
          last_name: null,
          position: "Host",
          sources: seen,
        },
      ]),
      "realsidecommunity.com",
    );

    assert.equal(result.people.length, 0, '"Host" is a role, not a person');
  });
});

describe("Hunter's standing in the resolver", () => {
  const domain = "realsidecommunity.com";

  function resolve(people: PersonCandidate[]) {
    return resolveIdentity({
      people,
      emails: [],
      brand: "RealSide",
      legalEntity: "RealSide Real Estate LLC",
      domain,
      rootDomain: domain,
      pagesChecked: [],
    });
  }

  const fromHunter = mapDomainSearch(
    response([
      {
        value: "marcus@realsidecommunity.com",
        type: "personal",
        confidence: 92,
        first_name: "Marcus",
        last_name: "Webb",
        position: "Founder",
        sources: seen,
        verification: { status: "valid" },
      },
    ]),
    domain,
  ).people;

  it("will not address someone on Hunter's word alone", () => {
    const result = resolve(fromHunter);
    assert.equal(result.owner?.fullName, "Marcus Webb");
    assert.equal(
      result.safeToAddressByName,
      false,
      "one provider is one source; the email must still omit the name",
    );
  });

  it("promotes the name once the site's own copy agrees", () => {
    const onPage: PersonCandidate = {
      fullName: "Marcus Webb",
      firstName: "Marcus",
      lastName: "Webb",
      role: null,
      source: "signature",
      confidence: "medium",
      evidence: "— Marcus Webb",
      foundOn: `https://${domain}/about`,
    };

    const result = resolve([...fromHunter, onPage]);
    assert.equal(result.safeToAddressByName, true);
    assert.equal(result.owner?.confidence, "high");
  });

  it("does not promote a name only Hunter has, however often it repeats it", () => {
    const result = resolve([...fromHunter, ...fromHunter, ...fromHunter]);
    assert.equal(result.safeToAddressByName, false, "one source seen three times is still one source");
  });

  it("never offers an inferred address as the owner's", () => {
    const guessed = mapDomainSearch(
      response([
        {
          value: "marcus@realsidecommunity.com",
          type: "personal",
          confidence: 97,
          first_name: "Marcus",
          last_name: "Webb",
          sources: [],
        },
      ]),
      domain,
    );

    const result = resolveIdentity({
      people: guessed.people,
      emails: guessed.emails,
      brand: "RealSide",
      legalEntity: null,
      domain,
      rootDomain: domain,
      pagesChecked: [],
    });

    assert.equal(result.ownerEmail, null, "an unobserved address is exactly the one that bounces");
    assert.equal(result.emails.length, 1, "it stays visible to the operator, just unused");
  });
});

describe("contact address priority", () => {
  const domain = "acme.com";
  const owner: PersonCandidate = {
    fullName: "Dana Reeves",
    firstName: "Dana",
    lastName: "Reeves",
    role: "Founder",
    source: "team_page",
    confidence: "high",
    evidence: "Dana Reeves — Founder",
    foundOn: `https://${domain}/about`,
  };

  function resolve(emails: DomainSearchResponse, people: PersonCandidate[] = [], rejected: string[] = []) {
    const mapped = mapDomainSearch(emails, domain);
    return resolveIdentity({
      people: [...people, ...mapped.people],
      emails: mapped.emails,
      brand: "Acme",
      legalEntity: null,
      domain,
      rootDomain: domain,
      pagesChecked: [],
      rejectedEmails: rejected,
    });
  }

  const generic = {
    value: "info@acme.com",
    type: "generic",
    confidence: 95,
    sources: seen,
    verification: { status: "valid" },
  };
  const personal = {
    value: "dana@acme.com",
    type: "personal",
    confidence: 92,
    first_name: "Dana",
    last_name: "Reeves",
    position: "Founder",
    sources: seen,
    verification: { status: "valid" },
  };

  it("prefers the owner's own address over a role inbox", () => {
    const result = resolve(response([generic, personal]), [owner]);
    assert.equal(result.ownerEmail?.address, "dana@acme.com");
    // The role inbox is not lost — it is the labelled second choice.
    assert.equal(result.fallbackEmail?.address, "info@acme.com");
  });

  it("keeps a role inbox as a fallback when no owner address exists", () => {
    const result = resolve(response([generic]));
    assert.equal(result.ownerEmail, null, "info@ is never the owner");
    assert.equal(result.fallbackEmail?.address, "info@acme.com", "but it is still a way to reach the business");
    assert.equal(result.fallbackEmail?.kind, "generic_inbox");
  });

  it("still refuses an address that was only guessed", () => {
    const guessed = { ...personal, sources: [] };
    const result = resolve(response([guessed]));
    assert.equal(result.ownerEmail, null);
    assert.equal(result.fallbackEmail, null, "a pattern guess is not a lead, it is a bounce");
    assert.equal(result.emails.length, 1, "it stays listed for the operator to judge");
  });

  it("reveals the next candidate when one is rejected", () => {
    const first = resolve(response([generic, personal]), [owner]);
    assert.equal(first.ownerEmail?.address, "dana@acme.com");

    const after = resolve(response([generic, personal]), [owner], ["dana@acme.com"]);
    assert.equal(after.ownerEmail, null, "the rejected address is gone");
    assert.equal(after.fallbackEmail?.address, "info@acme.com", "and the next one is offered");
  });

  it("proposes nothing once every address is rejected", () => {
    const result = resolve(response([generic, personal]), [owner], ["dana@acme.com", "info@acme.com"]);
    assert.equal(result.ownerEmail, null);
    assert.equal(result.fallbackEmail, null);
  });
});
