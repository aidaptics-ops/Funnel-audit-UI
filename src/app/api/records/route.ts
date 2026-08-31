import { NextResponse } from "next/server";
import type { NormalizedAudit } from "@/lib/audit/normalize";
import type { GeneratedEmail } from "@/lib/email/validate";
import type { IdentityResult } from "@/lib/identity/types";
import { AppError, toAppError } from "@/lib/errors";
import { queuedRecord, sheetsService, toRecord } from "@/lib/sheets/service";
import { approveOne, clearApproval, parseContacts, serializeContacts } from "@/lib/contacts";
import { emptyRecord } from "@/lib/sheets/types";
import { runKey } from "@/lib/sheets/key";
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
    const raw = new URL(request.url).searchParams.get("url");
    if (!raw) throw new AppError("invalid_body", "url is required");

    // The normalised key first, then the raw string. Rows written before
    // keying existed hold the URL exactly as it was pasted, and without the
    // fallback those legacy rows would be impossible to delete.
    const service = sheetsService();
    const key = runKey(raw);
    let removed = await service.remove(key);
    if (!removed && key !== raw) removed = await service.remove(raw);
    return NextResponse.json({ ok: true, data: { removed, configured: service.configured } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

/**
 * Approves (or un-approves) one candidate address on an existing run.
 *
 * A focused write rather than a full upsert: the caller may be the Runs page,
 * which holds a run summary and not the audit that produced it. Approval is
 * persisted here — keeping it in component state is what let it evaporate on
 * navigation.
 */
export async function PATCH(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      approveEmail?: unknown;
      /** Claims the row for this tab while it runs. */
      stage?: unknown;
    } | null;

    if (typeof body?.url !== "string" || !body.url.trim()) {
      throw new AppError("invalid_body", "url is required");
    }

    const service = sheetsService();
    const key = runKey(body.url);

    /*
     * A stage claim, written the moment a funnel starts analysing.
     *
     * Its job is to stop a second browser tab picking the same queued row off
     * the sheet and paying for the same analysis twice. Deliberately a tiny
     * write with no read: it must not slow down the start of the run.
     */
    if (typeof body.stage === "string" && body.stage) {
      const claim = emptyRecord();
      claim.funnel_url = key;
      claim.stage = body.stage;
      claim.updated_at = new Date().toISOString();
      await service.upsert(claim, { overwrite: ["stage"] });
      return NextResponse.json({ ok: true, data: { stage: body.stage, persisted: service.configured } });
    }

    const rows = await service.list();
    const existing = rows.find((row) => row.funnel_url === key);
    if (!existing) throw new AppError("not_found", "no run for that URL");

    // Null clears the approval; a string sets it. Either way the full
    // candidate list is preserved so the operator can change their mind.
    const contacts = parseContacts(existing.contacts_json);
    const updated =
      typeof body.approveEmail === "string" && body.approveEmail.trim()
        ? approveOne(contacts, body.approveEmail)
        : clearApproval(contacts);

    const approved = updated.find((entry) => entry.approved)?.address ?? "";

    // Only the fields that changed. upsert merges, so blank cells keep
    // whatever the row already had.
    const patch = emptyRecord();
    patch.funnel_url = key;
    patch.contacts_json = serializeContacts(updated);
    patch.owner_email = approved;
    patch.owner_email_approved = approved ? "true" : "false";
    patch.updated_at = new Date().toISOString();

    // owner_email must be writable to blank, or un-approving leaves the old
    // address behind and the row still claims a decision was made.
    await service.upsert(patch, { overwrite: ["owner_email", "owner_email_approved", "contacts_json"] });
    return NextResponse.json({
      ok: true,
      data: { approved: approved || null, contacts: updated, persisted: service.configured },
    });
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
      urls?: unknown;
      performedAction?: unknown;
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

    /*
     * Queueing, made durable.
     *
     * The queue used to live only in the tab that created it, so closing the
     * page — or just clicking through to Runs — threw away everything still
     * waiting. Writing the rows here means the work exists on the server
     * before the operator can navigate anywhere, and the page picks it back up
     * on load.
     */
    if (Array.isArray(body.urls)) {
      const performedAction = body.performedAction === true;
      const records = body.urls
        .filter((url): url is string => typeof url === "string" && url.trim() !== "")
        .map((url) => queuedRecord(url, performedAction));

      const service = sheetsService();
      const added = await service.appendMany(records);
      return NextResponse.json({
        ok: true,
        data: { added, queued: records.length, persisted: service.configured },
      });
    }

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
      performedAction: typeof body.performedAction === "boolean" ? body.performedAction : undefined,
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
