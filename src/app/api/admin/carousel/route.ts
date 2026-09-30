import { NextRequest, NextResponse } from "next/server";
import { getCarouselPayload } from "@/lib/carousel/repository";
import { saveCarouselPayload } from "@/lib/carousel/repository-admin";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { CAROUSEL_UNAVAILABLE_MESSAGE, isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";
import { scheduleShopifySync } from "@/lib/shopify/schedule-sync";
import { prepareExistingCatalogSave, visibleAdminCatalog } from "@/lib/shopify/creation-catalog-bridge";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = requireAdminToken(req);
  if (denied) return denied;

  try {
    const payload = await getCarouselPayload({ includeInactive: true, rawAdmin: true });
    if (isUnavailableCarouselPayload(payload)) {
      return NextResponse.json({ error: CAROUSEL_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    return NextResponse.json(await visibleAdminCatalog(payload));
  } catch (error) {
    console.error("GET /api/admin/carousel failed", error);
    return NextResponse.json({ error: "Failed to load admin data" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const denied = requireAdminToken(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const current = await getCarouselPayload({ includeInactive: true, rawAdmin: true });
    if (isUnavailableCarouselPayload(current)) throw new Error(CAROUSEL_UNAVAILABLE_MESSAGE);
    const candidate = await prepareExistingCatalogSave(body, current);
    await saveCarouselPayload(candidate);
    scheduleShopifySync();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PUT /api/admin/carousel failed", error);
    const message = error instanceof Error ? error.message : "Failed to save carousel data";
    const status = message.includes("Missing Supabase admin env vars") ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
