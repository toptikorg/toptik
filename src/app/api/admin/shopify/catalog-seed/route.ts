import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { configuredShopifyDomain, fetchCatalogSeedProductSnapshot, isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { CATALOG_SEED_MANIFEST_SHA256, parseReviewedCatalogSeed, readCatalogSeedBody, revalidateCatalogSeedProducts } from "@/lib/shopify/catalog-seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reviewed persistence only: no Shopify writes, sync queue or worker schedule. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request);
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) return NextResponse.json({ error: "CATALOG_SEED_NOT_CONFIGURED" }, { status: 503 });
  try {
    if (configuredShopifyDomain() !== "toptikcoil.myshopify.com") throw new Error("CATALOG_SEED_SHOP_MISMATCH");
    const manifest = parseReviewedCatalogSeed(await readCatalogSeedBody(request));
    await revalidateCatalogSeedProducts(manifest, fetchCatalogSeedProductSnapshot);
    const { data, error } = await createSupabaseServiceRoleClient().rpc("seed_samsonite_gallery_baselines", { p_manifest: manifest });
    if (error) throw new Error(/^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "CATALOG_SEED_TRANSACTION_FAILED");
    return NextResponse.json({ ok: true, manifestSha256: CATALOG_SEED_MANIFEST_SHA256, result: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "CATALOG_SEED_FAILED";
    return NextResponse.json({ error: code }, { status: code === "CATALOG_SEED_BODY_TOO_LARGE" ? 413 : 409, headers: { "Cache-Control": "no-store" } });
  }
}
