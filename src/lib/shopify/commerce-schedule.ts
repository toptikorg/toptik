import "server-only";
import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { commercialPublicationMode } from "./commerce-mode";
import { runPersistedCommerce } from "./commerce-runtime";

export const COMMERCE_MAX_HOPS = 20;
/** ACK only. Used by creation after draft_ready so the next worker gets its own request budget. */
export async function dispatchCommercialPublication(itemId: string, hop = 0, deadline = Date.now() + 8000): Promise<boolean> {
  if (!commercialPublicationMode(process.env) || !/^[a-f0-9-]{36}$/i.test(itemId) || !Number.isInteger(hop) || hop < 0 || hop >= COMMERCE_MAX_HOPS ||
      deadline - Date.now() < 1 || !process.env.ADMIN_PANEL_TOKEN) return false;
  try {
    const response = await fetch(`https://landing.toptik.co.il/api/admin/shopify/commerce?continue=${hop + 1}`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(Math.min(8000, Math.floor(deadline - Date.now()))),
      headers: { "content-type": "application/json", "x-admin-token": process.env.ADMIN_PANEL_TOKEN }, body: JSON.stringify({ itemId }),
    });
    await response.body?.cancel(); return response.status === 202;
  } catch { return false; }
}
export function scheduleCommercialPublication(itemId: string, hop = 0, deadline = Date.now() + 55000) {
  if (!commercialPublicationMode(process.env) || !/^[a-f0-9-]{36}$/i.test(itemId) || !Number.isInteger(hop) || hop < 0 || hop > COMMERCE_MAX_HOPS) return;
  after(async () => {
    const result = await runPersistedCommerce(createSupabaseServiceRoleClient(), itemId, Math.min(deadline - 8000, Date.now() + 40000));
    if (!result.continuationNeeded || hop >= COMMERCE_MAX_HOPS || deadline - Date.now() < 1000 || !process.env.ADMIN_PANEL_TOKEN) return;
    if (!await dispatchCommercialPublication(itemId, hop, deadline)) console.error("FINALIZE_CONTINUATION_UNCONFIRMED");
  });
}
