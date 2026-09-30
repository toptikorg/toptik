import { NextResponse } from "next/server";
import { getPublicCarouselPayload } from "@/lib/carousel/public-payload";

// Always serve the CURRENT catalog — no edge/browser caching. A product added
// or edited in the admin must appear immediately; the previous aggressive edge
// cache (s-maxage=3600 + stale-while-revalidate=86400) kept serving a stale
// product list for up to a day, so newly-saved products didn't show. The read
// is a single lightweight Supabase query, so serving it fresh is cheap.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const publicPayload = await getPublicCarouselPayload();
    return NextResponse.json(publicPayload, {
      headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" },
    });
  } catch (error) {
    console.error("GET /api/carousel failed", error);
    return NextResponse.json({ error: "Failed to load carousel" }, { status: 500 });
  }
}
