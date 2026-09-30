import "server-only";
import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "./admin-api";
import { drainShopifySyncQueues } from "./sync-worker";

export const MAX_SYNC_CONTINUATION_HOPS = 100;
const CONTINUATION_URL = "https://landing.toptik.co.il/api/admin/shopify/sync";

export function validSyncContinuationHop(value: string | null): number | null {
  if (!value || !/^[1-9]\d{0,2}$/.test(value)) return null;
  const hop = Number(value);
  return hop <= MAX_SYNC_CONTINUATION_HOPS ? hop : null;
}

/** The queue is durable; this fixed-origin request only wakes its next bounded drain. */
async function dispatchSyncContinuation(hop: number): Promise<void> {
  if (hop >= MAX_SYNC_CONTINUATION_HOPS) throw new Error("SYNC_CONTINUATION_CHAIN_LIMIT");
  // Never send a Preview environment's token/work to Production or derive the
  // credential destination from a request Host header / caller-controlled URL.
  if (process.env.VERCEL_ENV !== "production") return;
  const token = process.env.ADMIN_PANEL_TOKEN;
  if (!token) throw new Error("SYNC_CONTINUATION_AUTH_UNAVAILABLE");
  const response = await fetch(`${CONTINUATION_URL}?continue=1&hop=${hop + 1}`, {
    method: "POST", headers: { "x-admin-token": token }, redirect: "error", cache: "no-store",
    // Timeout applies only to acceptance of the next worker, not reconciliation.
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status !== 202) throw new Error("SYNC_CONTINUATION_NOT_ACCEPTED");
  await response.body?.cancel();
}

export async function runScheduledShopifySync(hop = 0): Promise<void> {
  const result = await drainShopifySyncQueues(createSupabaseServiceRoleClient());
  if (result.continuationNeeded) await dispatchSyncContinuation(hop);
}

/** Resume a completed synchronous admin/cron drain without running a second in its budget. */
export function scheduleShopifySyncContinuation(): void {
  after(async () => {
    try { await dispatchSyncContinuation(0); }
    catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_CONTINUATION_DISPATCH_FAILED";
      console.error("Shopify sync continuation failed", { code, pendingWork: true });
    }
  });
}

/** Schedule the durable outbox/inbox worker after returning the HTTP response. */
export function scheduleShopifySync(hop = 0): void {
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) return;
  after(async () => {
    try {
      await runScheduledShopifySync(hop);
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_BACKGROUND_WORKER_FAILED";
      console.error("Shopify sync background worker failed", { code, hop });
    }
  });
}
