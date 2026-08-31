import { NextResponse } from "next/server";
import type { NormalizedAudit } from "@/lib/audit/normalize";
import type { GeneratedEmail } from "@/lib/email/validate";
import type { IdentityResult } from "@/lib/identity/types";
import { AppError, toAppError } from "@/lib/errors";
import { sheetsService, toRecord } from "@/lib/sheets/service";
import { requireSession } from "@/lib/auth/guard";

/**
 * "Save" for an approved email. Builds the operational record and hands it to
 * the Sheets service. While Sheets is unconfigured the service is a no-op and
 * the record is returned to the caller so the UI can still show what WOULD be
 * written — no silent pretending that a row was created.
 */

/** Everything currently in the sheet. Empty (not an error) when unconfigured. */
export async function GET(): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const service = sheetsService();
    return NextResponse.json({
      ok: true,
      data: { records: await service.list(), configured: service.configured },
    });
  } catch (error) {
    return fail(toAppError(error));
  }
}

/**
 * Deletes one run.
 *
 * The confirmation lives in the UI, but this is what actually removes the
 * row — hiding it client-side would leave the bad data in the sheet and it
 * would reappear on the next refresh.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const url = new URL(request.url).searchParams.get("url");
    if (!url) throw new AppError("invalid_body", "url is required");

    const service = sheetsService();
    const removed = await service.remove(url);
    return NextResponse.json({ ok: true, data: { removed, configured: service.configured } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const body = (await request.json()) as {
      url?: unknown;
      audit?: unknown;
      email?: unknown;
      approved?: unknown;
      edited?: unknown;
      identity?: unknown;
      approvedEmail?: unknown;
      stage?: unknown;
      errorMessage?: unknown;
      warningCount?: unknown;
    };

    if (typeof body.url !== "string" || body.url.trim() === "") {
      throw new AppError("invalid_body", "url is required");
    }

    const record = toRecord({
      url: body.url,
      audit: (body.audit as NormalizedAudit | null) ?? null,
      email: (body.email as GeneratedEmail | null) ?? null,
      auditStatus: body.audit ? "complete" : "failed",
      emailStatus: body.approved ? "approved" : body.email ? "ready" : "pending",
      approved: body.approved === true,
      edited: body.edited === true,
      identity: (body.identity as IdentityResult | null) ?? null,
      approvedEmail: typeof body.approvedEmail === "string" ? body.approvedEmail : null,
      stage: typeof body.stage === "string" ? body.stage : undefined,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : null,
      warningCount: typeof body.warningCount === "number" ? body.warningCount : 0,
    });

    const service = sheetsService();
    const written = await service.upsert(record);

    return NextResponse.json({
      ok: true,
      data: { record: written, persisted: service.configured },
    });
  } catch (error) {
    return fail(toAppError(error));
  }
}

function fail(error: AppError): NextResponse {
  if (error.detail) console.error(`[records] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
