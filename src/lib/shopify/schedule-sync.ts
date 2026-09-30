import "server-only";
import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "./admin-api";
import { drainShopifySyncQueues } from "./sync-worker";

/** Schedule the durable outbox/inbox worker after returning the HTTP response. */
export function scheduleShopifySync(): void {
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) return;
  after(async () => {
    try {
      await drainShopifySyncQueues(createSupabaseServiceRoleClient());
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_BACKGROUND_WORKER_FAILED";
      console.error("Shopify sync background worker failed", { code });
    }
  });
}
