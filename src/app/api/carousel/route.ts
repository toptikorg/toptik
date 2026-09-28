import { NextResponse } from "next/server";
import { getPublicCatalog } from "@/lib/carousel/public-catalog";

// No edge/browser caching. Curated data is fresh; the server-only public
// Shopify reader has a bounded 60-second cache and never serves stale failures.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getPublicCatalog();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" },
    });
  } catch (error) {
    console.error("GET /api/carousel failed", error);
    return NextResponse.json({ error: "Catalog temporarily unavailable" }, { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }
}
