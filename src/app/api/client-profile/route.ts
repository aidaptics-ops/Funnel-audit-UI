import { NextResponse } from "next/server";
import { buildClientProfile } from "@/lib/client-knowledge/profile";
import { readSnapshot } from "@/lib/client-knowledge/store";
import { AppError, toAppError } from "@/lib/errors";

/** Derives the client voice + diagnostic profile from the stored emails. */
export const maxDuration = 300;

export async function GET(): Promise<NextResponse> {
  try {
    const snapshot = await readSnapshot();
    return NextResponse.json({ ok: true, data: { profile: snapshot.profile, sampleCount: snapshot.emails.length } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const snapshot = await readSnapshot();
    if (snapshot.emails.length === 0) {
      throw new AppError("invalid_body", "add at least one email before building a profile");
    }
    const profile = await buildClientProfile(snapshot.emails);
    return NextResponse.json({ ok: true, data: { profile } });
  } catch (error) {
    return fail(toAppError(error));
  }
}

function fail(error: AppError): NextResponse {
  if (error.detail) console.error(`[client-profile] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
