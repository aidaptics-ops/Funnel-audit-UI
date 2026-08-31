import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractBrand, repairMojibake } from "../src/lib/identity/brand";

/**
 * Business-name extraction, tested against the funnel that defeated the
 * previous version outright.
 *
 * Its footer is the whole reason this module exists, so it leads.
 */

/** Verbatim from the live audit payload, mojibake and all. */
const FINAL_LOVER_FOOTER =
  "Created by Patrick Wu - High performance love coach helping growth-minded men attract and keep their dream partner.\n" +
  "@â€”2026 Patrick Wu - The Art of Wooing\n" +
  "Helping growth-minded men attract and keep a love that stays";

describe("the funnel that previously returned nothing", () => {
  const found = extractBrand({
    text: FINAL_LOVER_FOOTER,
    domain: "thefinallover.com",
    auditBrand: null,
    copyrightHolders: [],
    pageTitle: null,
  });

  it("finds the business, not the person", () => {
    assert.equal(found.businessName, "The Art of Wooing");
  });

  it("keeps the person separately rather than confusing the two", () => {
    // "Patrick Wu - The Art of Wooing" packs a human and a company into one
    // line. Reading the human as the company sends the founder search hunting
    // for a business called Patrick Wu.
    assert.equal(found.personName, "Patrick Wu");
  });

  it("quotes the line it used", () => {
    assert.match(found.evidence ?? "", /The Art of Wooing/);
  });

  it("does not fall back to the domain", () => {
    assert.notEqual(found.businessName?.toLowerCase(), "thefinallover");
  });
});

describe("mojibake", () => {
  it("repairs UTF-8 that was decoded as Latin-1", () => {
    assert.equal(repairMojibake("Patrickâ€™s"), "Patrick’s");
    assert.equal(repairMojibake("Â© 2026"), "© 2026");
  });

  it("leaves clean text untouched", () => {
    for (const text of ["© 2026 Acme Ltd", "Plain ASCII", "Café Ltd"]) {
      assert.equal(repairMojibake(text), text);
    }
  });
});

describe("copyright shapes seen in the wild", () => {
  const read = (text: string, domain = "example.com") =>
    extractBrand({ text, domain, auditBrand: null, copyrightHolders: [], pageTitle: null });

  it("reads a plain company copyright", () => {
    assert.equal(read("© 2026 RealSide Real Estate. All Rights Reserved.").businessName, "RealSide Real Estate");
  });

  it("keeps a legal suffix and reports it", () => {
    const found = read("Copyright 2026 WCLIVE LLC");
    assert.equal(found.legalEntity, "WCLIVE LLC");
    assert.equal(found.businessName, "WCLIVE");
  });

  it("reads a trademarked name as the brand", () => {
    assert.equal(read("Welcome to The Charmer's Compass™ today").businessName, "The Charmer's Compass");
  });

  it("strips 'All Rights Reserved' from the name", () => {
    assert.equal(read("© 2026 Acme Media All Rights Reserved").businessName, "Acme Media");
  });

  it("handles a year range", () => {
    assert.equal(read("© 2019-2026 Northwind Trading").businessName, "Northwind Trading");
  });

  it("treats a sole trader as both person and business", () => {
    const found = read("© 2026 Dana Reeves");
    assert.equal(found.businessName, "Dana Reeves");
    assert.equal(found.personName, "Dana Reeves");
  });
});

describe("what must NOT be treated as a business name", () => {
  const read = (text: string, domain = "example.com") =>
    extractBrand({ text, domain, auditBrand: null, copyrightHolders: [], pageTitle: null });

  it("rejects a tagline", () => {
    assert.equal(read("© 2026 Helping growth-minded men attract a partner").businessName, null);
  });

  it("rejects page furniture", () => {
    assert.equal(read("© 2026 All Rights Reserved").businessName, null);
  });

  it("rejects the bare domain", () => {
    assert.equal(read("© 2026 example", "example.com").businessName, null);
  });

  it("returns nothing rather than guessing when the page says nothing", () => {
    const found = read("Get the free guide. Download now. Limited spots.");
    assert.equal(found.businessName, null);
    assert.equal(found.confidence, "low");
  });
});

describe("fallbacks, in order", () => {
  it("prefers the audit's own copyright extraction", () => {
    const found = extractBrand({
      text: "nothing useful here",
      domain: "acme.com",
      copyrightHolders: ["© 2026 Acme Holdings Ltd"],
      auditBrand: "Something Else",
      pageTitle: null,
    });
    assert.equal(found.legalEntity, "Acme Holdings Ltd");
    assert.equal(found.method, "audit copyright_holders");
  });

  it("falls back to the page title, marked low confidence", () => {
    const found = extractBrand({
      text: "no copyright anywhere",
      domain: "acme.com",
      auditBrand: null,
      copyrightHolders: [],
      pageTitle: "Free Guide | Northwind Trading",
    });
    assert.equal(found.businessName, "Northwind Trading");
    assert.equal(found.confidence, "low");
  });
});
