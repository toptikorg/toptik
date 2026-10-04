import { NextResponse } from "next/server";
import { getPublicCarouselPayload } from "@/lib/carousel/public-payload";
import { isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";

// Always serve the CURRENT catalog — no edge/browser caching. A product added
// or edited in the admin must appear immediately; the previous aggressive edge
// cache (s-maxage=3600 + stale-while-revalidate=86400) kept serving a stale
// product list for up to a day, so newly-saved products didn't show. Independent
// catalog reads run concurrently, with completeness checks and no stale cache.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const publicPayload = await getPublicCarouselPayload();
    if (isUnavailableCarouselPayload(publicPayload)) {
      console.error("GALLERY_CATALOG_UNAVAILABLE");
      return NextResponse.json(publicPayload, {
        status: 503,
        headers: {
          "Cache-Control": "no-store, max-age=0, must-revalidate",
          "Retry-After": "60",
        },
      });
    }
    return NextResponse.json(publicPayload, {
      headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" },
    });
  } catch (error) {
    console.error("GET /api/carousel failed", error);
    return NextResponse.json({ error: "Failed to load carousel" }, { status: 500 });
  }
}
