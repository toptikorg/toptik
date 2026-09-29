import americanTourister from "./american-tourister-preview.json";
import type { CarouselItem } from "./types";

// Preview-only product packages (owner decision 2026-09-29). A package is a
// reviewed snapshot of products that exist in the TopTik Shopify store but are
// not yet in the gallery database. It is appended ONLY on a Vercel Preview
// deployment, for the owner to review there; Production never shows it, and
// nothing here writes to Shopify or Supabase. Prices and stock stay in Shopify.
//
// Rules the package data follows (american-tourister-preview.json):
// real product photos of the same SKU and colour only, exact Shopify variant
// identities for the purchase link, maker specifications with their source,
// Hebrew copy written from the maker's facts without machine translation.

export const PREVIEW_PACKAGE_SNAPSHOT_AT = americanTourister.snapshotAt;

export function isPreviewDeployment(vercelEnv: string | undefined = process.env.VERCEL_ENV): boolean {
  return vercelEnv === "preview";
}

function skuKey(value: string | null | undefined): string {
  return value?.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

// Same contract as appendSamsoniteItems: existing records (active or hidden)
// always win, nothing is reordered or mutated, only missing identities are
// appended — and only on a Preview deployment.
export function appendPreviewPackageItems(
  items: readonly CarouselItem[],
  vercelEnv: string | undefined = process.env.VERCEL_ENV,
): CarouselItem[] {
  const result = [...items];
  if (!isPreviewDeployment(vercelEnv)) return result;

  const existingSkus = new Set(items.map(item => skuKey(item.catalogNumber)).filter(Boolean));
  const existingIds = new Set(items.map(item => item.id));
  let displayOrder = items.reduce((highest, item) => Math.max(highest, item.displayOrder), -1) + 1;

  for (const record of americanTourister.records) {
    const id = `preview-shopify-${record.variantId}`;
    const key = skuKey(record.sku);
    if (existingSkus.has(key) || existingIds.has(id)) continue;

    const images = [...new Set([record.coverImagePath, ...record.imagePaths])];
    result.push({
      id,
      title: record.title,
      description: record.description,
      catalogNumber: record.sku,
      sourceUrl: record.sourceUrls[0],
      coverImagePath: record.coverImagePath,
      displayOrder: displayOrder++,
      isActive: true,
      angles: images.map((imagePath, index) => ({
        id: `${id}-angle-${index + 1}`,
        itemId: id,
        angleKey: `angle-${index + 1}`,
        imagePath,
        angleOrder: index,
      })),
      techSpecs: {
        category: record.category,
        specs: [{ heading: "פרטי מוצר", items: record.specs.map(spec => ({ ...spec })) }],
        colors: [],
      },
      colors: [],
    });
    existingSkus.add(key);
    existingIds.add(id);
  }
  return result;
}
