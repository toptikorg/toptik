import { createHash } from "node:crypto";
import { descriptionTextFromHtml } from "./description-document";
import { isSafeShopifyProductHandle, normalizeSyncSku, type VerifiedCopyEligibility } from "./sync-rules";
import type { ShopifyProductSnapshot } from "./admin-api";
import type { VisibleProductCopy } from "./sync-policy";

export const COPY_ACTIVATION_MANIFEST_SHA256 = "73dc8b7b0946266ab647c214126f9e23619f674188989e24fe0811a6200bae10";
export const COPY_ACTIVATION_MAX_BYTES = 2_000_000;
type JsonRow = Record<string, unknown>;
export type CopyActivationRow = {
  catalogKey: string; galleryItemId: string; gallerySku: string; shopifySku: string;
  eligibility: Omit<VerifiedCopyEligibility, "enabled" | "approval_id">;
  expectedBinding: JsonRow | null; expectedState: JsonRow | null; expectedPublicLink: JsonRow | null;
  galleryCopy: VisibleProductCopy; galleryCopyUpdatedAt: string;
  shopifySnapshot: ShopifyProductSnapshot;
  proposedBinding?: JsonRow | null; proposedPublicLink?: JsonRow | null; proposedBaseline?: JsonRow | null;
};
export type CopyActivationManifest = {
  rows: CopyActivationRow[];
  expectedGallery: Array<{ id: string; catalog_number: string; copy_updated_at: string; copy: VisibleProductCopy }>;
  counts: { selectedRows: number; readyRows: number; blockedRows: number; missingBaselineInserts: number; existingBaselineVerificationOnly: number };
};

export async function readCopyActivationBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > COPY_ACTIVATION_MAX_BYTES)) throw new Error("COPY_ACTIVATION_BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("COPY_ACTIVATION_BODY_MISSING");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > COPY_ACTIVATION_MAX_BYTES) { await reader.cancel(); throw new Error("COPY_ACTIVATION_BODY_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function copyEqual(left: VisibleProductCopy, right: VisibleProductCopy) {
  return left.title === right.title && left.description === right.description &&
    (left.descriptionHtml ?? null) === (right.descriptionHtml ?? null) &&
    left.seoTitle === right.seoTitle && left.seoDescription === right.seoDescription;
}

function assertCopy(copy: VisibleProductCopy) {
  if (!copy || typeof copy.title !== "string" || !copy.title.trim() || typeof copy.description !== "string" ||
      !(copy.descriptionHtml === null || typeof copy.descriptionHtml === "string") ||
      !(copy.seoTitle === null || typeof copy.seoTitle === "string") ||
      !(copy.seoDescription === null || typeof copy.seoDescription === "string") ||
      (typeof copy.descriptionHtml === "string" && descriptionTextFromHtml(copy.descriptionHtml) !== copy.description)) {
    throw new Error("COPY_ACTIVATION_COPY_INVALID");
  }
  // Preserve existing rich HTML, including legacy markup, without rendering or
  // resubmitting it. New rich edits are checked by the existing edit/write path.
}

/** Only a reviewed immutable artifact can create eligibility and baselines. */
export function parseReviewedCopyActivation(raw: Uint8Array): CopyActivationManifest {
  if (raw.byteLength > COPY_ACTIVATION_MAX_BYTES) throw new Error("COPY_ACTIVATION_BODY_TOO_LARGE");
  if (createHash("sha256").update(raw).digest("hex") !== COPY_ACTIVATION_MANIFEST_SHA256) throw new Error("COPY_ACTIVATION_NOT_APPROVED");
  const manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as CopyActivationManifest;
  if (manifest.rows?.length !== 78 || manifest.expectedGallery?.length !== 82 ||
      manifest.counts.selectedRows !== 78 || manifest.counts.readyRows !== 78 || manifest.counts.blockedRows !== 0 ||
      manifest.counts.missingBaselineInserts !== 20 || manifest.counts.existingBaselineVerificationOnly !== 58) throw new Error("COPY_ACTIVATION_MANIFEST_INVALID");
  const identities = new Set<string>();
  const gallery = new Map(manifest.expectedGallery.map(row => [row.id, row]));
  if (gallery.size !== 82 || new Set(manifest.expectedGallery.map(row => row.catalog_number)).size !== 82) throw new Error("COPY_ACTIVATION_DUPLICATE_IDENTITY");
  let inserts = 0;
  for (const row of manifest.rows) {
    const a = row.eligibility;
    const g = gallery.get(row.galleryItemId);
    for (const id of [a.catalog_key, a.carousel_item_id, a.product_gid, a.variant_gid]) {
      if (!id || identities.has(id)) throw new Error("COPY_ACTIVATION_DUPLICATE_IDENTITY");
      identities.add(id);
    }
    if (!g || g.catalog_number !== row.gallerySku || g.copy_updated_at !== row.galleryCopyUpdatedAt ||
        row.catalogKey !== normalizeSyncSku(row.gallerySku) || a.catalog_key !== row.catalogKey ||
        a.carousel_item_id !== row.galleryItemId || a.exact_gallery_sku !== row.gallerySku || a.exact_shopify_sku !== row.shopifySku ||
        a.approved_product_handle !== row.shopifySnapshot.handle || !isSafeShopifyProductHandle(a.approved_product_handle) ||
        a.approved_source_updated_at !== row.shopifySnapshot.updatedAt ||
        a.allowed_fields.length !== 4 || ["title", "description", "seoTitle", "seoDescription"].some(field => !a.allowed_fields.includes(field)) ||
        !copyEqual(g.copy, row.galleryCopy) || !Number.isFinite(Date.parse(row.galleryCopyUpdatedAt)) ||
        (row.gallerySku !== row.shopifySku && (!a.alias_evidence || !Object.keys(a.alias_evidence).length))) throw new Error("COPY_ACTIVATION_IDENTITY_MISMATCH");
    assertCopy(row.galleryCopy);
    assertCopy({ title: row.shopifySnapshot.title, description: descriptionTextFromHtml(row.shopifySnapshot.descriptionHtml),
      descriptionHtml: row.shopifySnapshot.descriptionHtml, seoTitle: row.shopifySnapshot.seoTitle, seoDescription: row.shopifySnapshot.seoDescription });
    assertCopyActivationProduct(row, row.shopifySnapshot);
    if (row.expectedBinding === null) {
      if (row.expectedState !== null || row.expectedPublicLink !== null || !row.proposedBinding || !row.proposedPublicLink || !row.proposedBaseline) throw new Error("COPY_ACTIVATION_BASELINE_INVALID");
      inserts++;
    } else if (!row.expectedState || !row.expectedPublicLink || row.proposedBinding || row.proposedPublicLink || row.proposedBaseline) {
      throw new Error("COPY_ACTIVATION_BASELINE_INVALID");
    }
  }
  if (inserts !== 20) throw new Error("COPY_ACTIVATION_BASELINE_INVALID");
  return manifest;
}

/** No name/normalized-SKU fallback: exact previously verified identifiers only. */
export function assertCopyActivationProduct(row: CopyActivationRow, product: ShopifyProductSnapshot | null) {
  const a = row.eligibility, old = row.shopifySnapshot;
  if (!product || product.id !== a.product_gid || product.handle !== a.approved_product_handle ||
      product.variants.length !== 1 || product.variants[0].id !== a.variant_gid || product.variants[0].sku !== a.exact_shopify_sku ||
      product.status !== "ACTIVE" || !product.publishedOnPublication || product.updatedAt !== old.updatedAt ||
      product.title !== old.title || product.descriptionHtml !== old.descriptionHtml || product.seoTitle !== old.seoTitle ||
      product.seoDescription !== old.seoDescription) throw new Error("COPY_ACTIVATION_SHOPIFY_CHANGED");
}

/** Bounded fresh reads; abort before committing if any of the 78 has changed. */
export async function revalidateCopyActivation(manifest: CopyActivationManifest, fetchProduct: (id: string) => Promise<ShopifyProductSnapshot | null>) {
  const deadline = Date.now() + 40_000;
  for (let start = 0; start < manifest.rows.length; start += 4) {
    if (Date.now() >= deadline) throw new Error("COPY_ACTIVATION_REVALIDATION_TIMEOUT");
    const batch = manifest.rows.slice(start, start + 4);
    const results = await Promise.allSettled(batch.map(async row => assertCopyActivationProduct(row, await fetchProduct(row.eligibility.product_gid))));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (Date.now() >= deadline) throw new Error("COPY_ACTIVATION_REVALIDATION_TIMEOUT");
  }
}
