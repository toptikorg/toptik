import { NextRequest, NextResponse } from "next/server";
import { getCarouselPayload } from "@/lib/carousel/repository";
import { isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";
import { appendSamsoniteItems } from "@/lib/carousel/samsonite-catalog";
import { approvedSourceUrl } from "@/lib/catalog-source/source-allowlist";
import { resolvePublicProductDetails } from "@/lib/catalog-source/public-product-details";

// Public and read-only (GAL-025). It serves the tech specs already stored with
// an existing product whose source URL is an approved manufacturer address.
// It never fetches the requested URL and never writes to the database.
// Refreshing specs from a manufacturer site belongs to the authenticated
// admin/cron path (/api/admin/warm-tech-specs).
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0, must-revalidate" };

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!approvedSourceUrl(rawUrl)) {
    return NextResponse.json({ specs: [], colors: [], error: "source_not_approved" }, { status: 400, headers: NO_STORE });
  }

  try {
    const payload = await getCarouselPayload({ includeInactive: true });
    if (isUnavailableCarouselPayload(payload)) {
      return NextResponse.json(
        { specs: [], colors: [], error: "unavailable" },
        { status: 503, headers: { ...NO_STORE, "Retry-After": "60" } },
      );
    }
    const items = appendSamsoniteItems(payload.items).filter((item) => item.isActive);
    const result = resolvePublicProductDetails(rawUrl, items);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    console.error("GET /api/product-details failed", error);
    return NextResponse.json(
      { specs: [], colors: [], error: "unavailable" },
      { status: 503, headers: { ...NO_STORE, "Retry-After": "60" } },
    );
  }
}
