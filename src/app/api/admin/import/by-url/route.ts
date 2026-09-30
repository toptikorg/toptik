import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { z } from "zod";
import { importSourceProduct } from "@/lib/import/import-handler";
import { fetchMandarinaByUrl } from "@/lib/catalog-source/mandarina-scraper";
import { fetchBricsByUrl } from "@/lib/catalog-source/brics-scraper";
import { fetchSamsoniteByUrl } from "@/lib/catalog-source/samsonite-scraper";
import { SAMSONITE_SOURCE_HOSTS } from "@/lib/catalog-source/samsonite-parsing";
import type { SourceProduct } from "@/lib/catalog-source/types";
import type { CatalogVendor } from "@/lib/catalog-source/provider";

// Import a product from a direct product-page URL. Only known sources are
// allowed (SSRF guard) — the server fetches the URL, so an open fetch would be
// a proxy into arbitrary hosts.
export const runtime = "nodejs";
export const maxDuration = 120;

const importByUrlSchema = z.object({
  url: z.string().trim().url().max(600),
  targetItemId: z.string().uuid().optional(),
});

type UrlSource = {
  label: string;
  matches: (host: string) => boolean;
  fetch: (url: string) => Promise<SourceProduct | null>;
  // Which vendor pipeline handles storage-folder + colour enumeration.
  vendor: CatalogVendor;
};

// Only approved source sites are supported. Products from anywhere else are
// entered manually in the admin (cover + angle images + description +
// dimensions) rather than scraped from arbitrary hosts.
const URL_SOURCES: UrlSource[] = [
  {
    label: "Samsonite",
    matches: (host) => SAMSONITE_SOURCE_HOSTS.includes(host as (typeof SAMSONITE_SOURCE_HOSTS)[number]),
    fetch: fetchSamsoniteByUrl,
    vendor: "samsonite",
  },
  {
    label: "Mandarina Duck",
    matches: (host) => host.endsWith("mandarinaduck.com"),
    fetch: fetchMandarinaByUrl,
    vendor: "mandarina",
  },
  {
    label: "Bric's Store",
    matches: (host) => host.endsWith("bricstore.com"),
    fetch: fetchBricsByUrl,
    vendor: "brics",
  },
];

export async function POST(req: NextRequest) {
  const denied = requireAdminToken(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const { url, targetItemId } = importByUrlSchema.parse(body);

    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      throw new Error("כתובת לא תקינה");
    }

    const source = URL_SOURCES.find((entry) => entry.matches(host));
    if (!source) {
      throw new Error(
        `כתובת לא נתמכת (${host}). ייבוא לפי כתובת נתמך רק באתרי היצרן המאושרים: mandarinaduck.com, bricstore.com ו-Samsonite.`,
      );
    }

    const sourceProduct = await source.fetch(url);
    if (!sourceProduct) {
      throw new Error(
        `לא הצלחתי לחלץ מוצר מהעמוד ב-${source.label}. ודא שזו כתובת של עמוד מוצר.`,
      );
    }

    const vendor = source.vendor;
    const result = await importSourceProduct(
      vendor,
      sourceProduct,
      targetItemId,
      sourceProduct.catalogNumber,
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/admin/import/by-url failed", error);
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
