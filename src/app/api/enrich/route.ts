import { NextResponse } from "next/server";
import { HunterError, hunterAccount, hunterDomainSearch, isHunterConfigured } from "@/lib/enrichment/hunter";
import {
  RocketReachError,
  isRocketReachConfigured,
  rocketReachAccount,
  rocketReachLookup,
  rocketReachSearch,
} from "@/lib/enrichment/rocketreach";
import { hasOwnerCandidate, type RrProfile } from "@/lib/enrichment/rocketreach-map";
import { findOwner, type OwnerSearchResult } from "@/lib/research/pipeline";
import { resolveIdentity } from "@/lib/identity/resolve";
import type { EmailCandidate, IdentityResult, PersonCandidate } from "@/lib/identity/types";
import { AppError, toAppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";

/**
 * Contact discovery, priced honestly.
 *
 * Three distinct operations, because they cost three different things and the
 * operator should never have to guess which one they are about to spend:
 *
 *   rocketreach_search  free            names, titles, LinkedIn — no addresses
 *   hunter              1 of 50/month   addresses published on the web
 *   rocketreach_lookup  1 of 3/month    one named person's address
 *
 * None runs automatically. The free path — the site's own /about and /team
 * pages — already ran during the audit, and most funnels never need more.
 *
 * Every result is merged back through the same resolveIdentity() the free path
 * uses, so no provider gets special authority: a name still needs the site
 * itself to agree before it can be used unattended.
 */

/** The owner search makes real web searches; it is the slowest route here. */
export const maxDuration = 300;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

type Provider = "auto" | "find_owner" | "hunter" | "rocketreach_search" | "rocketreach_lookup";

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const body = (await request.json().catch(() => null)) as {
      identity?: unknown;
      provider?: unknown;
      profileId?: unknown;
      headline?: unknown;
      force?: unknown;
      rejectedEmails?: unknown;
      confirmedEmail?: unknown;
    } | null;

    const provider = asProvider(body?.provider);
    const identity = asIdentity(body?.identity);
    const domain = identity.company.domain.toLowerCase().replace(/^www\./, "");
    if (!HOSTNAME.test(domain)) {
      throw new AppError("invalid_body", "identity.company.domain is not a hostname");
    }

    const force = body?.force === true;
    const people: PersonCandidate[] = [];
    const emails: EmailCandidate[] = [];
    let profiles: RrProfile[] = [];
    let note = "";
    let legalEntity = identity.company.legalEntity;
    let companyName: string | null = identity.company.brand;
    let company = null as Awaited<ReturnType<typeof hunterDomainSearch>>["company"] | null;
    let hunterFoundOwner = false;
    let search: OwnerSearchResult | null = null;

    /**
     * The full chain: company -> founder -> address -> verification.
     *
     * Establishing the NAME from the open web first is what makes the contact
     * databases useful on small businesses — it turns "who works here?", which
     * they cannot answer for a two-person coaching company, into "what is this
     * person's address?", which they often can.
     */
    if (provider === "find_owner") {
      search = await findOwner({
        domain,
        companyName: identity.company.brand,
        legalEntity: identity.company.legalEntity,
        headline: typeof body?.headline === "string" ? body.headline : null,
        knownNames: identity.people.map((person) => person.fullName),
      });

      people.push(...search.people);
      emails.push(...search.emails);
      companyName = search.companyName ?? companyName;

      // A verified address enters as observed and confirmed — it is the one
      // thing here that was checked against the mail server itself.
      if (search.chosen) {
        emails.push({
          address: search.chosen.address,
          kind: /^(info|support|hello|contact|admin|team|sales)/.test(search.chosen.address)
            ? "generic_inbox"
            : "personal",
          source: "enrichment_provider",
          confidence: search.chosen.verification.confirmed ? "high" : "medium",
          evidence: `${search.chosen.source} · ${search.chosen.verification.summary}`,
          foundOn: "owner search",
          observed: true,
        });
      }

      note = search.reason;
    }

    /**
     * The chained path, and the one the UI offers by default.
     *
     * Hunter first because it is the only provider that returns an ADDRESS
     * from a domain alone. RocketReach follows only when Hunter produced no
     * owner-shaped person — its search costs nothing, so there is no reason
     * not to try, and its names corroborate whatever the site itself said.
     * Neither step buys a RocketReach address; that stays a separate click.
     */
    if (provider === "auto" || provider === "hunter") {
      if (!isHunterConfigured()) throw new AppError("enrichment_unavailable", "HUNTER_API_KEY is not set");
      const lookup = await hunterDomainSearch(domain, { force });
      people.push(...lookup.people);
      emails.push(...lookup.emails);
      legalEntity = legalEntity ?? lookup.company?.legalName ?? lookup.organization;
      companyName = lookup.company?.name ?? lookup.organization ?? null;
      company = lookup.company;

      const named = lookup.people.length;
      const cost = lookup.cached
        ? "cached"
        : lookup.creditSpent
          ? "1 credit"
          : "free, nothing indexed for this domain";
      note = `Hunter (${cost}) — ${named} name(s), ${lookup.emails.length} address(es)`;
      hunterFoundOwner = lookup.ownerAddress !== null;
    }

    const shouldFallBack =
      provider === "rocketreach_search" ||
      (provider === "auto" && !hunterFoundOwner && isRocketReachConfigured());

    if (shouldFallBack) {
      if (!isRocketReachConfigured()) {
        throw new AppError("enrichment_unavailable", "ROCKETREACH_API_KEY is not set");
      }
      const found = await rocketReachSearch(domain, { force, companyName });
      people.push(...found.people);
      profiles = found.profiles;

      const summary = `RocketReach (${found.cached ? "cached" : "free"}) — ${found.profiles.length} profile(s), no addresses`;
      note = provider === "auto" ? `${note} · no owner, so ${summary}` : summary;

      if (provider === "auto" && hasOwnerCandidate(found.profiles)) {
        note += " — an owner-shaped profile is available for a paid lookup";
      }
    }

    if (provider === "rocketreach_lookup") {
      if (!isRocketReachConfigured()) {
        throw new AppError("enrichment_unavailable", "ROCKETREACH_API_KEY is not set");
      }
      const profileId = Number(body?.profileId);
      if (!Number.isInteger(profileId) || profileId <= 0) {
        throw new AppError("invalid_body", "profileId is required for a RocketReach lookup");
      }

      const result = await rocketReachLookup(profileId, domain, { force });
      if (!result.complete) {
        // RocketReach queues some lookups. Saying so beats returning an empty
        // result that looks like "this person has no email".
        throw new AppError("enrichment_pending", `lookup status: ${result.status}`);
      }
      if (result.person) people.push(result.person);
      emails.push(...result.emails);
      note = result.cached
        ? `RocketReach lookup — cached, no credit used · ${result.emails.length} address(es)`
        : `RocketReach lookup — 1 credit · ${result.emails.length} address(es)`;
    }

    const merged = resolveIdentity({
      people: [...identity.people, ...people],
      emails: [...identity.emails, ...emails],
      brand: identity.company.brand ?? companyName,
      legalEntity,
      domain: identity.company.domain,
      rootDomain: identity.company.rootDomain,
      pagesChecked: [...new Set([...identity.pagesChecked, note])],
      confirmedName: identity.owner?.confidence === "confirmed" ? identity.owner.fullName : null,
      confirmedEmail: typeof body?.confirmedEmail === "string" ? body.confirmedEmail : null,
      // Carried through so a lookup cannot re-offer an address the operator
      // already refused for this funnel.
      rejectedEmails: Array.isArray(body?.rejectedEmails)
        ? body.rejectedEmails.filter((entry): entry is string => typeof entry === "string")
        : [],
    });

    return NextResponse.json({
      ok: true,
      data: {
        identity: merged,
        provider,
        note,
        profiles,
        company,
        search,
        credits: await credits(),
      },
    });
  } catch (error) {
    if (error instanceof HunterError || error instanceof RocketReachError) {
      const code =
        error.kind === "no_credits"
          ? "enrichment_exhausted"
          : error.kind === "pending"
            ? "enrichment_pending"
            : "enrichment_failed";
      return fail(new AppError(code, error.message));
    }
    return fail(toAppError(error));
  }
}

/** Both balances, so the UI can price the next click without another request. */
async function credits(): Promise<{
  hunter: number | null;
  rocketreach: number | null;
}> {
  const [hunter, rocket] = await Promise.all([
    hunterAccount().catch(() => null),
    rocketReachAccount().catch(() => null),
  ]);
  return {
    hunter: hunter?.creditsRemaining ?? null,
    rocketreach: rocket?.lookupsRemaining ?? null,
  };
}

function asProvider(value: unknown): Provider {
  if (
    value === "auto" ||
    value === "find_owner" ||
    value === "hunter" ||
    value === "rocketreach_search" ||
    value === "rocketreach_lookup"
  ) {
    return value;
  }
  throw new AppError(
    "invalid_body",
    'provider must be "auto", "find_owner", "hunter", "rocketreach_search" or "rocketreach_lookup"',
  );
}

/** Enough of a shape check to know we are merging into a real identity. */
function asIdentity(value: unknown): IdentityResult {
  if (!value || typeof value !== "object") {
    throw new AppError("invalid_body", "identity must be an object");
  }
  const candidate = value as Partial<IdentityResult>;
  if (!candidate.company || typeof candidate.company.domain !== "string") {
    throw new AppError("invalid_body", "identity.company.domain is required");
  }
  return {
    ...(candidate as IdentityResult),
    people: Array.isArray(candidate.people) ? candidate.people : [],
    emails: Array.isArray(candidate.emails) ? candidate.emails : [],
    pagesChecked: Array.isArray(candidate.pagesChecked) ? candidate.pagesChecked : [],
  };
}

function fail(error: AppError): NextResponse {
  if (error.detail) console.error(`[enrich] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
