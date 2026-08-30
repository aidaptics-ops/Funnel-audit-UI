import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsvEmails, parsePastedEmails, parseUpload } from "../src/lib/client-knowledge/ingest";
import { extractUrls, normalizeFunnelUrl, registrableDomain } from "../src/lib/url";

describe("bulk URL extraction", () => {
  it("takes one URL per line, adds a scheme, and dedupes", () => {
    const urls = extractUrls("https://example.com/a\nexample.com/b\n\nhttps://example.com/a\n");
    assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"]);
  });

  it("survives CSV text and header cells", () => {
    const urls = extractUrls("funnel_url,notes\nhttps://example.com/offer,first\nhttps://two.com,second");
    assert.ok(urls.includes("https://example.com/offer"));
    assert.ok(urls.includes("https://two.com/"));
    assert.equal(urls.some((url) => url.includes("notes")), false);
  });

  it("ignores lines that are not URLs rather than failing the import", () => {
    assert.deepEqual(extractUrls("just some words\nnot a url"), []);
  });
});

describe("URL validation", () => {
  it("accepts and normalises a bare domain", () => {
    assert.equal(normalizeFunnelUrl("example.com/offer").href, "https://example.com/offer");
  });

  it("rejects non-http schemes and credentials", () => {
    assert.throws(() => normalizeFunnelUrl("file:///etc/passwd"), /http/i);
    assert.throws(() => normalizeFunnelUrl("https://user:pass@example.com"), /username|password/i);
  });

  it("rejects junk", () => {
    for (const value of ["", "   ", "not-a-url", 42, null, undefined]) {
      assert.throws(() => normalizeFunnelUrl(value as unknown));
    }
  });

  it("computes the registrable domain the same way the audit API does", () => {
    assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
    assert.equal(registrableDomain("www.example.com"), "example.com");
    assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");
  });
});

describe("client email ingestion", () => {
  const long = (text: string): string => `${text} ${"padding words to clear the minimum length ".repeat(2)}`;

  it("splits pasted emails on a --- separator", () => {
    const emails = parsePastedEmails(
      `${long("Hey Mark - first email here.")}\n---\n${long("Hi Sarah - second email here.")}`,
      { source: "paste" },
    );
    assert.equal(emails.length, 2);
  });

  it("splits on blank-line runs when there is no separator", () => {
    const emails = parsePastedEmails(`${long("First message body.")}\n\n\n${long("Second message body.")}`, {
      source: "paste",
    });
    assert.equal(emails.length, 2);
  });

  it("keeps one email as one sample despite paragraph breaks", () => {
    const emails = parsePastedEmails(`${long("Opening line.")}\n\n${long("Second paragraph.")}`, {
      source: "paste",
    });
    assert.equal(emails.length, 1);
  });

  it("lifts a leading Subject: line out of the body", () => {
    const emails = parsePastedEmails(`Subject: quick note\n${long("Hey - body text here.")}`, { source: "paste" });
    assert.equal(emails[0]!.subject, "quick note");
    assert.equal(emails[0]!.body.includes("Subject:"), false);
  });

  it("drops fragments too short to be writing samples", () => {
    assert.deepEqual(parsePastedEmails("hi", { source: "paste" }), []);
  });

  it("reads a CSV by column name, not position", () => {
    const csv = [
      "id,body,subject",
      `1,"${long("Hey Mark - noticed your form asks for seven fields.")}","first"`,
      `2,"${long("Hi Sarah - the headline promises a checklist.")}","second"`,
    ].join("\n");

    const emails = parseCsvEmails(csv, { source: "csv" });
    assert.equal(emails.length, 2);
    assert.equal(emails[0]!.subject, "first");
    assert.ok(emails[0]!.body.includes("seven fields"));
  });

  it("handles quoted CSV fields containing commas and newlines", () => {
    const csv = `body\n"${long("Line one, with a comma.")}\nLine two."`;
    const emails = parseCsvEmails(csv, { source: "csv" });
    assert.equal(emails.length, 1);
    assert.ok(emails[0]!.body.includes("Line two."));
  });

  it("routes uploads by extension and content", () => {
    const csv = `body,subject\n"${long("A CSV row body.")}",x`;
    assert.equal(parseUpload("samples.csv", csv).length, 1);
    assert.equal(parseUpload("samples.txt", long("A plain text email.")).length, 1);
  });
});
