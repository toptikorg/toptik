import "server-only";
import type { CarouselPayload } from "../carousel/types";
import { assertReviewedCatalogMedia, assertReviewedManufacturerImport, assertReviewedMediaOperation, changedCatalogMedia, requireReviewedMedia, reviewedMediaRegistry } from "./reviewed-media-guard";
import { loadReviewedMedia, loadReviewedMediaForItems } from "./reviewed-media-store";
import { captureMediaSourceBytes } from "./media-source-bytes";

const needsReview = (error: unknown) => error instanceof Error && error.message === "MEDIA_REVIEW_REQUIRED";

/** Static approvals stay fast. Private registry availability never becomes a
 * dependency of an unchanged image or an ordinary price/copy update. */
export async function assertReviewedPersistedMedia(d: Parameters<typeof assertReviewedMediaOperation>[0], deadline: number) {
  try { assertReviewedMediaOperation(d); } catch (error) {
    if (!needsReview(error)) throw error;
    assertReviewedMediaOperation(d, reviewedMediaRegistry(await loadReviewedMedia(d.identity, deadline)));
  }
}

export async function assertReviewedCatalogSave(candidate: unknown, current: CarouselPayload, deadline: number) {
  const changed = changedCatalogMedia(candidate, current);
  let reviews = reviewedMediaRegistry();
  try { assertReviewedCatalogMedia(candidate, current, reviews); } catch (error) {
    if (!needsReview(error) || !changed.length) throw error;
    reviews = reviewedMediaRegistry(await loadReviewedMediaForItems(changed.map(r => r.itemId), deadline));
    assertReviewedCatalogMedia(candidate, current, reviews);
  }
  // A signed review approves the exact rendition, not arbitrary future bytes
  // served from the same URL. Recheck only changed sources before the CAS.
  for (const row of changed) {
    const old = current.items.find(i => i.id === row.itemId)!;
    const entries = reviews.items.filter(r => r.galleryId === old.id && r.sku === old.catalogNumber &&
      r.variantId === `gid://shopify/ProductVariant/${old.shopifyLink?.variantId}` && r.imageUrl === row.url);
    const entry = entries[0];
    if (!entry) throw new Error("MEDIA_REVIEW_REQUIRED");
    const identity = { itemId: entry.galleryId, productId: entry.productId, variantId: entry.variantId,
      exactGallerySku: entry.sku, exactShopifySku: entry.shopifySku, productHandle: old.shopifyLink?.handle ?? "" };
    const bytes = await captureMediaSourceBytes(identity, row.url, deadline);
    requireReviewedMedia(identity, row.url, bytes.sha256, reviews);
  }
}

export async function assertReviewedImport(itemId: string, sku: string, urls: string[], deadline: number) {
  try { assertReviewedManufacturerImport(itemId, sku, urls); } catch (error) {
    if (!needsReview(error)) throw error;
    assertReviewedManufacturerImport(itemId, sku, urls, reviewedMediaRegistry(await loadReviewedMediaForItems([itemId], deadline)));
  }
}
