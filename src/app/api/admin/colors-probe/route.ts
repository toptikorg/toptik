import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { scrapeColorVariantsByCatalog } from "@/lib/catalog-source/mandarina-scraper";

export const runtime = "nodejs";
export const maxDuration = 120;

// Read-only diagnostic: given a catalog number, scrape Mandarina Duck and return
// every colour variant of that model WITHOUT persisting anything. Lets us verify
// scraping accuracy on real data (on Vercel/local where MD is reachable) before
// the import wires these colours into the catalog. Auth: x-admin-token header or
// ?token= query (mirrors /api/admin/warm-tech-specs).

export async function GET(req: NextRequest) {
  const denied = requireAdminToken(req, { allowQueryToken: true });
  if (denied) return denied;

  const catalog = req.nextUrl.searchParams.get("catalog")?.trim();
  if (!catalog) {
    return NextResponse.json({ error: "Missing ?catalog= parameter" }, { status: 400 });
  }

  try {
    const { primary, modelToken, variants } = await scrapeColorVariantsByCatalog(catalog);
    return NextResponse.json({
      ok: true,
      catalog,
      modelToken,
      primary: {
        title: primary.title,
        catalogNumber: primary.catalogNumber,
        sourceUrl: primary.sourceUrl,
        images: primary.imageUrls.length,
      },
      count: variants.length,
      variants,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Probe failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
