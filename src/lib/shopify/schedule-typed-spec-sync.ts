import "server-only";
import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "./admin-api";
import { drainTypedSpecQueue, typedSpecSyncEnabled } from "./typed-spec-worker";

const WORKER_URL = "https://landing.toptik.co.il/api/admin/shopify/specs/worker";
export const MAX_TYPED_SPEC_HOPS = 100;
export function validTypedSpecHop(value: string | null): number | null {
  if (!value || !/^(?:0|[1-9]\d{0,2})$/.test(value)) return null;
  const hop = Number(value);
  return hop <= MAX_TYPED_SPEC_HOPS ? hop : null;
}

/** Fixed credential destination, separate60s worker budget. Never dispatch from Preview. */
export async function dispatchTypedSpecSync(hop = 0): Promise<void> {
  if (!typedSpecSyncEnabled() || process.env.VERCEL_ENV !== "production") return;
  if (!Number.isSafeInteger(hop) || hop < 0 || hop > MAX_TYPED_SPEC_HOPS) throw new Error("SPEC_CONTINUATION_INVALID");
  const token = process.env.ADMIN_PANEL_TOKEN;
  if (!token) throw new Error("SPEC_CONTINUATION_AUTH_UNAVAILABLE");
  const response = await fetch(`${WORKER_URL}?hop=${hop}`, { method: "POST", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(8_000), headers: { "x-admin-token": token } });
  if (response.status !== 202) throw new Error("SPEC_CONTINUATION_NOT_ACCEPTED");
  await response.body?.cancel();
}

/** Synchronous copy/cron requests only hand off, never run a second40s worker. */
export function scheduleTypedSpecWakeup(): void {
  if (!typedSpecSyncEnabled()) return;
  after(async () => {
    try { await dispatchTypedSpecSync(); }
    catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_WAKEUP_FAILED";
      console.error("Typed product specification wakeup pending", { code });
    }
  });
}

export function scheduleTypedSpecSync(hop = 0): void {
  if (!typedSpecSyncEnabled() || !hasSupabaseAdminEnv() || !isShopifySyncConfigured()) return;
  after(async () => {
    try {
      const result = await drainTypedSpecQueue(createSupabaseServiceRoleClient(), Date.now() + 40_000);
      // A stopped/failed/busy drain never produces an immediate retry chain.
      if (result.continuationNeeded) {
        if (hop >= MAX_TYPED_SPEC_HOPS) throw new Error("SPEC_CONTINUATION_CHAIN_LIMIT");
        await dispatchTypedSpecSync(hop + 1);
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_BACKGROUND_FAILED";
      console.error("Typed product specification sync pending", { code, hop });
    }
  });
}
