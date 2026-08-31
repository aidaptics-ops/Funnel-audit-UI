import { NextResponse } from "next/server";
import { runAudit } from "@/lib/audit/client";
import { normalizeAudit } from "@/lib/audit/normalize";
import { readSnapshot } from "@/lib/client-knowledge/store";
import { buildEmailContext, selectExamples } from "@/lib/email/context";
import { generateEmail } from "@/lib/email/generate";
import { AppError, toAppError } from "@/lib/errors";
import { normalizeFunnelUrl } from "@/lib/url";
import { discoverIdentity } from "@/lib/identity/discover";
import { findOwner, type OwnerSearchResult } from "@/lib/research/pipeline";
import { meteredUsage, withMeter } from "@/lib/cost/meter";
import { addRunCost } from "@/lib/cost/store";
import { sheetsService, toRecord } from "@/lib/sheets/service";
import type { ContactCandidate } from "@/lib/contacts";
import type { NormalizedAudit } from "@/lib/audit/normalize";
import type { IdentityResult } from "@/lib/identity/types";
import type { GeneratedEmail } from "@/lib/email/validate";
import { resolveIdentity } from "@/lib/identity/resolve";
import { providerStatus } from "@/lib/llm/registry";
import { requireSession } from "@/lib/auth/guard";

/**
 * The orchestration endpoint. The browser never talks to the audit API or to
 * any model directly; it only ever calls this.
 *
 *   validate URL -> audit -> normalize -> build context -> generate email
 */

// An audit is 7-20s and the model adds more. Vercel Hobby caps at 60s; Pro and
// Fluid Compute allow up to 300. The audit API's own ceiling is 180s.
export const maxDuration = 300;

interface AnalyzeBody {
  url?: unknown;
  /** Skip email generation — used by the queue when only the audit is wanted. */
  skipEmail?: unknown;
  /**
   * The operator personally booked/bought/signed up on this funnel. Gates the
   * client's usual opening line, which the audit itself can never earn.
   */
  performedAction?: unknown;
  /** Skip the /about, /team, /contact fetches. */
  skipIdentity?: unknown;
  /** Operator-confirmed owner, which overrides every heuristic. */
  confirmedName?: unknown;
  confirmedEmail?: unknown;
  /**
   * Run the full contact-discovery chain before writing the email.
   *
   * Defaults to on, because knowing the recipient while writing is the point.
   * Set false for a bulk import where spending a web search and possibly a
   * Hunter credit on every URL is not wanted.
   */
  findOwner?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  let body: AnalyzeBody;
  try {
    body = (await request.json()) as AnalyzeBody;
  } catch {
    return fail(new AppError("invalid_body"));
  }

  /*
   * Everything below runs inside a cost meter.
   *
   * Each provider records what it spent at its own HTTP boundary, so this
   * scope is simply what says "those charges belong to this funnel". It has to
   * wrap the whole handler rather than only the happy path: a run that dies
   * after the founder research has still spent the searches.
   */
  return withMeter(async () => {
    // Held outside the try so a failure can still be filed against the funnel
    // it was for. Null only if the URL itself was the thing that was wrong,
    // in which case nothing has been spent yet.
    let funnelUrl: string | null = null;

    try {
      const url = normalizeFunnelUrl(body.url);
      funnelUrl = url.href;
      /*
       * The client's abort signal is deliberately NOT passed on.
       *
       * Now that queueing is durable, navigating away mid-run is ordinary
       * behaviour rather than a cancellation — and killing the audit there
       * would throw away work the operator expects to come back to, which is
       * the whole point of persisting the queue. The run finishes server-side
       * and writes its row; the browser reads it back on the next visit.
       * runAudit still has its own 175s timeout, and maxDuration bounds the
       * request, so nothing runs unbounded.
       */
      const audit = await runAudit(url.href);
      const normalized = normalizeAudit(audit.analysis, {
        jobId: audit.jobId,
        requestedUrl: url.href,
      });

      // Who owns this funnel. Runs before the email so the generator knows
      // whether it is allowed to use a first name at all.
      const identity = await discoverIdentity({
        landing: {
          finalUrl: normalized.finalUrl,
          domain: normalized.domain,
          rootDomain: normalized.domain,
          brand: normalized.brand,
          visibleText: audit.analysis.page?.visible_text?.text ?? "",
          pageTitle: normalized.pageTitle ?? null,
          copyrightHolders: audit.analysis.funnel?.business_identity?.copyright_holders ?? [],
          contactEmails: normalized.contact.emails,
          socialProfiles: (audit.analysis.funnel?.business_identity?.social_profiles ?? []).flatMap((profile) =>
            profile?.platform && profile?.url ? [{ platform: profile.platform, url: profile.url }] : [],
          ),
          jsonLd: (audit.analysis as { json_ld?: unknown[] }).json_ld ?? [],
        },
        followPages: body.skipIdentity !== true,
        confirmedName: typeof body.confirmedName === "string" ? body.confirmedName : null,
        confirmedEmail: typeof body.confirmedEmail === "string" ? body.confirmedEmail : null,
      }).catch((error: unknown) => {
        // Identity is an enhancement: never let it fail an otherwise good audit.
        console.error(`[analyze] identity resolution failed: ${describe(error)}`);
        return null;
      });

      /*
       * Contact discovery runs BEFORE the email, not after.
       *
       * The whole point is to know who the email is addressed to while writing
       * it. Doing this afterwards produced a nameless draft and a recipient
       * found later, which is the wrong way round.
       *
       * It is opt-out rather than opt-in (`findOwner: false`) because it spends
       * money — web searches, sometimes a Hunter credit, a NeverBounce check —
       * and a bulk import of fifty URLs should be able to skip it.
       */
      let ownerSearch: OwnerSearchResult | null = null;
      let contactIdentity = identity;

      // Gated on the ADDRESS, not the name. Knowing the founder is only half the
      // job — an earlier version skipped the search whenever a name had been
      // found on the page, and so never went looking for their email at all.
      // A known name also makes the search better, not redundant.
      const needsContact = Boolean(identity && !identity.ownerEmail);
      if (body.findOwner !== false && identity && needsContact) {
        ownerSearch = await findOwner({
          domain: identity.company.domain,
          companyName: identity.company.brand,
          legalEntity: identity.company.legalEntity,
          headline: normalized.headline,
          knownNames: identity.people.map((person) => person.fullName),
        }).catch((error: unknown) => {
          console.error(`[analyze] owner search failed: ${describe(error)}`);
          return null;
        });

        if (ownerSearch) {
          // Merged through the same resolver as everything else, so a researched
          // name still has to clear the bar before the email may use it.
          contactIdentity = resolveIdentity({
            people: [...identity.people, ...ownerSearch.people],
            emails: [
              ...identity.emails,
              ...ownerSearch.emails,
              ...(ownerSearch.chosen
                ? [
                    {
                      address: ownerSearch.chosen.address,
                      kind: /^(info|support|hello|contact|admin|team|sales)/.test(ownerSearch.chosen.address)
                        ? ("generic_inbox" as const)
                        : ("personal" as const),
                      source: "enrichment_provider" as const,
                      confidence: ownerSearch.chosen.verification.confirmed
                        ? ("high" as const)
                        : ("medium" as const),
                      evidence: `${ownerSearch.chosen.source} · ${ownerSearch.chosen.verification.summary}`,
                      foundOn: "owner search",
                      observed: true,
                    },
                  ]
                : []),
            ],
            // The PAGE wins. It states what the business calls itself; the
            // research name is a description assembled from search results and
            // arrives as things like "The Art of Wooing (Wooist) — Patrick Wu".
            brand: identity.company.brand ?? ownerSearch.companyName,
            legalEntity: identity.company.legalEntity,
            domain: identity.company.domain,
            rootDomain: identity.company.rootDomain,
            pagesChecked: identity.pagesChecked,
          });
        }
      }

      /*
       * Every address found, kept together.
       *
       * Approval happens later and often on another page, so the candidates have
       * to outlive this request. Holding them in the browser is exactly what made
       * a finished run vanish the moment the operator navigated away.
       */
      const contacts = collectContacts(ownerSearch, contactIdentity);

      if (body.skipEmail === true) {
        await persistRun({ url: url.href, audit: normalized, identity: contactIdentity, contacts, email: null });
        return NextResponse.json({
          ok: true,
          data: { audit: normalized, identity: contactIdentity, ownerSearch, contacts, email: null },
        });
      }

      // A failure to write the email must not discard a good audit: the operator
      // can still review the findings and regenerate.
      let email = null;
      let emailError: { code: string; message: string } | null = null;

      try {
        const snapshot = await readSnapshot();
        const context = buildEmailContext({
          audit: normalized,
          profile: snapshot.profile,
          examples: selectExamples(snapshot.emails, normalized.issues),
          operatorPerformedAction: body.performedAction === true,
          identity: contactIdentity,
        });
        const generated = await generateEmail(context);
        email = {
          ...generated.email,
          warnings: generated.warnings,
          regenerated: generated.regenerated,
          provider: generated.provider,
        };
      } catch (error) {
        const appError = toAppError(error);
        console.error(`[analyze] email generation failed: ${appError.code} ${appError.detail ?? ""}`);
        emailError = appError.toJSON();
      }

      // Written server-side the moment the analysis produces a result, so the
      // run exists whether or not the browser is still on the page.
      await persistRun({ url: url.href, audit: normalized, identity: contactIdentity, contacts, email });

      return NextResponse.json({
        ok: true,
        data: {
          audit: normalized,
          identity: contactIdentity,
          ownerSearch,
          contacts,
          email,
          emailError,
          provider: providerStatus(),
        },
      });
    } catch (error) {
      // A run that failed halfway still spent whatever it spent before it
      // failed. Recording it is the difference between an expenditure page
      // that reconciles with the provider dashboards and one that flatters us.
      if (funnelUrl) await addRunCost(funnelUrl, meteredUsage());
      return fail(toAppError(error));
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(error: AppError): NextResponse {
  // Detail is logged, never returned.
  if (error.detail) console.error(`[analyze] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}

/**
 * Everything discovered for this funnel, de-duplicated, with provenance.
 *
 * Nothing is filtered out for being unapproved or unverified — the operator
 * reviews the whole list and decides. Losing a candidate here would mean
 * losing it from the Runs page too.
 */
function collectContacts(
  search: OwnerSearchResult | null,
  identity: { emails?: { address: string; source: string; observed: boolean }[] } | null,
): ContactCandidate[] {
  const seen = new Map<string, ContactCandidate>();

  for (const candidate of search?.candidates ?? []) {
    seen.set(candidate.address.toLowerCase(), {
      address: candidate.address,
      source: candidate.source,
      verification: candidate.verification?.result ?? null,
      approved: false,
    });
  }

  // Addresses printed on the page itself, which the search never proposed.
  for (const email of identity?.emails ?? []) {
    const key = email.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, {
      address: email.address,
      source: email.source.replace(/_/g, " "),
      verification: null,
      approved: false,
    });
  }

  return [...seen.values()];
}

/** Never let a storage failure discard an analysis that already succeeded. */
async function persistRun(input: {
  url: string;
  audit: NormalizedAudit;
  identity: IdentityResult | null;
  contacts: ContactCandidate[];
  email: (GeneratedEmail & { warnings?: unknown[]; regenerated?: boolean; provider?: string }) | null;
}): Promise<void> {
  try {
    await sheetsService().upsert(
      toRecord({
        url: input.url,
        audit: input.audit,
        email: input.email,
        auditStatus: "complete",
        emailStatus: input.email ? "ready" : "pending",
        stage: "ready",
        identity: input.identity,
        contacts: input.contacts,
        warningCount: input.email?.warnings?.length ?? 0,
      }),
    );
  } catch (error) {
    console.error(`[analyze] could not persist the run: ${describe(error)}`);
  }

  // After the row exists, so the ledger merges into it rather than creating a
  // second one. Accumulates: re-analysing a funnel adds to what it has already
  // cost rather than replacing it.
  await addRunCost(input.url, meteredUsage());
}
