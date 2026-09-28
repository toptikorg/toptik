import type { CarouselCommerce, CarouselPayload } from "./types";
import type { StorefrontProduct, StorefrontSnapshot } from "./storefront-reader";

export function catalogIdentity(value: string | null | undefined): string {
  const key = (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^P\d{2}/.test(key) ? key.replace(/TU$/, "") : key;
}

function numericId(id: string, kind: string): string | null {
  return id.match(new RegExp(`^gid://shopify/${kind}/(\\d+)$`))?.[1] ?? null;
}

function productUrl(raw: string | null, variantId: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !["www.toptik.co.il", "toptik.co.il"].includes(url.hostname) ||
      !url.pathname.startsWith("/products/") || url.username || url.password || url.port) return null;
    url.hostname = "www.toptik.co.il";
    url.search = "";
    url.hash = "";
    url.searchParams.set("variant", variantId);
    return url.toString();
  } catch { return null; }
}

function imageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "cdn.shopify.com" || url.username || url.password || url.port) return null;
    return url.toString();
  } catch { return null; }
}

type Entry = { product: StorefrontProduct; variant: StorefrontProduct["variants"][number]; commerce: CarouselCommerce };

/** Pure, additive view. No database mutations, no quantity inference, no deletion.
 * Shopify public visibility is the owner's inventory proxy during this trial.
 * Existing gallery-only items stay visible without an unverified buy action.
 */
export function projectStorefront(
  curated: CarouselPayload,
  snapshot: StorefrontSnapshot,
  legacyVariantIds: Readonly<Record<string, string>> = {},
): CarouselPayload {
  const entries: Entry[] = [];
  const collections = new Map<string, StorefrontProduct["collections"][number]>();
  const publicProductIds = new Set<string>();
  for (const product of snapshot.products) {
    const productId = numericId(product.id, "Product");
    if (!productId || !product.onlineStoreUrl) continue;
    for (const variant of product.variants) {
      const variantId = numericId(variant.id, "ProductVariant");
      const url = variantId && productUrl(product.onlineStoreUrl, variantId);
      if (!variantId || !url) continue;
      publicProductIds.add(product.id);
      for (const collection of product.collections) collections.set(collection.id, collection);
      entries.push({ product, variant, commerce: {
        productId, variantId, productUrl: url,
        availableForSale: variant.availableForSale,
        price: variant.price.amount, currency: variant.price.currencyCode,
        vendor: product.vendor, collectionIds: product.collections.map(c => c.id),
        checkedAt: snapshot.fetchedAt,
      } });
    }
  }
  const byId = new Map(entries.map(entry => [entry.commerce.variantId, entry]));
  const bySku = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = catalogIdentity(entry.variant.sku);
    if (key) bySku.set(key, [...(bySku.get(key) ?? []), entry]);
  }
  const used = new Set<string>();
  let matchedCount = 0;
  const items = curated.items.map(item => {
    const key = catalogIdentity(item.catalogNumber);
    const candidates = bySku.get(key) ?? [];
    const pinnedId = legacyVariantIds[key];
    const pinned = pinnedId ? byId.get(pinnedId) : undefined;
    // A manual hide remains effective even when identity is ambiguous or a
    // historical variant changed SKU. Suppression never grants a buy mapping.
    if (!item.isActive) {
      for (const candidate of candidates) used.add(candidate.commerce.variantId);
      if (pinned) used.add(pinned.commerce.variantId);
    }
    // A bootstrap ID with a different SKU is quarantined, never silently reused.
    const pinMismatch = Boolean(pinned && catalogIdentity(pinned.variant.sku) !== key);
    const matched = !pinMismatch && candidates.length === 1 && (!pinnedId || !pinned || pinned === candidates[0])
      ? candidates[0] : undefined;
    if (!matched) return { ...item, commerce: null };
    used.add(matched.commerce.variantId); // Includes hidden curated rows: never re-add them.
    matchedCount++;
    return { ...item, commerce: matched.commerce };
  });
  let addedCount = 0;
  let displayOrder = Math.max(0, ...items.map(item => item.displayOrder));
  for (const entry of entries) {
    if (used.has(entry.commerce.variantId)) continue;
    const { product, variant, commerce } = entry;
    const id = `shopify-${commerce.variantId}`;
    const cover = imageUrl(variant.image?.url);
    const hasDifferentColors = new Set(product.variants.flatMap(v => v.selectedOptions
      .filter(option => /^(color|colour|צבע)$/i.test(option.name))
      .map(option => option.value))).size > 1;
    // Never claim that another colour's photograph is this variant's angle.
    const images = [...new Set([cover, ...(!hasDifferentColors ? product.images.map(img => imageUrl(img.url)) : [])]
      .filter((url): url is string => Boolean(url)))];
    const variantSuffix = variant.title && variant.title !== "Default Title" ? ` | ${variant.title}` : "";
    items.push({
      id, title: `${product.title}${variantSuffix}`, description: product.description || null,
      catalogNumber: variant.sku || null, sourceUrl: null,
      coverImagePath: images[0] ?? "", displayOrder: ++displayOrder, isActive: true,
      angles: images.map((path, index) => ({ id: `${id}-${index}`, itemId: id, angleKey: `store-${index + 1}`, imagePath: path, angleOrder: index + 1 })),
      techSpecs: {
        colors: [], specs: [{ heading: "פרטי המוצר בחנות", items: [
          ...(product.vendor ? [{ label: "מותג", value: product.vendor }] : []),
          ...(variant.sku ? [{ label: "מק״ט", value: variant.sku }] : []),
          ...variant.selectedOptions.filter(o => o.value !== "Default Title").map(o => ({ label: o.name, value: o.value })),
        ] }],
      },
      commerce,
    });
    addedCount++;
  }
  return {
    ...curated, items: items.filter(item => item.isActive), collections: [...collections.values()].sort((a, b) => a.title.localeCompare(b.title, "he")),
    sync: { status: "current", checkedAt: snapshot.fetchedAt, productCount: publicProductIds.size,
      variantCount: entries.length, matchedCount, addedCount },
  };
}

export function withoutVerifiedPurchases(payload: CarouselPayload): CarouselPayload {
  return { ...payload, items: payload.items.filter(item => item.isActive).map(item => ({ ...item, commerce: null })),
    sync: { status: "unavailable", checkedAt: null, productCount: 0, variantCount: 0, matchedCount: 0, addedCount: 0 } };
}
