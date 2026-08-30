import { registrableDomain } from "./url";

/**
 * A compact SSRF guard for the fetches this app makes itself.
 *
 * The audit API performs the authoritative check for the funnel URL — it is
 * the thing that opens a browser. But identity discovery fetches /about and
 * /team server-side from here, so those requests need their own guard. The
 * surface is deliberately narrow: fixed paths, on the funnel's own registrable
 * domain, over http(s) only, with the final URL re-checked after redirects.
 */

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^19[28]\.0\.[02]\./,
  /^198\.1[89]\./,
  /^203\.0\.113\./,
  /^(22[4-9]|23\d|24\d|25[0-5])\./,
];

const PRIVATE_HOSTNAME =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal|.*\.home\.arpa)$/i;

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (PRIVATE_HOSTNAME.test(host)) return true;

  // IPv6 loopback / unique-local / link-local.
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;

  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — check the embedded address.
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const target = mapped?.[1] ?? host;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
    return PRIVATE_V4.some((pattern) => pattern.test(target));
  }
  return false;
}

/**
 * A URL is fetchable only when it is public http(s) AND stays on the domain we
 * were already analysing. That second condition is what makes a redirect
 * harmless: an open redirect cannot walk us onto another host.
 */
export function isFetchableOnDomain(candidate: string, expectedDomain: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (isPrivateHost(url.hostname)) return false;

  const expected = registrableDomain(expectedDomain);
  return expected !== "" && registrableDomain(url.hostname) === expected;
}
