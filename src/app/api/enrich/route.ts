import { NextResponse } from "next/server";
import { HunterError, hunterAccount, hunterDomainSearch, isHunterConfigured } from "@/lib/enrichment/hunter";
import {
  RocketReachError,
  isRocketReachConfigured,
  rocketReachAccount,
  rocketReachLookup,
  rocketReachSearch,
} from "@/lib/enrichment/rocketreach";
import type { RrProfile } from "@/lib/enrichment/rocketreach-map";
import { resolveIdentity } from "@/lib/identity/resolve";
import type { EmailCandidate, IdentityResult, PersonCandidate } from "@/lib/identity/types";
import { AppError, toAppError } from "@/lib/errors";

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

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

type Provider = "hunter" | "rocketreach_search" | "rocketreach_lookup";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => null)) as {
      identity?: unknown;
      provider?: unknown;
      profileId?: unknown;
      force?: unknown;
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

    if (provider === "hunter") {
      if (!isHunterConfigured()) throw new AppError("enrichment_unavailable", "HUNTER_API_KEY is not set");
      const lookup = await hunterDomainSearch(domain, { force });
      people.push(...lookup.people);
      emails.push(...lookup.emails);
      legalEntity = legalEntity ?? lookup.organization;
      note = lookup.cached
        ? "Hunter — cached, no credit used"
        : `Hunter — 1 credit · ${lookup.people.length} name(s), ${lookup.emails.length} address(es)`;
    }

    if (provider === "rocketreach_search") {
      if (!isRocketReachConfigured()) {
        throw new AppError("enrichment_unavailable", "ROCKETREACH_API_KEY is not set");
      }
      const found = await rocketReachSearch(domain, { force });
      people.push(...found.people);
      profiles = found.profiles;
      note = found.cached
        ? `RocketReach search — cached · ${found.profiles.length} profile(s)`
        : `RocketReach search — free · ${found.profiles.length} profile(s), no addresses`;
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
      brand: identity.company.brand,
      legalEntity,
      domain: identity.company.domain,
      rootDomain: identity.company.rootDomain,
      pagesChecked: [...new Set([...identity.pagesChecked, note])],
      confirmedName: identity.owner?.confidence === "confirmed" ? identity.owner.fullName : null,
      rejectedEmails: [],
    });

    return NextResponse.json({
      ok: true,
      data: {
        identity: merged,
        provider,
        note,
        profiles,
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
  if (value === "hunter" || value === "rocketreach_search" || value === "rocketreach_lookup") return value;
  throw new AppError(
    "invalid_body",
    'provider must be "hunter", "rocketreach_search" or "rocketreach_lookup"',
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
