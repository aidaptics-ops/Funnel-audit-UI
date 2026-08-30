import { NextResponse } from "next/server";
import type { NormalizedAudit } from "@/lib/audit/normalize";
import { readSnapshot } from "@/lib/client-knowledge/store";
import { buildEmailContext, selectExamples } from "@/lib/email/context";
import { generateEmail } from "@/lib/email/generate";
import { AppError, toAppError } from "@/lib/errors";

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
  let body: { audit?: unknown; performedAction?: unknown; identity?: unknown; confirmedName?: unknown };
  try {
    body = (await request.json()) as {
      audit?: unknown;
      performedAction?: unknown;
      identity?: unknown;
      confirmedName?: unknown;
    };
  } catch {
    return fail(new AppError("invalid_body"));
  }

  try {
    const audit = asNormalizedAudit(body.audit);
    const snapshot = await readSnapshot();
    const context = buildEmailContext({
      audit,
      profile: snapshot.profile,
      examples: selectExamples(snapshot.emails, audit.issues),
      operatorPerformedAction: body.performedAction === true,
      identity: (body.identity as never) ?? null,
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
  }
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
