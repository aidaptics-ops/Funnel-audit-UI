/**
 * Pure HTML helpers, kept out of discover.ts so they are not behind
 * `server-only` — they have no server dependency and are worth testing directly.
 */

/** Enough of an HTML-to-text pass for name extraction. No parser needed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level tags become line breaks so signatures and headings stay apart.
    .replace(/<\/(p|div|h[1-6]|li|section|article|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hrefsFrom(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .slice(0, 300);
}
