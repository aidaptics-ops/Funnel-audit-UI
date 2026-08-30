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

const EMPTY: KnowledgeSnapshot = { emails: [], profile: null };

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
  return (await knowledgeStore().read()).emails;
}

export async function addEmails(emails: ClientEmail[]): Promise<KnowledgeSnapshot> {
  const store = knowledgeStore();
  const snapshot = await store.read();

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
  const snapshot = await store.read();
  const next: KnowledgeSnapshot = {
    ...snapshot,
    emails: snapshot.emails.filter((email) => email.id !== id),
  };
  await store.write(next);
  return next;
}

export async function clearEmails(): Promise<KnowledgeSnapshot> {
  const store = knowledgeStore();
  const next: KnowledgeSnapshot = { emails: [], profile: null };
  await store.write(next);
  return next;
}

export async function saveProfile(profile: ClientProfile): Promise<KnowledgeSnapshot> {
  const store = knowledgeStore();
  const snapshot = await store.read();
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
  const snapshot = await knowledgeStore().read();
  if (snapshot.emails.length > 0) return snapshot;

  const seeded = await readSeed();
  return seeded.length > 0 ? { ...snapshot, emails: seeded } : snapshot;
}

let seedCache: ClientEmail[] | null = null;

async function readSeed(): Promise<ClientEmail[]> {
  if (seedCache) return seedCache;
  try {
    const raw = await readFile(join(process.cwd(), "seed", "client-emails.txt"), "utf8");
    const { parsePastedEmails } = await import("./ingest");
    seedCache = parsePastedEmails(raw, { source: "seed" });
  } catch {
    // No seed file is a valid state, not an error.
    seedCache = [];
  }
  return seedCache;
}

/* -------------------------------- helpers -------------------------------- */

function coerce(value: unknown): KnowledgeSnapshot {
  if (!value || typeof value !== "object") return { ...EMPTY };
  const record = value as Partial<KnowledgeSnapshot>;
  return {
    emails: Array.isArray(record.emails) ? record.emails.filter(isEmail) : [],
    profile: record.profile && typeof record.profile === "object" ? record.profile : null,
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
