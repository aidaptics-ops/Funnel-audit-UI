import { NextResponse } from "next/server";
import { auditHealth } from "@/lib/audit/client";
import { providerStatus } from "@/lib/llm/registry";
import { knowledgeStore, readSnapshot } from "@/lib/client-knowledge/store";
import { isSheetsConfigured } from "@/lib/sheets/service";
import { hunterAccount, isHunterConfigured } from "@/lib/enrichment/hunter";
import { isRocketReachConfigured, rocketReachAccount } from "@/lib/enrichment/rocketreach";
import { requireSession } from "@/lib/auth/guard";

/**
 * What the dashboard shows in its status strip. Contains no secrets: provider
 * ids and booleans only, never keys or internal URLs.
 */

export async function GET(): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  const [health, snapshot, hunter, rocket] = await Promise.all([
    auditHealth(),
    readSnapshot().catch(() => ({ emails: [], profile: null })),
    // Free to call, and knowing the credit balance before spending one is the
    // difference between a considered lookup and an accidental one.
    hunterAccount().catch(() => null),
    rocketReachAccount().catch(() => null),
  ]);
  const store = knowledgeStore();

  return NextResponse.json({
    ok: true,
    data: {
      audit: health,
      llm: providerStatus(),
      knowledge: {
        emailCount: snapshot.emails.length,
        hasProfile: Boolean(snapshot.profile),
        storage: { kind: store.kind, durable: store.durable },
      },
      sheets: { configured: isSheetsConfigured() },
      enrichment: {
        hunter: {
          configured: isHunterConfigured(),
          creditsRemaining: hunter?.creditsRemaining ?? null,
          creditsAvailable: hunter?.creditsAvailable ?? null,
          resetsAt: hunter?.resetsAt ?? null,
        },
        rocketreach: {
          configured: isRocketReachConfigured(),
          lookupsRemaining: rocket?.lookupsRemaining ?? null,
          lookupsAllocated: rocket?.lookupsAllocated ?? null,
        },
      },
    },
  });
}
