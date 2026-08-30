import { NextResponse } from "next/server";
import { runAudit } from "@/lib/audit/client";
import { normalizeAudit } from "@/lib/audit/normalize";
import { readSnapshot } from "@/lib/client-knowledge/store";
import { buildEmailContext, selectExamples } from "@/lib/email/context";
import { generateEmail } from "@/lib/email/generate";
import { AppError, toAppError } from "@/lib/errors";
import { normalizeFunnelUrl } from "@/lib/url";
import { discoverIdentity } from "@/lib/identity/discover";
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

  try {
    const url = normalizeFunnelUrl(body.url);
    const audit = await runAudit(url.href, request.signal);
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

    if (body.skipEmail === true) {
      return NextResponse.json({ ok: true, data: { audit: normalized, identity, email: null } });
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
        identity,
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

    return NextResponse.json({
      ok: true,
      data: {
        audit: normalized,
        identity,
        email,
        emailError,
        provider: providerStatus(),
      },
    });
  } catch (error) {
    return fail(toAppError(error));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(error: AppError): NextResponse {
  // Detail is logged, never returned.
  if (error.detail) console.error(`[analyze] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
