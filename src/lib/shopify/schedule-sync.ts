import "server-only";
import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "./admin-api";
import { drainShopifySyncQueues } from "./sync-worker";
import { dispatchTypedSpecSync } from "./schedule-typed-spec-sync";

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
  let continuationNeeded = false;
  try {
    const result = await drainShopifySyncQueues(createSupabaseServiceRoleClient());
    continuationNeeded = result.continuationNeeded;
  } finally {
    // Copy reconciliation releases the shared product lease before the separate
    // typed worker starts. A wakeup failure never reverses an accepted copy edit.
    // Independent bounded acceptance requests share the same tail:45+max(8,8),
    // never45+8+8. Both consumers serialize actual product work using the lease.
    const [copyWakeup, typedWakeup] = await Promise.allSettled([
      continuationNeeded ? dispatchSyncContinuation(hop) : Promise.resolve(),
      dispatchTypedSpecSync(),
    ]);
    if (typedWakeup.status === "rejected") {
      const error = typedWakeup.reason;
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_WAKEUP_FAILED";
      console.error("Typed specification wakeup pending after copy", { code });
    }
    if (copyWakeup.status === "rejected") throw copyWakeup.reason;
  }
}

/** Resume a completed synchronous admin/cron drain without running a second in its budget. */
export function scheduleShopifySyncContinuation(): void {
  after(async () => {
    const results = await Promise.allSettled([dispatchSyncContinuation(0), dispatchTypedSpecSync()]);
    for (const [index, result] of results.entries()) if (result.status === "rejected") {
      const error = result.reason;
      const fallback = index === 0 ? "SYNC_CONTINUATION_DISPATCH_FAILED" : "SPEC_WAKEUP_FAILED";
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : fallback;
      console.error(index === 0 ? "Shopify sync continuation failed" : "Typed specification wakeup pending", { code, pendingWork: true });
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
