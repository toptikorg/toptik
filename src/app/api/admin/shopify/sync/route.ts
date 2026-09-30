import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { drainShopifySyncQueues } from "@/lib/shopify/sync-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin/cron worker for Shopify-visible product copy and SEO fields. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request, { allowCron: true });
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) {
    return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
  }
  try {
    const result = await drainShopifySyncQueues(createSupabaseServiceRoleClient());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : "SYNC_WORKER_FAILED";
    console.error("POST /api/admin/shopify/sync failed", { code });
    return NextResponse.json({ error: "Shopify sync worker failed", code }, { status: 503 });
  }
}

/** Return a bounded status-only review queue; never expose webhook bodies. */
export async function GET(request: NextRequest) {
  const runWorker = request.nextUrl.searchParams.get("run") === "1";
  const denied = requireAdminToken(request, { allowCron: runWorker });
  if (denied) return denied;
  if (!hasSupabaseAdminEnv()) {
    return NextResponse.json({ error: "Supabase admin env not configured" }, { status: 503 });
  }
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (runWorker) {
      if (!isShopifySyncConfigured()) return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
      const result = await drainShopifySyncQueues(supabase);
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    const [{ data: events, error: eventsError }, { data: outbox, error: outboxError }] = await Promise.all([
      supabase.from("shopify_webhook_events")
        .select("id,topic,status,attempts,received_at,last_error")
        .in("status", ["review", "failed"])
        .order("received_at", { ascending: false })
        .limit(50),
      supabase.from("shopify_gallery_content_outbox")
        .select("id,catalog_key,status,attempts,created_at,last_error")
        .in("status", ["review", "failed"])
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (eventsError || outboxError) throw new Error("SYNC_REVIEW_QUEUE_READ_FAILED");
    return NextResponse.json({ events: events ?? [], outbox: outbox ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Shopify sync review queue unavailable" }, { status: 503 });
  }
}
