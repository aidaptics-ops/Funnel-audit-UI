import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";

/**
 * A durable cache for paid lookups.
 *
 * This is not a performance optimisation. Enrichment credits are a hard,
 * small, monthly quota, so re-querying a domain we have already paid for is
 * spending money to learn nothing. The cache is therefore part of the
 * correctness of the feature, not an accessory to it.
 *
 * Entries never expire. A stale owner name is still worth more than a spent
 * credit, and the operator can always force a refresh explicitly.
 */

const FILE = "enrichment-cache.json";

type Entry<T> = { at: string; value: T };

let memory: Record<string, Entry<unknown>> | null = null;

/**
 * Always attempted, regardless of KNOWLEDGE_STORE. The email library can
 * afford to be in memory because it re-seeds from the repo; a lost enrichment
 * cache costs credits that do not come back until the quota resets.
 */
async function load(): Promise<Record<string, Entry<unknown>>> {
  if (memory) return memory;
  try {
    const raw = await readFile(join(config.storage.cacheDir, FILE), "utf8");
    memory = JSON.parse(raw) as Record<string, Entry<unknown>>;
  } catch {
    memory = {};
  }
  return memory;
}

async function persist(): Promise<void> {
  if (!memory) return;
  try {
    await mkdir(config.storage.cacheDir, { recursive: true });
    await writeFile(join(config.storage.cacheDir, FILE), JSON.stringify(memory, null, 2), "utf8");
  } catch {
    // A read-only filesystem must not break the lookup that filled the cache;
    // the in-memory copy still prevents a repeat within this instance.
  }
}

export async function cacheGet<T>(key: string): Promise<{ value: T; at: string } | null> {
  const store = await load();
  const entry = store[key.toLowerCase()];
  return entry ? { value: entry.value as T, at: entry.at } : null;
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  const store = await load();
  store[key.toLowerCase()] = { at: new Date().toISOString(), value };
  await persist();
}

export async function cacheHas(key: string): Promise<boolean> {
  return (await cacheGet(key)) !== null;
}
