import { NextResponse, type NextRequest } from "next/server";
import { requireGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { configuredShopifySyncMode } from "@/lib/shopify/sync-rules";
import { mediaSyncEnabled } from "@/lib/shopify/media-work-queue";
import { evaluateCombinedSyncStatus } from "@/lib/shopify/combined-sync-status";
import { buildMonitorPayload, MEDIA_MONITOR_ITEM_LIMIT } from "@/lib/shopify/media-sync-monitor";

export const runtime = "nodejs";
export const preferredRegion = "syd1";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Admin-only, read-only. Four bounded reads; none can enqueue, approve or reset.
 * A failed read becomes an "unavailable" section, never zero problems.
 * The fourth read (per-product liveness) is optional: MEDIA_MONITOR_LIVENESS=off
 * omits it without a code change. Nothing here is a proactive alert. */
export async function GET(req: NextRequest) {
  const denied = await requireGalleryAdmin(req); if (denied) return denied;
  const db = createSupabaseServiceRoleClient();
  const read = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(5000));
    if (error) throw new Error("MEDIA_MONITOR_READ_FAILED"); // provider message is never returned
    return data as unknown;
  };
  const livenessEnabled = process.env.MEDIA_MONITOR_LIVENESS !== "off";
  const [combined, status, items, liveness] = await Promise.allSettled([
    read("read_toptik_combined_sync_status", { p_product_gid: null }),
    read("read_toptik_media_status", { p_product_gid: null }),
    read("read_toptik_media_sync_monitor", { p_limit: MEDIA_MONITOR_ITEM_LIMIT }),
    livenessEnabled ? read("read_toptik_media_liveness", { p_limit: MEDIA_MONITOR_ITEM_LIMIT }) : Promise.resolve(undefined),
  ]);
  const runtime = { copy: process.env.VERCEL_ENV === "production" && isShopifySyncConfigured() && configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE) === "verified_catalog",
    media: mediaSyncEnabled() };
  const combinedData = combined.status === "fulfilled" ? combined.value : null;
  const payload = buildMonitorPayload({ fetchedAt: new Date().toISOString(), runtime,
    combined: combinedData, combinedValid: combinedData !== null && evaluateCombinedSyncStatus(combinedData, { ...runtime, specifications: true }).status !== "unknown",
    status: status.status === "fulfilled" ? status.value : null, items: items.status === "fulfilled" ? items.value : null,
    liveness: !livenessEnabled ? undefined : liveness.status === "fulfilled" ? liveness.value : null });
  return NextResponse.json(payload, { headers });
}
