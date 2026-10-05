import "server-only";
import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "./admin-api";
import { drainShopifySyncQueues } from "./sync-worker";
import { dispatchMediaSync } from "./media-schedule";
import { dispatchTypedSpecSync } from "./schedule-typed-spec-sync";

export const MAX_SYNC_CONTINUATION_HOPS = 100;

export function validSyncContinuationHop(value: string | null): number | null {
  if (!value || !/^[1-9]\d{0,2}$/.test(value)) return null;
  const hop = Number(value);
  return hop <= MAX_SYNC_CONTINUATION_HOPS ? hop : null;
}

export async function runScheduledShopifySync(): Promise<void> {
  try {
    await drainShopifySyncQueues(createSupabaseServiceRoleClient());
  } finally {
    // Copy reconciliation releases the shared product lease before the separate
    // typed worker starts. A wakeup failure never reverses an accepted copy edit.
    // Independent bounded acceptance requests share the same tail:45+max(8,8),
    // never45+8+8. Both consumers serialize actual product work using the lease.
    // Remaining work stays in the durable queue. An independent cron invocation
    // resumes it, rather than extending a fragile recursive HTTP request chain.
    const [typedWakeup, mediaWakeup] = await Promise.allSettled([
      dispatchTypedSpecSync(),
      dispatchMediaSync(),
    ]);
    if (typedWakeup.status === "rejected") {
      const error = typedWakeup.reason;
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_WAKEUP_FAILED";
      console.error("Typed specification wakeup pending after copy", { code });
    }
    if (mediaWakeup.status === "rejected") console.error("Media wakeup pending after copy", { code: "MEDIA_WAKEUP_FAILED" });
  }
}

/** Wake dependent queues after a synchronous drain; cron resumes remaining copy work. */
export function scheduleShopifySyncContinuation(): void {
  after(async () => {
    const results = await Promise.allSettled([dispatchTypedSpecSync(), dispatchMediaSync()]);
    for (const [index, result] of results.entries()) if (result.status === "rejected") {
      const error = result.reason;
      const fallback = index === 0 ? "SPEC_WAKEUP_FAILED" : "MEDIA_WAKEUP_FAILED";
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : fallback;
      console.error(index === 0 ? "Typed specification wakeup pending" : "Media wakeup pending", { code, pendingWork: true });
    }
  });
}

/** Schedule the durable outbox/inbox worker after returning the HTTP response. */
export function scheduleShopifySync(hop = 0): void {
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) return;
  after(async () => {
    try {
      await runScheduledShopifySync();
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_BACKGROUND_WORKER_FAILED";
      console.error("Shopify sync background worker failed", { code, hop });
    }
  });
}
