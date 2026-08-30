/**
 * The contact-enrichment seam. Not implemented — Hunter and RocketReach are
 * explicitly out of scope for now.
 *
 * What matters today is that the audit already extracts everything an
 * enrichment provider needs (domain, brand, organisation names, any emails
 * printed on the page) into `audit.contact` and `funnel.business_identity`,
 * and that this interface exists for a provider to satisfy later.
 *
 * All implementations MUST run server-side only. Enrichment API keys must
 * never be exposed to the browser under any circumstance.
 */

export interface EnrichmentQuery {
  domain: string;
  companyName?: string | null;
  /** Emails already visible on the page — often enough to skip a lookup. */
  knownEmails?: string[];
}

export interface EnrichedContact {
  ownerName: string | null;
  ownerEmail: string | null;
  role: string | null;
  confidence: number | null;
  source: string;
}

export interface EnrichmentProvider {
  readonly id: string;
  isConfigured(): boolean;
  findOwner(query: EnrichmentQuery): Promise<EnrichedContact | null>;
}

/**
 * Until a provider is wired, this returns whatever the page itself exposed.
 * That is genuinely useful: many funnel footers list a real contact address.
 */
export function contactFromPage(query: EnrichmentQuery): EnrichedContact | null {
  const email = query.knownEmails?.find((candidate) => !/^(info|support|hello|admin|noreply)@/i.test(candidate));
  const fallback = query.knownEmails?.[0];
  const chosen = email ?? fallback;
  if (!chosen) return null;

  return {
    ownerName: null,
    ownerEmail: chosen,
    role: null,
    confidence: email ? 0.4 : 0.2,
    source: "page_footer",
  };
}
