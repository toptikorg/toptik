import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { drainShopifySyncQueues } from "@/lib/shopify/sync-worker";
import { assertVerifiedCopyApproval, configuredShopifySyncMode, configuredSyncCanarySku, shopifyProductGid } from "@/lib/shopify/sync-rules";
import { readVerifiedCopyEligibility } from "@/lib/shopify/copy-eligibility";
import { scheduleShopifySync, scheduleShopifySyncContinuation, validSyncContinuationHop } from "@/lib/shopify/schedule-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin/cron worker for Shopify-visible product copy and SEO fields. */
export async function POST(request: NextRequest) {
  const continuation = request.nextUrl.searchParams.get("continue") === "1";
  const denied = requireAdminToken(request, { allowCron: !continuation });
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) {
    return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
  }
  if (continuation) {
    const hop = validSyncContinuationHop(request.nextUrl.searchParams.get("hop"));
    if (hop === null || configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE) !== "verified_catalog") {
      return NextResponse.json({ error: "SYNC_CONTINUATION_INVALID" }, { status: 400 });
    }
    scheduleShopifySync(hop);
    return NextResponse.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await drainShopifySyncQueues(createSupabaseServiceRoleClient());
    if (result.continuationNeeded) scheduleShopifySyncContinuation();
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : "SYNC_WORKER_FAILED";
    console.error("POST /api/admin/shopify/sync failed", { code });
    return NextResponse.json({ error: "Shopify sync worker failed", code }, { status: 503 });
  }
}

/** Return bounded private review and exact-canary delivery metadata, never bodies. */
export async function GET(request: NextRequest) {
  const runWorker = request.nextUrl.searchParams.get("run") === "1";
  const denied = requireAdminToken(request, { allowCron: runWorker });
  if (denied) return denied;
  if (!hasSupabaseAdminEnv()) {
    return NextResponse.json({ error: "Supabase admin env not configured" }, { status: 503 });
  }
  const requestedProductId = request.nextUrl.searchParams.get("productId");
  if (requestedProductId && !/^gid:\/\/shopify\/Product\/\d+$/.test(requestedProductId)) {
    return NextResponse.json({ error: "SYNC_PRODUCT_GID_INVALID" }, { status: 400 });
  }
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (runWorker) {
      if (!isShopifySyncConfigured()) return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
      const result = await drainShopifySyncQueues(supabase);
      if (result.continuationNeeded) scheduleShopifySyncContinuation();
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
    const mode = configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE);
    let verifiedCatalog: { enabled: number; approved: number } | null = null;
    if (mode === "verified_catalog") {
      const { data: approvals, error: approvalError } = await supabase.from("shopify_gallery_copy_eligibility").select("product_gid,enabled").limit(5000);
      if (approvalError) throw new Error("SYNC_COPY_APPROVAL_READ_FAILED");
      verifiedCatalog = { enabled: (approvals ?? []).filter(row => row.enabled).length, approved: approvals?.length ?? 0 };
    }
    const canarySku = configuredSyncCanarySku(process.env.SHOPIFY_SYNC_CANARY_SKU);
    let canaryProductId: string | null = null;
    let canaryEvents: Array<{
      id: string; delivery_id: string; topic: string; received_at: string;
      processed_at: string | null; status: string; product_id: string; event_updated_at: string | null;
    }> = [];
    if (canarySku) {
      const { data: binding, error: bindingError } = await supabase.from("shopify_gallery_bindings")
        .select("product_gid").eq("catalog_key", canarySku).maybeSingle();
      if (bindingError) throw new Error("SYNC_CANARY_STATUS_READ_FAILED");
      if (binding) {
        canaryProductId = shopifyProductGid(binding.product_gid);
        if (!canaryProductId) throw new Error("SYNC_CANARY_STATUS_IDENTITY_INVALID");
        // Select only scalar identity/version metadata from JSON. Webhook content and
        // shop identifiers never enter the status response or this read result.
        const { data: deliveries, error: deliveriesError } = await supabase.from("shopify_webhook_events")
          .select("id,delivery_id,topic,received_at,processed_at,status,product_id:payload->>id,event_updated_at:payload->>updated_at")
          .in("payload->>id", [canaryProductId, canaryProductId.split("/").at(-1)!])
          .order("received_at", { ascending: false })
          .limit(25);
        if (deliveriesError) throw new Error("SYNC_CANARY_STATUS_READ_FAILED");
        canaryEvents = (deliveries ?? []).flatMap(row => {
          const productId = shopifyProductGid(row.product_id);
          return productId && productId === canaryProductId ? [{
            id: row.id, delivery_id: row.delivery_id, topic: row.topic,
            received_at: row.received_at, processed_at: row.processed_at,
            status: row.status, product_id: productId, event_updated_at: row.event_updated_at,
          }] : [];
        });
      }
    }
    let selectedProductId: string | null = null;
    let productEvents: typeof canaryEvents = [];
    if (requestedProductId) {
      if (mode !== "verified_catalog") return NextResponse.json({ error: "SYNC_PRODUCT_STATUS_NOT_APPROVED" }, { status: 409 });
      const approval = await readVerifiedCopyEligibility(supabase, requestedProductId);
      assertVerifiedCopyApproval(approval);
      const { data: bindings, error: bindingError } = await supabase.from("shopify_gallery_bindings")
        .select("catalog_key,carousel_item_id,product_gid,variant_gid,product_handle").eq("product_gid", requestedProductId).limit(2);
      const binding = bindings?.[0];
      if (bindingError || bindings?.length !== 1 || !binding || binding.product_gid !== approval.product_gid ||
          binding.catalog_key !== approval.catalog_key || binding.carousel_item_id !== approval.carousel_item_id ||
          binding.variant_gid !== approval.variant_gid || binding.product_handle !== approval.approved_product_handle) {
        throw new Error("SYNC_PRODUCT_STATUS_NOT_APPROVED");
      }
      selectedProductId = requestedProductId;
      if (selectedProductId === canaryProductId) productEvents = canaryEvents;
      else {
        const { data: deliveries, error: deliveryError } = await supabase.from("shopify_webhook_events")
          .select("id,delivery_id,topic,received_at,processed_at,status,product_id:payload->>id,event_updated_at:payload->>updated_at")
          .in("payload->>id", [selectedProductId, selectedProductId.split("/").at(-1)!])
          .order("received_at", { ascending: false }).limit(25);
        if (deliveryError) throw new Error("SYNC_PRODUCT_STATUS_READ_FAILED");
        productEvents = (deliveries ?? []).flatMap(row => shopifyProductGid(row.product_id) === selectedProductId ? [{
          id: row.id, delivery_id: row.delivery_id, topic: row.topic, received_at: row.received_at,
          processed_at: row.processed_at, status: row.status, product_id: selectedProductId!, event_updated_at: row.event_updated_at,
        }] : []);
      }
    }
    const publicProductAdmissionEnabled = mode === "verified_catalog" && process.env.SHOPIFY_SYNC_AUTOCREATE === "published_shopify";
    return NextResponse.json({ events: events ?? [], outbox: outbox ?? [], canaryProductId, canaryEvents, mode, verifiedCatalog, selectedProductId, productEvents, publicProductAdmissionEnabled },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Shopify sync review queue unavailable" }, { status: 503 });
  }
}
