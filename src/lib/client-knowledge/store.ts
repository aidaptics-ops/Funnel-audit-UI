import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { config } from "../config";
import { AppError } from "../errors";
import type { ClientEmail, ClientProfile, KnowledgeSnapshot } from "./types";

/**
 * Persistence for the email library and the derived profile.
 *
 * Deliberately an interface with two small implementations rather than a
 * database: Google Sheets becomes the operational source of truth later, and
 * this seam is where that implementation will slot in.
 *
 * IMPORTANT for Vercel: serverless filesystems are ephemeral and not shared
 * between invocations, so the file store will appear to "forget" between
 * requests there. Set KNOWLEDGE_STORE=memory to make that behaviour explicit,
 * or add a SheetsKnowledgeStore once the Sheets service is wired.
 */
export interface KnowledgeStore {
  readonly kind: string;
  readonly durable: boolean;
  read(): Promise<KnowledgeSnapshot>;
  write(snapshot: KnowledgeSnapshot): Promise<void>;
}

const EMPTY: KnowledgeSnapshot = { emails: [], profile: null, dismissedSeedIds: [] };

class FileKnowledgeStore implements KnowledgeStore {
  readonly kind = "file";
  readonly durable = true;
  private readonly path: string;

  constructor(dir: string) {
    this.path = resolve(process.cwd(), dir, "client-knowledge.json");
  }

  async read(): Promise<KnowledgeSnapshot> {
    try {
      const raw = await readFile(this.path, "utf8");
      return coerce(JSON.parse(raw));
    } catch (error) {
      if (isMissing(error)) return { ...EMPTY };
      throw new AppError("storage_failed", describe(error));
    }
  }

  async write(snapshot: KnowledgeSnapshot): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      // Write-then-rename so a crash mid-write cannot truncate the library.
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(temp, this.path);
    } catch (error) {
      throw new AppError("storage_failed", describe(error));
    }
  }
}

/** Survives only within one server process. Correct choice on serverless. */
class MemoryKnowledgeStore implements KnowledgeStore {
  readonly kind = "memory";
  readonly durable = false;
  private snapshot: KnowledgeSnapshot = { ...EMPTY };

  async read(): Promise<KnowledgeSnapshot> {
    return structuredClone(this.snapshot);
  }

  async write(snapshot: KnowledgeSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}

let instance: KnowledgeStore | null = null;

export function knowledgeStore(): KnowledgeStore {
  if (!instance) {
    instance =
      config.storage.driver === "memory"
        ? new MemoryKnowledgeStore()
        : new FileKnowledgeStore(config.storage.dir);
  }
  return instance;
}

/* ------------------------------ operations ------------------------------- */

export async function listEmails(): Promise<ClientEmail[]> {
  // Goes through readSnapshot so the seeded library is visible here too.
  // Reading the raw store instead is why a serverless instance could report
  // "no emails" while the dashboard was showing eleven.
  return (await readSnapshot()).emails;
}

export async function addEmails(emails: ClientEmail[]): Promise<KnowledgeSnapshot> {
  const store = knowledgeStore();
  // Seeded, not raw. Reading the raw store here means the first email someone
  // adds writes {emails:[theirs]} over an empty store, and the eleven seeded
  // samples vanish the moment the library is touched.
  const snapshot = await readSnapshot();

  // Same body twice is almost always a double-paste, not two real samples.
  const seen = new Set(snapshot.emails.map((email) => fingerprint(email.body)));
  const added = emails.filter((email) => {
    const print = fingerprint(email.body);
    if (seen.has(print)) return false;
    seen.add(print);
    return true;
  });

  const next: KnowledgeSnapshot = { ...snapshot, emails: [...snapshot.emails, ...added] };
  await store.write(next);
  return next;
}

export async function removeEmail(id: string): Promise<KnowledgeSnapshot> {
  const store = knowledgeStore();
  const snapshot = await readSnapshot();
  // A seeded sample lives in the repo, so filtering it out of the store is not
  // enough — the next read would merge it straight back in. Its id is
  // content-derived and therefore stable, so remembering it is enough.
  const dismissed = id.startsWith("seed-")
    ? [...new Set([...(snapshot.dismissedSeedIds ?? []), id])]
    : (snapshot.dismissedSeedIds ?? []);

  const next: KnowledgeSnapshot = {
    ...snapshot,
    emails: snapshot.emails.filter((email) => email.id !== id),
    dismissedSeedIds: dismissed,
  };
  await store.write(next);
  return next;
}

export async function clearEmails(): Promise<KnowledgeSnapshot> {
  const store = knowledgeStore();
  // Every seeded sample is dismissed too. Without that the merge in
  // readSnapshot() would repopulate the library on the very next request and
  // "Clear" would look like it had silently failed.
  const seeded = await readSeedEmails();
  const next: KnowledgeSnapshot = {
    emails: [],
    profile: null,
    dismissedSeedIds: seeded.map((email) => email.id),
  };
  await store.write(next);
  return next;
}

export async function saveProfile(profile: ClientProfile): Promise<KnowledgeSnapshot> {
  const store = knowledgeStore();
  const snapshot = await readSnapshot();
  const next: KnowledgeSnapshot = { ...snapshot, profile };
  await store.write(next);
  return next;
}

/**
 * The library, seeding itself from the repo's checked-in samples when empty.
 *
 * This exists for serverless. On Vercel the filesystem is ephemeral, so the
 * store legitimately starts empty on every cold start — and an empty library
 * means the generator has no voice to imitate and silently writes generic
 * copy. Falling back to the committed seed makes a fresh deploy behave like a
 * configured one. Anything the operator adds through the UI still wins.
 */
export async function readSnapshot(): Promise<KnowledgeSnapshot> {
  const stored = await knowledgeStore().read();
  const seeded = await readSeedEmails();

  /*
   * A UNION, not a fallback.
   *
   * This used to be "stored emails, or the seed if the store is empty", which
   * quietly broke the thing the seed file is for. The client sends new samples
   * periodically; they get committed to seed/client-emails.txt; and any
   * deployment that had ever written to its own store — which is every
   * long-lived one — never saw them, because its store was not empty. The
   * library silently stopped growing.
   *
   * Merging by content fingerprint means a newly committed sample appears
   * everywhere on the next deploy, while anything added through the UI is
   * untouched. Deliberate deletions are remembered separately so the merge
   * cannot undo them.
   */
  const dismissed = new Set(stored.dismissedSeedIds ?? []);
  const known = new Set(stored.emails.map((email) => fingerprint(email.body)));
  const additions = seeded.filter(
    (email) => !dismissed.has(email.id) && !known.has(fingerprint(email.body)),
  );

  // Both halves fall back independently. On serverless the store is empty on
  // every cold start, and a profile written by one instance is invisible to
  // the next — so without a committed fallback the dashboard reports "no
  // profile" forever, however many times someone presses Refresh.
  const profile = stored.profile ?? (await readSeedProfile());

  return {
    emails: [...stored.emails, ...additions],
    profile,
    dismissedSeedIds: stored.dismissedSeedIds ?? [],
  };
}

let seedEmailCache: ClientEmail[] | null = null;
let seedProfileCache: ClientProfile | null | undefined;

async function readSeedEmails(): Promise<ClientEmail[]> {
  if (seedEmailCache) return seedEmailCache;
  try {
    const raw = await readFile(seedPath("client-emails.txt"), "utf8");
    const { parsePastedEmails } = await import("./ingest");
    seedEmailCache = parsePastedEmails(raw, { source: "seed" });
  } catch {
    // No seed file is a valid state, not an error.
    seedEmailCache = [];
  }
  return seedEmailCache;
}

/**
 * A profile committed to the repo, so a fresh deploy is immediately usable.
 *
 * Deriving it costs a model call, and on serverless the result cannot be
 * cached anywhere the next request will see. Shipping the derived profile
 * makes the deployed app behave exactly like the local one from the first
 * request, with no model call at all.
 */
async function readSeedProfile(): Promise<ClientProfile | null> {
  if (seedProfileCache !== undefined) return seedProfileCache;
  try {
    const raw = await readFile(seedPath("client-profile.json"), "utf8");
    const parsed = JSON.parse(raw) as ClientProfile;
    seedProfileCache = parsed && typeof parsed === "object" && parsed.writing ? parsed : null;
  } catch {
    seedProfileCache = null;
  }
  return seedProfileCache;
}

function seedPath(name: string): string {
  return join(process.cwd(), "seed", name);
}

/* -------------------------------- helpers -------------------------------- */

function coerce(value: unknown): KnowledgeSnapshot {
  if (!value || typeof value !== "object") return { ...EMPTY };
  const record = value as Partial<KnowledgeSnapshot>;
  return {
    emails: Array.isArray(record.emails) ? record.emails.filter(isEmail) : [],
    profile: record.profile && typeof record.profile === "object" ? record.profile : null,
    dismissedSeedIds: Array.isArray(record.dismissedSeedIds)
      ? record.dismissedSeedIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function isEmail(value: unknown): value is ClientEmail {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ClientEmail).id === "string" &&
    typeof (value as ClientEmail).body === "string"
  );
}

function fingerprint(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 400);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const KNOWLEDGE_PATH_HINT = join(config.storage.dir, "client-knowledge.json");
