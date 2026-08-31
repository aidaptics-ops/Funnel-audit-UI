/**
 * The identity of a run.
 *
 * A funnel URL arrives in several shapes depending on where it was copied
 * from — with Facebook click ids, a UTM block, a trailing slash. Keying a row
 * on the raw string files one funnel as several unrelated runs, which is how
 * thefinallover.com ended up in the sheet twice with different data in each.
 *
 * Deliberately NOT the same normalisation the crawler uses. That one keeps
 * every parameter, because a query string can genuinely change the page it
 * fetches. This one is about identity: two links to the same page that differ
 * only by ad tracking are the same run.
 */

/**
 * Parameters that identify a click, not a page.
 *
 * Only known trackers are removed. An unrecognised parameter is kept, because
 * "?variant=b" may well be a different landing page and merging those two
 * would silently overwrite one run with the other.
 */
const TRACKING = [
  /^utm_/i,
  /^fb(cl|c_|p_)/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^ttclid$/i,
  /^twclid$/i,
  /^igshid$/i,
  /^mc_(c|e)id$/i,
  /^_ga$/i,
  /^_gl$/i,
  /^ref$/i,
  /^referrer$/i,
  /^(ad|adset|campaign|creative|placement)_id$/i,
  /^h_ad_id$/i,
  /^sid$/i,
  /^srsltid$/i,
  /^wickedid$/i,
  /^hsa_/i,
  /^li_fat_id$/i,
  /^epik$/i,
  /^s_kwcid$/i,
];

export function runKey(url: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return raw;

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    // Unparseable input is still addressable, just not normalised.
    return raw;
  }

  for (const name of [...parsed.searchParams.keys()]) {
    if (TRACKING.some((pattern) => pattern.test(name))) parsed.searchParams.delete(name);
  }
  // Stable order, so ?a=1&b=2 and ?b=2&a=1 are one run rather than two.
  parsed.searchParams.sort();

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // A trailing slash is not a different page, but "/" alone is the root.
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");

  return parsed.toString();
}
