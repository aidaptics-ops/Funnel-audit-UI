import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { AppError, toAppError } from "@/lib/errors";
import {
  AttachmentError,
  addSuppliedPage,
  listSuppliedPages,
  removeSuppliedPage,
} from "@/lib/attachments/store";

/**
 * Screenshots the operator took himself, attached to a run.
 *
 * The audit stops at the landing page, so a confirmation or thank-you page is
 * unobservable and the generator is forbidden from describing one. This is how
 * that changes: he books the call, photographs what he sees, and the page
 * becomes evidence like any other.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const url = new URL(request.url).searchParams.get("url");
    if (!url) throw new AppError("invalid_body", "url is required");
    return NextResponse.json({ ok: true, data: { pages: await listSuppliedPages(url) } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    // multipart rather than base64 JSON: a 5MB screenshot is 6.7MB once
    // base64'd, and the browser can post the file as-is.
    const form = await request.formData().catch(() => null);
    if (!form) throw new AppError("invalid_body", "expected a multipart form");

    const url = form.get("url");
    const file = form.get("file");
    if (typeof url !== "string" || !url.trim()) throw new AppError("invalid_body", "url is required");
    if (!(file instanceof File)) throw new AppError("invalid_body", "file is required");

    const label = typeof form.get("label") === "string" ? String(form.get("label")) : "";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const page = await addSuppliedPage({ url, label, bytes });

    return NextResponse.json({ ok: true, data: { page, pages: await listSuppliedPages(url) } });
  } catch (error) {
    if (error instanceof AttachmentError) {
      // These are the operator's own mistakes and the message is safe to show.
      return NextResponse.json({ ok: false, error: { code: error.kind, message: error.message } }, { status: 400 });
    }
    return fail(toAppError(error));
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const params = new URL(request.url).searchParams;
    const url = params.get("url");
    const id = params.get("id");
    if (!url || !id) throw new AppError("invalid_body", "url and id are required");

    const removed = await removeSuppliedPage(url, id);
    return NextResponse.json({ ok: true, data: { removed, pages: await listSuppliedPages(url) } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

function fail(error: AppError): NextResponse {
  if (error.detail) console.error(`[attachments] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
