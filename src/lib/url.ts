import { AppError } from "./errors";

/**
 * A first-pass URL check that runs before we spend a request on the audit API.
 *
 * The audit API performs the authoritative SSRF check (it is the thing that
 * actually opens a browser). This is the cheap, friendly version: it catches
 * typos and obvious mistakes in the UI, and normalises what we send upstream.
 */
const MAX_LENGTH = 2048;

export interface NormalizedUrl {
  href: string;
  hostname: string;
  domain: string;
}

export function normalizeFunnelUrl(input: unknown): NormalizedUrl {
  if (typeof input !== "string" || input.trim() === "") {
    throw new AppError("invalid_url");
  }

  let raw = input.trim();
  if (raw.length > MAX_LENGTH) throw new AppError("url_too_long");

  // People paste "example.com/offer" far more often than they type a scheme.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("unsupported_scheme");
  }
  if (url.username || url.password) throw new AppError("credentials_not_allowed");
  if (!url.hostname || !url.hostname.includes(".")) throw new AppError("invalid_url");

  return {
    href: url.toString(),
    hostname: url.hostname,
    domain: registrableDomain(url.hostname),
  };
}

/** Same simple approximation the audit API uses, kept in step deliberately. */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "gob", "govt", "asn"]);

export function registrableDomain(hostname: string): string {
  const host = (hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;

  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const second = parts[parts.length - 2] ?? "";
  return SECOND_LEVEL.has(second) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

/** Splits pasted text or CSV text into candidate URLs, deduped, order kept. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const rawLine of text.split(/[\r\n,;]+/)) {
    const line = rawLine.trim().replace(/^["']|["']$/g, "");
    if (!line) continue;
    // Skip a CSV header cell like "funnel_url" or "url".
    if (/^[a-z_ ]+$/i.test(line) && !line.includes(".")) continue;

    try {
      const { href } = normalizeFunnelUrl(line);
      if (seen.has(href)) continue;
      seen.add(href);
      out.push(href);
    } catch {
      // Not a URL: ignore the cell rather than failing the whole import.
    }
  }

  return out;
}
