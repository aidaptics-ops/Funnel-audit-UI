import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import { runKey } from "../sheets/key";

/**
 * Pages the operator photographed himself.
 *
 * The audit renders exactly one page and never converts, so everything past
 * the opt-in — the confirmation page, the thank-you page, the booking
 * screen — is invisible to it. That is also where a lot of the client's best
 * material lives, which is why the system has an elaborate set of rules for
 * raising those stages without describing them.
 *
 * This is the way out of that bind. If the operator books the call himself and
 * screenshots what he sees, the page stops being unobservable and becomes
 * ordinary evidence. The guardrail that forbids describing a confirmation page
 * exists because we could not see one; when one of these is present for a run,
 * that premise no longer holds and the rule steps aside.
 *
 * Stored on the durable volume rather than in the spreadsheet: a single strip
 * is ~230KB, and a sheet cell tops out at 50,000 characters.
 */

/** Claude's own per-image ceiling. Anything larger is rejected, not resized. */
const MAX_BYTES = 5 * 1024 * 1024;

/** Enough for a confirmation page and a couple of follow-up screens. */
export const MAX_PER_RUN = 4;

export interface SuppliedPage {
  id: string;
  /** What the operator says this is — "confirmation page", "booking screen". */
  label: string;
  mediaType: string;
  bytes: number;
  addedAt: string;
}

export interface SuppliedImage extends SuppliedPage {
  /** Base64, ready for an image block. */
  data: string;
}

/**
 * Magic bytes, because a browser-supplied MIME type is a claim, not a fact.
 * Only formats a vision model actually accepts are allowed through.
 */
function sniff(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "image/gif";
  return null;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** One directory per run. Hashed, so a URL can never escape the folder. */
function runDir(url: string): string {
  const key = createHash("sha1").update(runKey(url)).digest("hex").slice(0, 24);
  return resolve(process.cwd(), config.storage.dir, "attachments", key);
}

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly kind: "too_large" | "unsupported" | "too_many" = "unsupported",
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Saves one screenshot against a run. Returns the stored record. */
export async function addSuppliedPage(input: {
  url: string;
  label: string;
  bytes: Uint8Array;
}): Promise<SuppliedPage> {
  if (input.bytes.byteLength > MAX_BYTES) {
    throw new AttachmentError("That image is larger than 5MB.", "too_large");
  }

  const mediaType = sniff(input.bytes);
  if (!mediaType) {
    throw new AttachmentError("That file is not a PNG, JPEG or WebP image.", "unsupported");
  }

  const existing = await listSuppliedPages(input.url);
  if (existing.length >= MAX_PER_RUN) {
    throw new AttachmentError(`A run can hold ${MAX_PER_RUN} screenshots.`, "too_many");
  }

  const dir = runDir(input.url);
  await mkdir(dir, { recursive: true });

  // Content-addressed, so uploading the same screenshot twice is idempotent
  // rather than filling the run with duplicates of one page.
  const id = createHash("sha1").update(input.bytes).digest("hex").slice(0, 16);
  const record: SuppliedPage = {
    id,
    label: cleanLabel(input.label),
    mediaType,
    bytes: input.bytes.byteLength,
    addedAt: new Date().toISOString(),
  };

  await writeFile(join(dir, `${id}.${EXTENSIONS[mediaType]}`), input.bytes);
  await writeFile(join(dir, `${id}.json`), JSON.stringify(record), "utf8");
  return record;
}

export async function listSuppliedPages(url: string): Promise<SuppliedPage[]> {
  try {
    const dir = runDir(url);
    const names = await readdir(dir);
    const records: SuppliedPage[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(dir, name), "utf8");
        const parsed = JSON.parse(raw) as SuppliedPage;
        if (parsed?.id && parsed.mediaType) records.push(parsed);
      } catch {
        // One unreadable manifest must not hide the rest.
      }
    }
    return records.sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  } catch {
    // No directory means no screenshots, which is the normal case.
    return [];
  }
}

/** The images themselves, ready to attach to a model call. */
export async function readSuppliedImages(url: string): Promise<SuppliedImage[]> {
  const records = await listSuppliedPages(url);
  const dir = runDir(url);
  const images: SuppliedImage[] = [];

  for (const record of records) {
    try {
      const bytes = await readFile(join(dir, `${record.id}.${EXTENSIONS[record.mediaType]}`));
      images.push({ ...record, data: bytes.toString("base64") });
    } catch {
      // A manifest whose image is gone is skipped rather than fatal.
    }
  }
  return images;
}

export async function removeSuppliedPage(url: string, id: string): Promise<boolean> {
  // The id comes from the browser, so it must never reach a path unchecked.
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  const dir = runDir(url);
  const records = await listSuppliedPages(url);
  const record = records.find((entry) => entry.id === id);
  if (!record) return false;

  await rm(join(dir, `${record.id}.${EXTENSIONS[record.mediaType]}`), { force: true });
  await rm(join(dir, `${record.id}.json`), { force: true });
  return true;
}

/** Everything for a run, for when the run itself is deleted. */
export async function removeAllSuppliedPages(url: string): Promise<void> {
  await rm(runDir(url), { recursive: true, force: true }).catch(() => undefined);
}

function cleanLabel(value: string): string {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 80) : "confirmation page";
}
