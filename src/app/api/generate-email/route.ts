import { NextResponse } from "next/server";
import type { NormalizedAudit } from "@/lib/audit/normalize";
import { readSnapshot } from "@/lib/client-knowledge/store";
import { buildEmailContext, selectExamples } from "@/lib/email/context";
import { generateEmail } from "@/lib/email/generate";
import { AppError, toAppError } from "@/lib/errors";
import { meteredUsage, withMeter } from "@/lib/cost/meter";
import { addRunCost } from "@/lib/cost/store";
import { requireSession } from "@/lib/auth/guard";
import { readSuppliedImages } from "@/lib/attachments/store";

/**
 * Regenerate an email from an audit the browser already holds, without paying
 * for another crawl.
 *
 * The body carries the NORMALIZED audit that /api/analyze returned. It is
 * shape-checked before use: the evidence set the model is allowed to draw on
 * is derived from this object, so a malformed payload must be rejected rather
 * than silently producing an email with no evidence behind it.
 */
export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  let body: {
    audit?: unknown;
    performedAction?: unknown;
    identity?: unknown;
    confirmedName?: unknown;
    url?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(new AppError("invalid_body"));
  }

  return withMeter(async () => {
    try {
      const audit = asNormalizedAudit(body.audit);
      const snapshot = await readSnapshot();

      // Pages the operator photographed himself, if he has attached any. This
      // is the whole point of the rewrite: the confirmation page he could show
      // us but the crawler could never reach.
      const supplied =
        typeof body.url === "string" && body.url ? await readSuppliedImages(body.url) : [];

      const context = buildEmailContext({
        audit,
        profile: snapshot.profile,
        examples: selectExamples(snapshot.emails, audit.issues),
        operatorPerformedAction: body.performedAction === true,
        identity: (body.identity as never) ?? null,
        supplied: supplied.map((page) => ({
          label: page.label,
          mediaType: page.mediaType,
          data: page.data,
        })),
      });

      const generated = await generateEmail(context);
      return NextResponse.json({
        ok: true,
        data: {
          ...generated.email,
          warnings: generated.warnings,
          regenerated: generated.regenerated,
          provider: generated.provider,
        },
      });
    } catch (error) {
      return fail(toAppError(error));
    } finally {
      /*
       * Rewriting an email is another model call and another bill, so it is
       * added to what this lead has already cost rather than going unrecorded.
       * In `finally` because a generation that failed after the model answered
       * was still charged.
       *
       * `url` identifies the funnel row, and must be the URL the run was filed
       * under. The audit's own finalUrl is deliberately not used as a fallback
       * — it is the address after redirects, which keys a different row and
       * would file the spend against a funnel that does not exist.
       */
      if (typeof body.url === "string" && body.url) await addRunCost(body.url, meteredUsage());
    }
  });
}

/** Minimal structural check — enough to know the evidence set will be real. */
function asNormalizedAudit(value: unknown): NormalizedAudit {
  if (!value || typeof value !== "object") {
    throw new AppError("invalid_body", "audit must be an object");
  }
  const candidate = value as Partial<NormalizedAudit>;
  if (typeof candidate.finalUrl !== "string" || !Array.isArray(candidate.issues)) {
    throw new AppError("invalid_body", "audit is not a normalized audit payload");
  }
  if (!candidate.observability || typeof candidate.observability !== "object") {
    throw new AppError("invalid_body", "audit is missing its observability block");
  }
  // postBookingObserved is the guardrail's switch: never accept it as true.
  return {
    ...(candidate as NormalizedAudit),
    observability: { ...candidate.observability, postBookingObserved: false, formSubmissionObserved: false },
  };
}

function fail(error: AppError): NextResponse {
  if (error.detail) console.error(`[generate-email] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
