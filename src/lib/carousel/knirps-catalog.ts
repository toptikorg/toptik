import reviewed from "../editorial/knirps-products.json";
import type { CarouselItem } from "./types";
import type { StoreClassification } from "./store-classification";

const skuKey = (value: string | null | undefined) =>
  value?.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";

/**
 * Public rendering only, using the same reviewed photos as /knirps.
 * The existing complete public store read supplies publication and variant
 * identity. A failed read, missing product or ambiguous SKU adds nothing.
 * Never write editor rows or invoke media registration/sync from this path.
 */
export function appendKnirpsItems(
  items: readonly CarouselItem[],
  store: ReadonlyMap<string, StoreClassification | null> | null,
): CarouselItem[] {
  const result = [...items];
  if (!store) return result;
  // Include inactive editor rows: a supplement must never undo a manual hide.
  const skus = new Set(items.map(item => skuKey(item.catalogNumber)).filter(Boolean));
  const ids = new Set(items.map(item => item.id));
  const handles = new Set(items.map(item => item.shopifyLink?.handle).filter(Boolean));
  let displayOrder = items.reduce((max, item) => Math.max(max, item.displayOrder), -1) + 1;
  for (const record of reviewed) {
    const key = skuKey(record.sku);
    const entry = store.get(key);
    const link = entry?.purchaseLink;
    const expectedHandle = new URL(record.purchaseUrl).pathname.split("/").pop();
    if (entry?.brand !== "brand:knirps" || !link?.isPublished ||
        link.handle !== expectedHandle || !/^\d+$/.test(link.variantId)) continue;
    const id = `shopify-${link.variantId}`;
    if (skus.has(key) || ids.has(id) || handles.has(link.handle)) continue;
    result.push({
      id, title: record.title, catalogNumber: record.sku,
      description: "למפרט, למחיר העדכני ולרכישה, עברו לעמוד המטרייה בחנות טופ תיק.",
      shopifyLink: { ...link }, sourceUrl: record.purchaseUrl,
      coverImagePath: record.images[0].src, coverImageAlt: record.images[0].alt,
      displayOrder: displayOrder++, isActive: true, colors: [],
      techSpecs: { specs: [{ heading: "פרטי מוצר", items: [{ label: "מותג", value: "Knirps" }] }], colors: [] },
      angles: record.images.map((image, index) => ({
        id: `${id}-angle-${index + 1}`, itemId: id, angleKey: `angle-${index + 1}`,
        imagePath: image.src, imageAlt: image.alt, angleOrder: index,
      })),
    });
    skus.add(key);
    ids.add(id);
    handles.add(link.handle);
  }
  return result;
}

