import { NextResponse } from "next/server";
import { runAudit, type AuditResult } from "@/lib/audit/client";
import { readSnapshot } from "@/lib/client-knowledge/store";
import { buildEmailContext, selectExamples } from "@/lib/email/context";
import { generateEmail } from "@/lib/email/generate";
import { AppError, toAppError } from "@/lib/errors";
import { config } from "@/lib/config";
import { discoverIdentity } from "@/lib/identity/discover";
import { findOwner, type OwnerSearchResult } from "@/lib/research/pipeline";
import { meteredUsage, withMeter } from "@/lib/cost/meter";
import { addRunCost } from "@/lib/cost/store";
import { RUN_OVERWRITE, sheetsService, toRecord } from "@/lib/sheets/service";
import type { ContactCandidate } from "@/lib/contacts";
import type { NormalizedAudit } from "@/lib/audit/normalize";
import type { IdentityResult } from "@/lib/identity/types";
import type { GeneratedEmail } from "@/lib/email/validate";
import { resolveIdentity } from "@/lib/identity/resolve";
import { providerStatus } from "@/lib/llm/registry";
import { requireSession } from "@/lib/auth/guard";
import { readSuppliedImages } from "@/lib/attachments/store";
import { analyzeFunnel, type FunnelAnalysisOutcome } from "@/lib/analysis/analyze";
import { guardFunnelUrl, runFunnelPipeline } from "@/lib/analysis/orchestrate";
import type { NormalizedUrl } from "@/lib/url";

/**
 * The orchestration endpoint. The browser never talks to the audit API or to
 * any model directly; it only ever calls this.
 *
 *   validate the URL
 *     -> crawl the landing page
 *     -> ( two-page analysis )  ‖  ( identity -> owner )
 *     -> apply the verified findings
 *     -> the post-booking screenshot gate
 *     -> generate the email, or say why it was not written
 *     -> persist
 *
 * The decisions live in `lib/analysis/orchestrate`, which has no server-only
 * imports and is therefore testable; this file is the wiring plus the identity
 * chain, which stays here because it is what the founder pipeline reads.
 *
 * There is deliberately no second URL here at all. The page after conversion
 * is never crawled — the only source of evidence for it is a screenshot the
 * operator uploads through /api/attachments, which this route reads back but
 * never fetches itself.
 */

/*
 * WHAT BOUNDS THIS REQUEST, AND WHAT DOES NOT.
 *
 * `maxDuration` is a Vercel deployment hint, not a runtime timeout: the
 * primary deployment here is self-hosted Next.js in Docker behind Dokploy
 * (docs/DOKPLOY.md), where nothing reads it and the only real ceilings are the
 * reverse proxy's idle timeout and the per-stage clocks below. On Vercel it
 * still matters — Hobby caps functions at 60s and would kill this run whatever
 * this says.
 *
 * The comment this replaces conflated two different numbers. The audit API's
 * own 180s ceiling is real and unchanged (config.audit.timeoutMs sits just
 * under it at 175s); the 300 was the Vercel plan cap, not that ceiling.
 *
 * The two-page analysis stage is NOT a single 240s budget. analyzeFunnel
 * (src/lib/analysis/analyze.ts) gives its JSON-repair retry a FRESH,
 * independent AbortSignal.timeout(analysisTimeoutMs) rather than sharing
 * whatever was left of the first attempt's — that sharing is what starved the
 * repair path in production. The honest worst case for the stage is therefore
 * up to two full budgets back to back, not one:
 *
 *   landing audit                175s  (config.audit.timeoutMs)
 * + two-page analysis        up to 300s  (2 × config.llm.analysisTimeoutMs —
 *                                          first attempt, then an equally-
 *                                          budgeted repair retry, only when
 *                                          the first parses as broken JSON)
 * + email                  up to 240s  (2 × config.llm.emailTimeoutMs — a draft
 *                                          and one corrective pass, each with
 *                                          its OWN deadline. It used to inherit
 *                                          the SDK client ceiling, which is
 *                                          sized for the analysis; at 300s that
 *                                          made the cheapest stage able to eat
 *                                          the entire route budget by itself.)
 *   -----------------------------------
 *                          up to 715s
 *
 * (The identity/founder-research leg runs concurrently with the analysis leg,
 * not after it, so it does not add to this chain — see runFunnelPipeline.)
 * Every one of those is a WORST case that only fires on a retry. A healthy
 * run measured 2m38s end to end, and the analysis call alone measured 23.5s
 * against the live model. maxDuration covers the pathological path.
 */
export const maxDuration = 750;

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

/** What the identity leg produces. */
interface IdentityLeg {
  identity: IdentityResult | null;
  ownerSearch: OwnerSearchResult | null;
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
      const landing: NormalizedUrl = guardFunnelUrl(body.url);
      funnelUrl = landing.href;

      /*
       * The identity chain, lifted out of the sequence unchanged.
       *
       * Every line inside is what ran before, in the same order, reading the
       * same fields — the only difference is that it now runs alongside the
       * two-page analysis instead of after it. The founder pipeline is a
       * product requirement that works; this phase is not allowed to alter
       * it, and does not.
       */
      const identityChain = async (audit: AuditResult, normalized: NormalizedAudit): Promise<IdentityLeg> => {
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
            // Top level first, exactly as before. `json_ld` has never been
            // declared on RawAnalysis — it is read through the index
            // signature — so the fallback to the evidence section is what
            // keeps the founder extractor fed if the API only emits it there.
            jsonLd:
              (audit.analysis as { json_ld?: unknown[] }).json_ld ?? audit.analysis.raw_evidence?.json_ld ?? [],
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

        return { identity: contactIdentity, ownerSearch };
      };

      /*
       * The client's abort signal is deliberately NOT passed on.
       *
       * Now that queueing is durable, navigating away mid-run is ordinary
       * behaviour rather than a cancellation — and killing the audit there
       * would throw away work the operator expects to come back to, which is
       * the whole point of persisting the queue. The run finishes server-side
       * and writes its row; the browser reads it back on the next visit. Every
       * stage carries its own clock, so nothing runs unbounded.
       */
      const run = await runFunnelPipeline<IdentityLeg>(
        {
          runAudit,
          analyzeFunnel,
          suppliedPostBooking: async (url) =>
            (await readSuppliedImages(url)).map((page) => ({
              label: page.label,
              mediaType: page.mediaType,
              data: page.data,
            })),
          identity: identityChain,
          // Its own budget, not the shared LLM one: that ceiling is the email
          // generator's and doubling it would double the email stage's worst
          // case too.
          analysisTimeoutMs: config.llm.analysisTimeoutMs,
        },
        landing,
      );

      const normalized = run.audit;
      const contactIdentity = run.identity.identity;
      const ownerSearch = run.identity.ownerSearch;

      /*
       * Every address found, kept together.
       *
       * Approval happens later and often on another page, so the candidates have
       * to outlive this request. Holding them in the browser is exactly what made
       * a finished run vanish the moment the operator navigated away.
       */
      const contacts = collectContacts(ownerSearch, contactIdentity);
      const blocked = run.gate.allowed ? null : { reason: run.gate.reason, message: run.gate.message };

      if (body.skipEmail === true) {
        await persistRun({
          url: landing.href,
          audit: normalized,
          auditStatus: run.auditStatus,
          identity: contactIdentity,
          contacts,
          email: null,
          reason: run.reasons[0] ?? null,
        });
        return NextResponse.json({
          ok: true,
          data: {
            audit: normalized,
            identity: contactIdentity,
            ownerSearch,
            contacts,
            email: null,
            emailBlocked: blocked,
            reasons: run.reasons,
            auditStatus: run.auditStatus,
            analysis: analysisSummary(run.analysis, run.degraded),
          },
        });
      }

      // A failure to write the email must not discard a good audit: the operator
      // can still review the findings and regenerate.
      let email = null;
      let emailError: { code: string; message: string } | null = null;

      /*
       * THE GATE.
       *
       * Evaluated inside the pipeline from this run's own server-side state —
       * what is on disk for this run. Nothing the browser sent is consulted.
       */
      if (run.gate.allowed) {
        try {
          const snapshot = await readSnapshot();
          const context = buildEmailContext({
            audit: normalized,
            profile: snapshot.profile,
            examples: selectExamples(snapshot.emails, normalized.issues),
            operatorPerformedAction: body.performedAction === true,
            identity: contactIdentity,
            // The pictures, so a "no form on the page" finding can be checked
            // against a page that plainly has one.
            screenshot: run.landingScreenshot,
            // Carried across a re-analysis: he uploaded them once and should not
            // have to do it again every time the funnel is run.
            supplied: (await readSuppliedImages(landing.href)).map((page) => ({
              label: page.label,
              mediaType: page.mediaType,
              data: page.data,
            })),
            // How the two pages relate, when the two-page analysis actually ran.
            relationshipSummary: run.analysis?.result.relationshipSummary ?? null,
            relationship: run.analysis?.relationship ?? null,
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
      } else {
        console.warn(`[analyze] email withheld: ${run.gate.reason}`);
        /*
         * Mirrored into emailError so today's browser still says so.
         *
         * Nothing failed here — the run completed and is waiting on a
         * screenshot — but the deployed queue is what writes error_message
         * onto the row and what puts a notice on screen, and it reads only
         * this field. Without the mirror the operator is shown a run with no
         * email and no reason, which is the one outcome D1 exists to prevent.
         *
         * TODO (next phase — the email UI): render `emailBlocked` and delete
         * this mirror, so a blocked run stops being described as a failure.
         */
        emailError = { code: run.gate.reason ?? "post_booking_evidence_required", message: run.gate.message };
      }

      // Written server-side the moment the analysis produces a result, so the
      // run exists whether or not the browser is still on the page.
      await persistRun({
        url: landing.href,
        audit: normalized,
        auditStatus: run.auditStatus,
        identity: contactIdentity,
        contacts,
        email,
        reason: emailError?.message ?? run.reasons[0] ?? null,
      });

      return NextResponse.json({
        ok: true,
        data: {
          audit: normalized,
          identity: contactIdentity,
          ownerSearch,
          contacts,
          email,
          emailError,
          /*
           * Why no email exists, when none does.
           *
           * Separate from emailError because nothing failed: the run completed,
           * and it is waiting on a screenshot. The message is also mirrored into
           * `reasons` and onto the row, so an operator who never opens this
           * response still sees what is being asked of them.
           */
          emailBlocked: blocked,
          reasons: run.reasons,
          auditStatus: run.auditStatus,
          analysis: analysisSummary(run.analysis, run.degraded),
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
 * What the analysis did, small enough to send.
 *
 * The outcome itself carries both rendered evidence indexes — hundreds of
 * kilobytes of page inventory — and none of that belongs in a JSON response.
 * What an operator needs is what survived, what was thrown away and why, and
 * what the model could not check.
 */
function analysisSummary(
  run: FunnelAnalysisOutcome | null,
  degraded: string | null,
): {
  ran: boolean;
  degraded: string | null;
  kept: number;
  dropped: { id: string; title: string; reason: string; detail: string }[];
  unverifiable: string[];
  relationshipSummary: string | null;
  repaired: boolean;
} {
  return {
    ran: run !== null,
    degraded,
    kept: run?.verification.kept.length ?? 0,
    dropped: (run?.verification.dropped ?? []).map((entry) => ({
      id: entry.finding.id,
      title: entry.finding.title,
      reason: entry.reason,
      detail: entry.detail,
    })),
    unverifiable: run?.result.unverifiableNotes ?? [],
    relationshipSummary: run?.result.relationshipSummary ?? null,
    repaired: run?.repaired ?? false,
  };
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
  auditStatus: "complete" | "incomplete";
  identity: IdentityResult | null;
  contacts: ContactCandidate[];
  email: (GeneratedEmail & { warnings?: unknown[]; regenerated?: boolean; provider?: string }) | null;
  /** The one sentence the row should carry about why it is not finished. */
  reason: string | null;
}): Promise<void> {
  try {
    await sheetsService().upsert(
      toRecord({
        url: input.url,
        audit: input.audit,
        email: input.email,
        auditStatus: input.auditStatus,
        emailStatus: input.email ? "ready" : "pending",
        stage: "ready",
        identity: input.identity,
        contacts: input.contacts,
        warningCount: input.email?.warnings?.length ?? 0,
        errorMessage: input.reason,
      }),
      { overwrite: RUN_OVERWRITE },
    );
  } catch (error) {
    console.error(`[analyze] could not persist the run: ${describe(error)}`);
  }

  // After the row exists, so the ledger merges into it rather than creating a
  // second one. Accumulates: re-analysing a funnel adds to what it has already
  // cost rather than replacing it.
  await addRunCost(input.url, meteredUsage());
}
