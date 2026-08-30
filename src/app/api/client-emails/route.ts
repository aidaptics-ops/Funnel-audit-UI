import { NextResponse } from "next/server";
import { parseCsvEmails, parsePastedEmails, parseUpload } from "@/lib/client-knowledge/ingest";
import { addEmails, clearEmails, readSnapshot, removeEmail, knowledgeStore } from "@/lib/client-knowledge/store";
import { AppError, toAppError } from "@/lib/errors";

/** The client email library: list, add (paste/upload), remove, clear. */

export async function GET(): Promise<NextResponse> {
  try {
    const snapshot = await readSnapshot();
    const store = knowledgeStore();
    return NextResponse.json({
      ok: true,
      data: {
        count: snapshot.emails.length,
        emails: snapshot.emails.map((email) => ({
          id: email.id,
          subject: email.subject,
          preview: email.body.slice(0, 200),
          words: email.body.split(/\s+/).filter(Boolean).length,
          source: email.source,
          addedAt: email.addedAt,
          tag: email.tag,
        })),
        profile: snapshot.profile,
        storage: { kind: store.kind, durable: store.durable },
      },
    });
  } catch (error) {
    return fail(toAppError(error));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const contentType = request.headers.get("content-type") ?? "";

    // File upload (.txt / .csv)
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const tag = asString(form.get("tag"));
      const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) throw new AppError("invalid_body", "no files supplied");

      const parsed = [];
      for (const file of files) {
        const text = await file.text();
        parsed.push(...parseUpload(file.name, text, tag));
      }
      if (parsed.length === 0) throw new AppError("invalid_body", "no usable emails found in the upload");

      const snapshot = await addEmails(parsed);
      return NextResponse.json({ ok: true, data: { added: parsed.length, count: snapshot.emails.length } });
    }

    // Pasted text
    const body = (await request.json()) as { text?: unknown; format?: unknown; tag?: unknown };
    const text = asString(body.text);
    if (!text) throw new AppError("invalid_body", "text is required");

    const tag = asString(body.tag);
    const emails =
      body.format === "csv"
        ? parseCsvEmails(text, { source: "csv", tag })
        : parsePastedEmails(text, { source: "paste", tag });

    if (emails.length === 0) {
      throw new AppError("invalid_body", "nothing in that text looked like an email sample");
    }

    const snapshot = await addEmails(emails);
    return NextResponse.json({ ok: true, data: { added: emails.length, count: snapshot.emails.length } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const id = new URL(request.url).searchParams.get("id");
    const snapshot = id ? await removeEmail(id) : await clearEmails();
    return NextResponse.json({ ok: true, data: { count: snapshot.emails.length } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function fail(error: AppError): NextResponse {
  if (error.detail) console.error(`[client-emails] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
