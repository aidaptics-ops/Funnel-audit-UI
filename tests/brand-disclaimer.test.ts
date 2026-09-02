import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractBrand } from "../src/lib/identity/brand";

/**
 * The live failure this file exists for.
 *
 * thetimeshift.cc/app carries the compliance boilerplate every Meta/Google ad
 * funnel is obliged to carry, and the brand extractor read "Google™" out of
 * the disclaimer and reported the business as Google — at high confidence.
 * That name was then handed to RocketReach, which returned Google's
 * executives instead of the funnel's owner.
 */
const FOOTER = `Laptop Franchise 242 | laptopfranchise242.com

Terms and Conditions | Privacy Policy

This site and the products and services offered on this site are not associated, affiliated, endorsed, or sponsored by Facebook, nor have they been reviewed tested, or certified by Facebook.
Any income or earnings examples are only estimates of what is possible. Individual results will vary depending on effort, experience, and market conditions.

This site is not a part of Google™ website or network of sites such as Youtube™ or any company owned by Google™ or Youtube™. Additionally this website is not endorsed by Google™ Youtube™ Inc. in any way. Google™ is a trademark for all their respective companies. Results not guaranteed; individual effort and market conditions apply.`;

describe("a funnel's compliance disclaimer is not its brand", () => {
  it("reads the real business from the footer, not the disclaimed platform", () => {
    const found = extractBrand({ text: FOOTER, domain: "thetimeshift.cc" });
    assert.equal(found.businessName, "Laptop Franchise 242");
    assert.equal(found.method, "name beside domain");
    assert.equal(found.confidence, "high");
  });

  it("never returns a platform named only to disclaim it", () => {
    const disclaimerOnly = `Get started today.

This site is not a part of Google™ website or network of sites such as Youtube™.
Google™ is a trademark for all their respective companies.`;
    const found = extractBrand({ text: disclaimerOnly, domain: "example.com" });
    assert.notEqual(found.businessName, "Google");
    assert.notEqual(found.businessName, "Youtube");
  });

  it("still trusts a trademark the page claims as its own", () => {
    const own = "Welcome to The Art of Wooing™ — the programme for growth.";
    const found = extractBrand({ text: own, domain: "artofwooing.com" });
    assert.equal(found.businessName, "The Art of Wooing");
    assert.equal(found.method, "trademark symbol");
  });

  it("refuses a name that does not match the domain beside it", () => {
    const mismatch = "Terms and Conditions | privacypolicy.com";
    const found = extractBrand({ text: mismatch, domain: "example.com" });
    assert.notEqual(found.method, "name beside domain");
  });
});
