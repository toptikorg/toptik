import reviewed from "./samsonite-reviewed.json";
import variants from "./samsonite-variants.json";
import type { CarouselItem } from "./types";

// This is a reviewed public Shopify snapshot, not a live inventory feed.
// Only gallery copy, specs, product photos and exact variant identities are used.
// Merchant prices and checkout availability remain the store's responsibility.
export const SAMSONITE_SNAPSHOT_AT = reviewed.snapshotAt;

export const SAMSONITE_VARIANT_IDS: Readonly<Record<string, string>> = Object.freeze(
  variants,
);

function skuKey(value: string | null | undefined): string {
  return value?.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

// Existing curated records always win, including inactive ones. This prevents
// a supplement from reverting an editor's changes or reviving a hidden item.
// Append only missing identities; do not mutate or reorder the caller's list.
export function appendSamsoniteItems(items: readonly CarouselItem[]): CarouselItem[] {
  const result = [...items];
  const existingSkus = new Set(items.map(item => skuKey(item.catalogNumber)).filter(Boolean));
  const existingIds = new Set(items.map(item => item.id));
  let displayOrder = items.reduce((highest, item) => Math.max(highest, item.displayOrder), -1) + 1;

  for (const record of reviewed.records) {
    const id = `shopify-${record.variantId}`;
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
