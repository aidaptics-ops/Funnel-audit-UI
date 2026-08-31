import "server-only";
import { isFetchableOnDomain } from "../ssrf";
import { hrefsFrom, htmlToText } from "./html";
import { extractBrand, type BrandFinding } from "./brand";
import { extractIdentity, legalEntityFrom, type Extraction } from "./extract";
import { resolveIdentity } from "./resolve";
import { emptyIdentity, type IdentityResult } from "./types";

/**
 * Owner names are rarely on the landing page — that page sells, it does not
 * introduce anyone. They live on /about, /team and /contact.
 *
 * So after the audit, we fetch a small, fixed set of same-domain pages over
 * plain HTTP (no browser: these pages are almost always server-rendered, and a
 * second browser session per funnel would double the cost of the run).
 *
 * Every URL goes through the same SSRF guard the audit uses. Failures are
 * silent by design — a missing /about is the normal case, not an error.
 */

/** Ordered by how often they actually name a human. */
const CANDIDATE_PATHS = [
  "/about",
  "/about-us",
  "/our-story",
  "/team",
  "/meet-the-team",
  "/contact",
  "/contact-us",
];

const MAX_PAGES = 4;
const PER_PAGE_TIMEOUT_MS = 6000;
const MAX_BYTES = 600_000;

export interface DiscoverInput {
  /** Everything the audit already extracted from the landing page. */
  landing: {
    finalUrl: string;
    domain: string;
    rootDomain: string;
    brand: string | null;
    pageTitle?: string | null;
    visibleText: string;
    copyrightHolders: string[];
    contactEmails: string[];
    socialProfiles: { platform: string; url: string }[];
    jsonLd?: unknown[];
  };
  /** Set false to skip the extra fetches entirely. */
  followPages: boolean;
  confirmedName?: string | null;
  confirmedEmail?: string | null;
}

export async function discoverIdentity(input: DiscoverInput): Promise<IdentityResult> {
  const { landing } = input;
  if (!landing.domain) return emptyIdentity(landing.domain, landing.rootDomain);

  const extractions: Extraction[] = [];
  const pagesChecked: string[] = [];

  // 1. Whatever the audit already saw on the landing page.
  const landingLinks = [
    ...landing.contactEmails.map((address) => `mailto:${address}`),
    ...landing.socialProfiles.map((profile) => profile.url),
  ];

  extractions.push(
    extractIdentity({
      text: landing.visibleText,
      foundOn: landing.finalUrl,
      domain: landing.domain,
      rootDomain: landing.rootDomain,
      brand: landing.brand,
      links: landingLinks,
      jsonLd: landing.jsonLd,
    }),
  );

  // 2. The pages that actually introduce people.
  if (input.followPages) {
    for (const page of await fetchCandidatePages(landing.finalUrl, landing.domain)) {
      pagesChecked.push(page.url);
      extractions.push(
        extractIdentity({
          text: page.text,
          foundOn: page.url,
          domain: landing.domain,
          rootDomain: landing.rootDomain,
          brand: landing.brand,
          links: page.links,
        }),
      );
    }
  }

  /*
   * The business name is settled FIRST, and by a dedicated reader.
   *
   * Everything after this depends on it: a founder search for the wrong
   * company finds the wrong person. The old path took whatever the audit
   * called the brand and moved on, which on a funnel whose footer read
   * "@â€"2026 Patrick Wu - The Art of Wooing" produced nothing at all.
   */
  const brand: BrandFinding = extractBrand({
    text: landing.visibleText,
    auditBrand: landing.brand,
    copyrightHolders: landing.copyrightHolders,
    pageTitle: landing.pageTitle ?? null,
    domain: landing.domain,
  });

  const legalEntity =
    brand.legalEntity ??
    extractions.map((entry) => entry.legalEntity).find(Boolean) ??
    landing.copyrightHolders.map(legalEntityFrom).find(Boolean) ??
    null;

  // A person named in the copyright line is the owner stating it themselves —
  // stronger than a signature and independent of the /about page.
  const people = extractions.flatMap((entry) => entry.people);
  if (brand.personName) {
    const parsed = brand.personName.split(/\s+/).filter(Boolean);
    people.push({
      fullName: brand.personName,
      firstName: parsed[0] ?? brand.personName,
      lastName: parsed.length > 1 ? parsed.slice(1).join(" ") : null,
      role: null,
      source: "copyright_line",
      confidence: "high",
      evidence: brand.evidence ?? `Named in the copyright line: ${brand.personName}`,
      foundOn: landing.finalUrl,
    });
  }

  return resolveIdentity({
    people,
    emails: extractions.flatMap((entry) => entry.emails),
    brand: brand.businessName ?? landing.brand,
    legalEntity,
    domain: landing.domain,
    rootDomain: landing.rootDomain,
    pagesChecked,
    confirmedName: input.confirmedName ?? null,
    confirmedEmail: input.confirmedEmail ?? null,
  });
}

interface FetchedPage {
  url: string;
  text: string;
  links: string[];
}

async function fetchCandidatePages(baseUrl: string, domain: string): Promise<FetchedPage[]> {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    return [];
  }

  const pages: FetchedPage[] = [];
  // Many funnels answer every one of these paths with the same page. Reading
  // it more than once wastes fetches, and — worse — turns one page into
  // several apparent sources, which is exactly what corroboration is supposed
  // to rule out. Both the destination URL and its content are deduplicated.
  const seenUrls = new Set<string>([normalizeUrl(baseUrl)]);
  const seenText = new Set<string>();

  for (const path of CANDIDATE_PATHS) {
    if (pages.length >= MAX_PAGES) break;

    const target = new URL(path, origin.origin).toString();
    // Public http(s), and on the domain we were already analysing.
    if (!isFetchableOnDomain(target, domain)) continue;
    if (seenUrls.has(normalizeUrl(target))) continue;

    const page = await fetchPage(target, domain);
    if (!page) continue;

    // The URL we asked for and the URL we landed on both count as visited.
    seenUrls.add(normalizeUrl(target));
    const settled = normalizeUrl(page.url);
    if (seenUrls.has(settled)) continue;
    seenUrls.add(settled);

    const print = fingerprint(page.text);
    if (seenText.has(print)) continue;
    seenText.add(print);

    pages.push(page);
  }

  return pages;
}

/** Compares destinations, not spellings: scheme, trailing slash and query differ freely. */
function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/** Cheap content identity, enough to spot the same page served twice. */
function fingerprint(text: string): string {
  const normal = text.replace(/\s+/g, " ").trim().toLowerCase();
  return `${normal.length}:${normal.slice(0, 300)}`;
}

async function fetchPage(url: string, domain: string): Promise<FetchedPage | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; FunnelOutreach/1.0)" },
      cache: "no-store",
    });

    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return null;

    // Re-check after redirects: an open redirect must not walk us off-domain.
    if (!isFetchableOnDomain(response.url, domain)) return null;
    // A landing page redirected to itself tells us nothing new.
    if (new URL(response.url).pathname === "/") return null;

    const html = (await response.text()).slice(0, MAX_BYTES);
    return { url: response.url, text: htmlToText(html), links: hrefsFrom(html) };
  } catch {
    // A missing or slow /about is the normal case, not a failure worth raising.
    return null;
  }
}
