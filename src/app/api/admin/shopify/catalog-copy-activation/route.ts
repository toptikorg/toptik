import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { configuredShopifyDomain, fetchProductSnapshot, isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { COPY_ACTIVATION_MANIFEST_SHA256, parseReviewedCopyActivation, readCopyActivationBody, revalidateCopyActivation } from "@/lib/shopify/catalog-copy-activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Private reviewed activation; never modifies a Shopify product or catalog copy. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request);
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) return NextResponse.json({ error: "COPY_ACTIVATION_NOT_CONFIGURED" }, { status: 503 });
  try {
    if (configuredShopifyDomain() !== "toptikcoil.myshopify.com") throw new Error("COPY_ACTIVATION_SHOP_MISMATCH");
    const enable = request.nextUrl.searchParams.get("enable");
    if (enable !== null && enable !== "0" && enable !== "1") throw new Error("COPY_ACTIVATION_ENABLE_INVALID");
    const manifest = parseReviewedCopyActivation(await readCopyActivationBody(request));
    await revalidateCopyActivation(manifest, fetchProductSnapshot);
    const { data, error } = await createSupabaseServiceRoleClient().rpc("activate_shopify_verified_catalog", { p_manifest: manifest, p_enable: enable === "1" });
    if (error) throw new Error(/^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "COPY_ACTIVATION_TRANSACTION_FAILED");
    return NextResponse.json({ ok: true, manifestSha256: COPY_ACTIVATION_MANIFEST_SHA256, result: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "COPY_ACTIVATION_FAILED";
    return NextResponse.json({ error: code }, { status: code === "COPY_ACTIVATION_BODY_TOO_LARGE" ? 413 : 409, headers: { "Cache-Control": "no-store" } });
  }
}
