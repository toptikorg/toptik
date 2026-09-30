import { createHash } from "node:crypto";
import { carouselItemInputSchema } from "@/lib/validation/carousel";
import { assertSafeDescriptionHtml, descriptionTextFromHtml } from "./description-document";
import type { ShopifyCatalogSeedSnapshot } from "./admin-api";

// One reviewed document only. A new document requires another reviewed release.
export const CATALOG_SEED_MANIFEST_SHA256 = "20fe79f0ce7af46ccc923b5ad1d99cd5dd58e814bd5cc54cfbe4f3cf21d56cf0";
export const CATALOG_SEED_MAX_BYTES = 2_000_000;

type SeedCopy = { title: string; description: string; descriptionHtml: string; seoTitle: string | null; seoDescription: string | null };
type SeedItem = {
  id: string; title: string; description: string; description_html: string;
  seo_title: string | null; seo_description: string | null; copy_updated_at: string;
  catalog_number: string; source_url: string; cover_image_path: string; display_order: number;
  is_active: boolean; color: string | null; dimensions: string | null; weight: string | null;
  sizes: string[] | null; available_colors: string[] | null; tech_specs: unknown; colors: unknown;
};
export type CatalogSeedRow = {
  sku: string; catalogKey: string; persistedItemId: string;
  proposedItemInsert: SeedItem;
  proposedAngleInserts: Array<{ id: string; item_id: string; angle_key: string; image_path: string; angle_order: number }>;
  proposedBinding: { catalog_key: string; carousel_item_id: string; product_gid: string; variant_gid: string; product_handle: string; is_published: boolean; source_updated_at: string };
  proposedPublicLink: { catalog_key: string; product_handle: string; variant_id: string; is_published: boolean };
  proposedBaseline: { catalog_key: string; gallery_baseline_payload: SeedCopy; shopify_baseline_payload: SeedCopy; last_synced_payload: SeedCopy };
  shopifySnapshot: {
    productGid: string; variantGid: string; handle: string; title: string; sourceUpdatedAt: string;
    status: string; publishedOnOnlineStore: boolean; rawDescriptionHtml: string;
    seo: { title: string | null; description: string | null };
    media: ShopifyCatalogSeedSnapshot["media"];
  };
};
export type CatalogSeedManifest = {
  rows: CatalogSeedRow[];
  expectedExistingItems: Array<{ id: string; catalog_number: string }>;
  counts: { proposedItemRows: number; proposedAngleRows: number; blockingRows: number };
  errors: unknown[];
};

export async function readCatalogSeedBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > CATALOG_SEED_MAX_BYTES)) throw new Error("CATALOG_SEED_BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("CATALOG_SEED_BODY_MISSING");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > CATALOG_SEED_MAX_BYTES) {
        await reader.cancel();
        throw new Error("CATALOG_SEED_BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function assertPair(copy: SeedCopy) {
  assertSafeDescriptionHtml(copy.descriptionHtml);
  if (descriptionTextFromHtml(copy.descriptionHtml) !== copy.description) throw new Error("CATALOG_SEED_DESCRIPTION_PAIR_MISMATCH");
}

export function parseReviewedCatalogSeed(raw: Uint8Array): CatalogSeedManifest {
  if (raw.byteLength > CATALOG_SEED_MAX_BYTES) throw new Error("CATALOG_SEED_BODY_TOO_LARGE");
  if (createHash("sha256").update(raw).digest("hex") !== CATALOG_SEED_MANIFEST_SHA256) throw new Error("CATALOG_SEED_MANIFEST_NOT_APPROVED");
  const manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as CatalogSeedManifest;
  if (!Array.isArray(manifest.rows) || manifest.rows.length !== 57 || manifest.counts.proposedItemRows !== 57 ||
      manifest.counts.proposedAngleRows !== 355 || manifest.counts.blockingRows !== 0 || manifest.errors.length ||
      !Array.isArray(manifest.expectedExistingItems) || manifest.expectedExistingItems.length !== 25) throw new Error("CATALOG_SEED_MANIFEST_INVALID");
  const identities = new Set<string>();
  let angleCount = 0;
  for (const row of manifest.rows) {
    const item = row.proposedItemInsert;
    const binding = row.proposedBinding;
    for (const identity of [row.catalogKey, row.persistedItemId, binding.product_gid, binding.variant_gid]) {
      if (identities.has(identity)) throw new Error("CATALOG_SEED_DUPLICATE_IDENTITY");
      identities.add(identity);
    }
    if (item.id !== row.persistedItemId || item.catalog_number !== row.sku || row.catalogKey !== row.sku ||
        binding.catalog_key !== row.catalogKey || binding.carousel_item_id !== item.id || !binding.is_published ||
        row.proposedPublicLink.catalog_key !== row.catalogKey || !row.proposedPublicLink.is_published ||
        row.proposedPublicLink.variant_id !== binding.variant_gid.split("/").at(-1) ||
        row.proposedPublicLink.product_handle !== binding.product_handle) throw new Error("CATALOG_SEED_IDENTITY_MISMATCH");
    const parsed = carouselItemInputSchema.safeParse({
      id: item.id, title: item.title, description: item.description, descriptionHtml: item.description_html,
      seoTitle: item.seo_title, seoDescription: item.seo_description, copyUpdatedAt: item.copy_updated_at,
      catalogNumber: item.catalog_number, sourceUrl: item.source_url, coverImagePath: item.cover_image_path,
      displayOrder: item.display_order, isActive: item.is_active, color: item.color, dimensions: item.dimensions,
      weight: item.weight, sizes: item.sizes, availableColors: item.available_colors, techSpecs: item.tech_specs, colors: item.colors,
      angles: row.proposedAngleInserts.map(angle => ({ id: angle.id, angleKey: angle.angle_key, imagePath: angle.image_path, angleOrder: angle.angle_order })),
    });
    if (!parsed.success) throw new Error("CATALOG_SEED_EDITOR_SCHEMA_MISMATCH");
    row.proposedAngleInserts.forEach((angle, index) => {
      if (angle.item_id !== item.id || angle.angle_order !== index + 1 || identities.has(angle.id)) throw new Error("CATALOG_SEED_ANGLE_MISMATCH");
      identities.add(angle.id);
      angleCount++;
    });
    const galleryCopy = { title: item.title, description: item.description, descriptionHtml: item.description_html, seoTitle: item.seo_title, seoDescription: item.seo_description };
    assertPair(galleryCopy);
    assertPair(row.proposedBaseline.gallery_baseline_payload);
    assertPair(row.proposedBaseline.shopify_baseline_payload);
    if (JSON.stringify(galleryCopy) !== JSON.stringify(row.proposedBaseline.gallery_baseline_payload)) throw new Error("CATALOG_SEED_GALLERY_BASELINE_MISMATCH");
    const shop = row.shopifySnapshot;
    const shopCopy = { title: shop.title, description: descriptionTextFromHtml(shop.rawDescriptionHtml), descriptionHtml: shop.rawDescriptionHtml, seoTitle: shop.seo.title, seoDescription: shop.seo.description };
    assertPair(shopCopy);
    if (JSON.stringify(shopCopy) !== JSON.stringify(row.proposedBaseline.shopify_baseline_payload) ||
        JSON.stringify(shopCopy) !== JSON.stringify(row.proposedBaseline.last_synced_payload)) throw new Error("CATALOG_SEED_SHOPIFY_BASELINE_MISMATCH");
  }
  if (angleCount !== 355) throw new Error("CATALOG_SEED_ANGLE_COUNT_MISMATCH");
  return manifest;
}

function mediaSignature(media: ShopifyCatalogSeedSnapshot["media"]) {
  return JSON.stringify(media.map(item => [item.id, item.mediaContentType, item.status, item.alt,
    item.image?.url ?? null, item.image?.altText ?? null, item.image?.width ?? null, item.image?.height ?? null]));
}

export function assertCatalogSeedProduct(row: CatalogSeedRow, product: ShopifyCatalogSeedSnapshot | null) {
  const expected = row.shopifySnapshot;
  const variant = product?.variants[0];
  if (!product || product.id !== expected.productGid || product.id !== row.proposedBinding.product_gid ||
      product.variants.length !== 1 || variant?.id !== expected.variantGid || variant.id !== row.proposedBinding.variant_gid ||
      variant.sku !== row.sku || product.handle !== expected.handle || product.handle !== row.proposedBinding.product_handle ||
      product.status !== "ACTIVE" || !product.publishedOnPublication || product.updatedAt !== expected.sourceUpdatedAt ||
      product.updatedAt !== row.proposedBinding.source_updated_at || product.title !== expected.title ||
      product.descriptionHtml !== expected.rawDescriptionHtml || product.seoTitle !== expected.seo.title ||
      product.seoDescription !== expected.seo.description || mediaSignature(product.media) !== mediaSignature(expected.media)) {
    throw new Error("CATALOG_SEED_SHOPIFY_SNAPSHOT_CHANGED");
  }
  const urls = new Set(product.media.filter(media => media.status === "READY" && media.mediaContentType === "IMAGE").map(media => media.image?.url));
  if (!urls.has(row.proposedItemInsert.cover_image_path) || row.proposedAngleInserts.some(angle => !urls.has(angle.image_path))) throw new Error("CATALOG_SEED_MEDIA_MISMATCH");
}

/** At most four reads in flight; do not start another batch after 40 seconds. */
export async function revalidateCatalogSeedProducts(manifest: CatalogSeedManifest, fetchProduct: (id: string) => Promise<ShopifyCatalogSeedSnapshot | null>) {
  const deadline = Date.now() + 40_000;
  for (let start = 0; start < manifest.rows.length; start += 4) {
    if (Date.now() >= deadline) throw new Error("CATALOG_SEED_REVALIDATION_TIMEOUT");
    const batch = manifest.rows.slice(start, start + 4);
    const results = await Promise.allSettled(batch.map(async row => assertCatalogSeedProduct(row, await fetchProduct(row.shopifySnapshot.productGid))));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (Date.now() >= deadline) throw new Error("CATALOG_SEED_REVALIDATION_TIMEOUT");
  }
}
