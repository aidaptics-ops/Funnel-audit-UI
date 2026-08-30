import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractIdentity, legalEntityFrom, personsFromJsonLd } from "../src/lib/identity/extract";
import {
  collidesWithBrand,
  isRoleAccount,
  looksLikeCompany,
  looksLikePersonName,
  nameFromEmailLocalPart,
  nameFromSlug,
  stripEntitySuffix,
} from "../src/lib/identity/patterns";
import { resolveIdentity } from "../src/lib/identity/resolve";
import { htmlToText } from "../src/lib/identity/html";
import { isFetchableOnDomain, isPrivateHost } from "../src/lib/ssrf";
import { greetingNameIn } from "../src/lib/email/validate";
import type { PersonCandidate } from "../src/lib/identity/types";

/**
 * A wrong name is worse than no name, so most of these assert a REFUSAL.
 */

describe("company vs person", () => {
  it("never mistakes a legal entity for a human", () => {
    for (const value of [
      "RealSide Real Estate Ltd",
      "Acme Holdings LLC",
      "Northwind Coaching Limited",
      "Loop Agency",
      "Harbour Studios",
    ]) {
      assert.equal(looksLikeCompany(value), true, `${value} should read as a company`);
      assert.equal(looksLikePersonName(value), false, `${value} must not read as a person`);
    }
  });

  it("strips the legal suffix when naming the company", () => {
    assert.equal(stripEntitySuffix("RealSide Real Estate Ltd"), "RealSide Real Estate");
    assert.equal(stripEntitySuffix("Acme, Inc."), "Acme");
  });

  it("reads the legal entity out of a copyright line, without the year", () => {
    assert.equal(legalEntityFrom("© 2026 RealSide Real Estate Ltd. All rights reserved."), "RealSide Real Estate Ltd");
    assert.equal(legalEntityFrom("Copyright 2024-2026 Northwind Coaching"), "Northwind Coaching");
    assert.equal(legalEntityFrom("© 2026"), null);
  });

  it("never treats a job title as a name", () => {
    // A real page produced "Host" as a high-confidence person, which would
    // have opened the email "Hey Host,".
    for (const value of ["Host", "Founder", "CEO", "Owner", "Coach", "Director", "Team"]) {
      assert.equal(looksLikePersonName(value), false, `${value} is a title, not a name`);
    }
    // The same word inside a real name is fine.
    assert.equal(looksLikePersonName("Dana Host"), true);
  });

  it("rejects page furniture that happens to be capitalised", () => {
    for (const value of ["Privacy Policy", "Free Training", "Book Now", "About Us", "Real Estate"]) {
      assert.equal(looksLikePersonName(value), false, `${value} must not read as a person`);
    }
  });

  it("accepts ordinary human names, including particles", () => {
    for (const value of ["Shayne Ellis", "Tim", "Dana Reeves", "Ludwig van Beethoven", "Sinead O'Connor"]) {
      assert.equal(looksLikePersonName(value), true, `${value} should read as a person`);
    }
  });

  it("refuses a name that is really the brand", () => {
    assert.equal(collidesWithBrand("RealSide", "RealSide Real Estate", "realsidecommunity.com"), true);
    assert.equal(collidesWithBrand("Northwind", null, "northwind.com"), true);
    assert.equal(collidesWithBrand("Shayne Ellis", "RealSide Real Estate", "realsidecommunity.com"), false);
  });
});

describe("email addresses", () => {
  it("knows a role inbox from a person", () => {
    for (const local of ["info", "hello", "support", "no-reply", "bookings", "customerservice"]) {
      assert.equal(isRoleAccount(local), true, `${local}@ is a role account`);
    }
    assert.equal(isRoleAccount("shayne"), false);
    assert.equal(isRoleAccount("shayne.ellis"), false);
  });

  it("derives a name from an unambiguous local part only", () => {
    assert.equal(nameFromEmailLocalPart("shayne"), "Shayne");
    assert.equal(nameFromEmailLocalPart("shayne.ellis"), "Shayne Ellis");
    // An initial carries no information — guessing here is how you get it wrong.
    assert.equal(nameFromEmailLocalPart("s.ellis"), null);
    assert.equal(nameFromEmailLocalPart("info"), null);
    assert.equal(nameFromEmailLocalPart("team2024"), null);
  });

  it("classifies addresses by kind and keeps generic ones out of the owner slot", () => {
    const result = extractIdentity({
      text: "Questions? info@northwind.com or reach me at shayne@northwind.com",
      foundOn: "https://northwind.com/",
      domain: "northwind.com",
      rootDomain: "northwind.com",
      brand: "Northwind",
    });

    const generic = result.emails.find((email) => email.address === "info@northwind.com");
    const personal = result.emails.find((email) => email.address === "shayne@northwind.com");
    assert.equal(generic?.kind, "generic_inbox");
    assert.equal(personal?.kind, "personal");

    const resolved = resolveIdentity({
      people: result.people,
      emails: result.emails,
      brand: "Northwind",
      legalEntity: null,
      domain: "northwind.com",
      rootDomain: "northwind.com",
      pagesChecked: [],
    });
    assert.equal(resolved.ownerEmail?.address, "shayne@northwind.com");
  });

  it("returns no owner email when only a role inbox exists", () => {
    const result = extractIdentity({
      text: "Contact us at info@northwind.com",
      foundOn: "https://northwind.com/",
      domain: "northwind.com",
      rootDomain: "northwind.com",
      brand: "Northwind",
    });
    const resolved = resolveIdentity({
      people: [],
      emails: result.emails,
      brand: "Northwind",
      legalEntity: null,
      domain: "northwind.com",
      rootDomain: "northwind.com",
      pagesChecked: [],
    });
    assert.equal(resolved.ownerEmail, null, "info@ is never the owner's address");
    assert.equal(resolved.emails.length, 1, "but it is still visible to the operator");
  });

  it("never constructs an address from a name", () => {
    const resolved = resolveIdentity({
      people: [person("Shayne Ellis", "team_page", "high")],
      emails: [],
      brand: "Northwind",
      legalEntity: null,
      domain: "northwind.com",
      rootDomain: "northwind.com",
      pagesChecked: [],
    });
    assert.equal(resolved.owner?.fullName, "Shayne Ellis");
    assert.equal(resolved.ownerEmail, null, "must not invent shayne@northwind.com");
  });
});

describe("finding the person", () => {
  it("reads a self-introduction", () => {
    const result = extractIdentity({
      text: "Hi, I'm Shayne Ellis and I help sellers scale.",
      foundOn: "https://northwind.com/about",
      domain: "northwind.com",
      rootDomain: "northwind.com",
      brand: "Northwind",
    });
    assert.equal(result.people[0]?.fullName, "Shayne Ellis");
    assert.equal(result.people[0]?.confidence, "high");
  });

  it("reads a name-with-role line", () => {
    const result = extractIdentity({
      text: "Dana Reeves — Founder",
      foundOn: "https://northwind.com/team",
      domain: "northwind.com",
      rootDomain: "northwind.com",
      brand: "Northwind",
    });
    assert.ok(result.people.some((entry) => entry.fullName === "Dana Reeves"));
  });

  it("reads JSON-LD Person nodes", () => {
    const people = personsFromJsonLd([
      { "@type": "Organization", name: "Northwind", founder: { "@type": "Person", name: "Shayne Ellis" } },
    ]);
    assert.equal(people[0]?.name, "Shayne Ellis");
  });

  it("reads a LinkedIn slug but not a noisy one", () => {
    assert.equal(nameFromSlug("shayne-ellis"), "Shayne Ellis");
    assert.equal(nameFromSlug("shayne-ellis-1a2b3c"), "Shayne Ellis");
    assert.equal(nameFromSlug("northwind-coaching-official-page-2024"), null);
  });

  it("promotes a name two independent sources agree on", () => {
    const resolved = resolveIdentity({
      people: [
        person("Shayne Ellis", "signature", "medium"),
        person("Shayne Ellis", "email_local_part", "medium"),
      ],
      emails: [],
      brand: "Northwind",
      legalEntity: null,
      domain: "northwind.com",
      rootDomain: "northwind.com",
      pagesChecked: [],
    });
    assert.equal(resolved.owner?.confidence, "high");
    assert.equal(resolved.safeToAddressByName, true);
  });

  it("does NOT promote the same weak source seen twice", () => {
    const resolved = resolveIdentity({
      people: [person("Shayne Ellis", "signature", "medium"), person("Shayne Ellis", "signature", "medium")],
      emails: [],
      brand: "Northwind",
      legalEntity: null,
      domain: "northwind.com",
      rootDomain: "northwind.com",
      pagesChecked: [],
    });
    assert.equal(resolved.owner?.confidence, "medium");
    assert.equal(resolved.safeToAddressByName, false, "one source twice is still one source");
  });
});

describe("the refusal path", () => {
  it("refuses to address by name when nothing was found", () => {
    const resolved = resolveIdentity({
      people: [],
      emails: [],
      brand: "RealSide Real Estate",
      legalEntity: "RealSide Real Estate, 2026",
      domain: "realsidecommunity.com",
      rootDomain: "realsidecommunity.com",
      pagesChecked: [],
    });
    assert.equal(resolved.owner, null);
    assert.equal(resolved.safeToAddressByName, false);
    assert.match(resolved.reason, /will not use a first name/i);
  });

  it("refuses on a medium-confidence guess, and says why", () => {
    const resolved = resolveIdentity({
      people: [person("Dana Reeves", "signature", "medium")],
      emails: [],
      brand: "Northwind",
      legalEntity: null,
      domain: "northwind.com",
      rootDomain: "northwind.com",
      pagesChecked: [],
    });
    assert.equal(resolved.safeToAddressByName, false);
    assert.match(resolved.reason, /not strong enough/i);
  });

  it("an operator confirmation beats every heuristic", () => {
    const resolved = resolveIdentity({
      people: [person("Dana Reeves", "signature", "medium")],
      emails: [],
      brand: "Northwind",
      legalEntity: null,
      domain: "northwind.com",
      rootDomain: "northwind.com",
      pagesChecked: [],
      confirmedName: "Dana Reeves",
    });
    assert.equal(resolved.owner?.confidence, "confirmed");
    assert.equal(resolved.safeToAddressByName, true);
  });
});

describe("greeting detection", () => {
  it("finds the name the email actually used", () => {
    assert.equal(greetingNameIn("Hey Shayne,\n\nI was looking..."), "Shayne");
    assert.equal(greetingNameIn("Hello Tim, I just booked..."), "Tim");
    assert.equal(greetingNameIn("Hi Dana — quick note"), "Dana");
  });

  it("does not treat a generic opener as a name", () => {
    assert.equal(greetingNameIn("Hey there, quick note"), null);
    assert.equal(greetingNameIn("Hi team,"), null);
    assert.equal(greetingNameIn("Quick note on your page"), null);
  });
});

describe("fetch guard", () => {
  it("blocks private and off-domain targets", () => {
    assert.equal(isPrivateHost("127.0.0.1"), true);
    assert.equal(isPrivateHost("169.254.169.254"), true);
    assert.equal(isPrivateHost("10.1.2.3"), true);
    assert.equal(isPrivateHost("localhost"), true);
    assert.equal(isPrivateHost("example.com"), false);

    assert.equal(isFetchableOnDomain("https://northwind.com/about", "northwind.com"), true);
    assert.equal(isFetchableOnDomain("https://www.northwind.com/about", "northwind.com"), true);
    // An open redirect must not walk us onto another host.
    assert.equal(isFetchableOnDomain("https://evil.com/about", "northwind.com"), false);
    assert.equal(isFetchableOnDomain("http://127.0.0.1/about", "northwind.com"), false);
    assert.equal(isFetchableOnDomain("file:///etc/passwd", "northwind.com"), false);
  });
});

describe("html to text", () => {
  it("keeps block boundaries so signatures stay separate", () => {
    const text = htmlToText("<div><h1>Meet the team</h1><p>Dana Reeves</p><p>Founder</p></div>");
    assert.match(text, /Meet the team/);
    assert.match(text, /Dana Reeves/);
    assert.equal(text.includes("Meet the teamDana"), false);
  });

  it("drops scripts and styles", () => {
    const text = htmlToText("<script>var owner='Fake Name'</script><p>Real Text</p>");
    assert.doesNotMatch(text, /Fake Name/);
    assert.match(text, /Real Text/);
  });
});

function person(fullName: string, source: PersonCandidate["source"], confidence: PersonCandidate["confidence"]): PersonCandidate {
  const [firstName, ...rest] = fullName.split(" ");
  return {
    fullName,
    firstName: firstName!,
    lastName: rest.join(" ") || null,
    role: null,
    source,
    confidence,
    evidence: "test",
    foundOn: "test",
  };
}

describe("sentence fragments that look like names", () => {
  const domain = "wealthcreationclass.com";

  function people(text: string) {
    return extractIdentity({
      text,
      foundOn: `https://${domain}/registration`,
      domain,
      rootDomain: domain,
      brand: null,
    }).people;
  }

  it('does not read "This Is For You If" as a person', () => {
    // Verbatim from a live funnel. It was extracted as the person "For You If"
    // at high confidence, which would have opened the email "Hey For,".
    const found = people("Pass Down Wealth, Not Taxes - This Is For You If - You're approaching retirement");
    assert.deepEqual(found, [], `expected nothing, got ${found.map((p) => p.fullName).join(", ")}`);
  });

  it("rejects any candidate containing a function word", () => {
    for (const text of [
      "This Is What You Get when you join",
      "I'm Not Sure about that",
      "My name is The Best Program",
    ]) {
      assert.deepEqual(people(text), [], `should have rejected: ${text}`);
    }
  });

  it("still reads a genuine first-person introduction", () => {
    const found = people("Hi, I'm Shayne Ellis and I help investors buy their first property.");
    assert.equal(found[0]?.fullName, "Shayne Ellis");
    assert.equal(found[0]?.confidence, "high");
  });

  it('accepts "This is Dana Reeves" but only at medium', () => {
    const found = people("This is Dana Reeves, and welcome to the masterclass.");
    assert.equal(found[0]?.fullName, "Dana Reeves");
    // The phrase heads too many marketing sections to be trusted alone.
    assert.equal(found[0]?.confidence, "medium");
  });
});
