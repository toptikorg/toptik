import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CatalogVendor, createCatalogSourceProvider } from "@/lib/catalog-source/provider";
import { fetchProductDetails } from "@/lib/catalog-source/product-details";
import { enumerateColorVariants } from "@/lib/catalog-source/mandarina-scraper";
import { enumerateBricsColorVariants } from "@/lib/catalog-source/brics-scraper";
import { uploadRemoteImageToStorage, uploadVariantGalleries } from "@/lib/catalog-source/storage";
import { toCarouselColors, toBricsCarouselColors } from "@/lib/carousel/colors";
import { translateToHebrew } from "@/lib/catalog-source/translate";
import { reviewedCopyFor } from "@/lib/carousel/reviewed-copy";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";
import type { SourceColorVariant, SourceProduct } from "@/lib/catalog-source/types";
import { CachedTechSpecs, CarouselColor, CarouselItem } from "@/lib/carousel/types";

const importCatalogSchema = z.object({
  catalogNumber: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[A-Za-z0-9._/\-]+$/, "Catalog number contains invalid characters"),
  targetItemId: z.string().uuid().optional(),
});

type VendorConfig = {
  label: string;
  storageFolder: string;
  enumerateVariants: (product: SourceProduct) => Promise<SourceColorVariant[]>;
  mapColors: (
    variants: SourceColorVariant[],
    galleryByHandle: Map<string, string[]>,
  ) => CarouselColor[];
};

const VENDOR_CONFIG: Record<CatalogVendor, VendorConfig> = {
  mandarina: {
    label: "Mandarina Duck",
    storageFolder: "mandarina",
    enumerateVariants: (product) => enumerateColorVariants(product),
    mapColors: toCarouselColors,
  },
  brics: {
    label: "Bric's",
    storageFolder: "brics",
    enumerateVariants: (product) =>
      enumerateBricsColorVariants({
        sourceUrl: product.sourceUrl,
        catalogNumber: product.catalogNumber,
      }),
    mapColors: toBricsCarouselColors,
  },
};

function isAuthorized(req: NextRequest) {
  const token = req.headers.get("x-admin-token");
  return Boolean(token && supabaseEnv.adminToken && token === supabaseEnv.adminToken);
}

function angleKeyByIndex(index: number) {
  const defaults = ["front", "right", "back", "left", "top"];
  return defaults[index] ?? `view-${index + 1}`;
}

// The full import pipeline for an already-fetched source product: re-host
// images, warm tech specs, enumerate + re-host colour galleries, use reviewed
// exact-SKU copy (or preserve the source), and build the draft CarouselItem.
// route handlers and the import-by-URL route.
export async function importSourceProduct(
  vendor: CatalogVendor,
  sourceProduct: import("@/lib/catalog-source/types").SourceProduct,
  targetItemId: string | undefined,
  inputLabel: string,
) {
  const vendorConfig = VENDOR_CONFIG[vendor];
  {
    {
      const catalogNumber = inputLabel;
      const normalizedCatalogNumber = (sourceProduct.catalogNumber || catalogNumber)
        // Storage folder name must stay path-safe whatever the source gave us.
        .replace(/[^A-Za-z0-9._-]/g, "-");

      const uploadedUrls: string[] = [];
      for (const [index, imageUrl] of sourceProduct.imageUrls.entries()) {
        try {
          const publicUrl = await uploadRemoteImageToStorage(
            `imports/${vendorConfig.storageFolder}/${normalizedCatalogNumber}`,
            imageUrl,
            index,
          );
          uploadedUrls.push(publicUrl);
        } catch (error) {
          console.warn("Image import skipped", imageUrl, error);
        }
      }

      if (uploadedUrls.length === 0) {
        throw new Error("Import failed: no images were saved to storage");
      }

      // Fetch + cache tech specs at import time so the product is "born warm"
      // — no visitor ever pays the cold-scrape cost. Failure here is non-fatal:
      // the carousel still imports, the tech-specs background warmer will
      // eventually populate the row on first carousel visit.
      let techSpecs: CachedTechSpecs | null = null;
      if (sourceProduct.sourceUrl) {
        try {
          techSpecs = (await fetchProductDetails(sourceProduct.sourceUrl)) as CachedTechSpecs;
        } catch (specError) {
          console.warn("Tech specs prefetch failed", specError);
        }
      }

      // Non-Shopify sources (e.g. Amazon fallback) can't be parsed by the
      // generic details scraper — synthesize the מידות section from the fields
      // the vendor scraper itself extracted, so the tech-specs modal is never
      // empty when we do know dimensions/weight.
      if ((!techSpecs || techSpecs.specs.length === 0) && (sourceProduct.dimensions || sourceProduct.weight)) {
        const items: Array<{ label: string; value: string }> = [];
        if (sourceProduct.weight) items.push({ label: "משקל", value: sourceProduct.weight });
        if (sourceProduct.dimensions) items.push({ label: "מידות", value: sourceProduct.dimensions });
        techSpecs = {
          specs: [{ heading: "מידות", items }],
          colors: techSpecs?.colors ?? [],
        };
      }

      // Enumerate every colour of this model and re-host a gallery per colour,
      // so a swatch click can swap the displayed product image. Non-fatal: a
      // failure just leaves the item without scraped colours (the colour warmer
      // can fill it in later).
      let colors: CarouselColor[] | null = null;
      if (sourceProduct.sourceUrl) {
        try {
          const variants = await vendorConfig.enumerateVariants(sourceProduct);
          if (variants.length > 0) {
            const galleryByHandle = await uploadVariantGalleries(
              `imports/${vendorConfig.storageFolder}/${normalizedCatalogNumber}/colors`,
              variants,
            );
            const mapped = vendorConfig.mapColors(variants, galleryByHandle);
            if (mapped.length > 0) colors = mapped;
          }
        } catch (colorError) {
          console.warn("Colour enumeration failed", colorError);
        }
      }

      const translatedDescription = await translateToHebrew(sourceProduct.description);
  const reviewedCopy = reviewedCopyFor(sourceProduct.catalogNumber || catalogNumber);

      const itemId = targetItemId ?? crypto.randomUUID();
      const importedItem: CarouselItem = {
        id: itemId,
        title: reviewedCopy?.title || sourceProduct.title || `${vendorConfig.label} ${catalogNumber}`,
        description: (
          reviewedCopy?.description ||
          translatedDescription ||
          sourceProduct.description ||
          `ייבוא אוטומטי לפי מק״ט ${catalogNumber} ממקור ${vendorConfig.label}`
        ).slice(0, 2000),
        catalogNumber: normalizedCatalogNumber,
        sourceUrl: sourceProduct.sourceUrl,
        coverImagePath: uploadedUrls[0],
        displayOrder: 1,
        isActive: true,
        color: sourceProduct.color || null,
        dimensions: sourceProduct.dimensions || null,
        weight: sourceProduct.weight || null,
        sizes: sourceProduct.sizes?.length ? sourceProduct.sizes : null,
        availableColors: sourceProduct.availableColors?.length
          ? sourceProduct.availableColors
          : null,
        techSpecs,
        colors,
        angles: uploadedUrls.map((imagePath, index) => ({
          id: crypto.randomUUID(),
          itemId,
          angleKey: angleKeyByIndex(index),
          imagePath,
          angleOrder: index + 1,
        })),
      };

      // Persist pre-fetched side-data (tech specs + colours) to the existing DB
      // row. Best-effort: a missing column or older row schema must not break the
      // import. (New items get this filled by the warmers after the row exists.)
      if (targetItemId && (techSpecs || colors)) {
        try {
          const supabase = createSupabaseServiceRoleClient();
          const update: Record<string, unknown> = {};
          if (techSpecs) update.tech_specs = techSpecs;
          if (colors) update.colors = colors;
          await supabase.from("carousel_items").update(update).eq("id", targetItemId);
        } catch (persistError) {
          console.warn("Side-data persist failed", persistError);
        }
      }

      return {
        ok: true,
        item: importedItem,
        source: {
          vendor,
          catalogNumber: normalizedCatalogNumber,
          sourceUrl: sourceProduct.sourceUrl,
          importedImages: uploadedUrls.length,
        },
      };
    }
  }
}

export function createImportRouteHandler(vendor: CatalogVendor) {
  return async function POST(req: NextRequest) {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const body = await req.json();
      const { catalogNumber, targetItemId } = importCatalogSchema.parse(body);

      const provider = createCatalogSourceProvider(vendor);
      const sourceProduct = await provider.fetchByCatalogNumber(catalogNumber);
      const result = await importSourceProduct(vendor, sourceProduct, targetItemId, catalogNumber);
      return NextResponse.json(result);
    } catch (error) {
      console.error(`POST /api/admin/import/${vendor} failed`, error);
      const message = error instanceof Error ? error.message : "Import failed";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  };
}
