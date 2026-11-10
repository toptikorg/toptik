import { createHash } from "node:crypto";
import type { ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml, descriptionTextFromHtml } from "./description-document";
import { isSafeShopifyProductHandle, normalizeSyncSku } from "./sync-rules";

type JsonRow = Record<string, unknown>;
export type CopyAdoptionResolution = "preserve_both" | "adopt_shopify";
export type CopyAdoptionCopy = { title: string; description: string; descriptionHtml: string | null; seoTitle: string | null; seoDescription: string | null };
export type CopyAdoptionObservation = {
  shopDomain: string; source: ShopifyOnboardingSnapshot;
  gallery: JsonRow & { id: string; catalog_number: string; is_active: boolean; copy_updated_at: string; editor_revision: number };
  binding: JsonRow & { product_gid: string; variant_gid: string; carousel_item_id: string; catalog_key: string; product_handle: string; is_published: boolean; source_updated_at: string | null };
  publicLink: JsonRow | null; approval: JsonRow | null; state: JsonRow | null; unresolvedOutbox: JsonRow[];
};
export type CopyAdoptionPlan = {
  policy: "reviewed-existing-copy-v1"; resolution: CopyAdoptionResolution; approved: false;
  sourceHash: string; galleryHash: string; planHash: string;
  observedSourceWatermark: string | null; poisonedWatermark: boolean;
  brand: string; category: string; observation: CopyAdoptionObservation;
  galleryCopy: CopyAdoptionCopy; shopifyCopy: CopyAdoptionCopy; proposedGalleryCopy: CopyAdoptionCopy;
  differences: Array<{ field: keyof CopyAdoptionCopy; gallery: string | null; shopify: string | null }>;
};
const BRANDS: Record<string, string> = {
  "mandarina duck": "Mandarina Duck", "bric's": "Bric's", "bric’s": "Bric's", brics: "Bric's",
  samsonite: "Samsonite", "american tourister": "American Tourister", "porsche design": "Porsche Design",
};
const TYPES: Record<string, string> = {
  "טרולי": "carryon", "carry-on luggage": "carryon", "cabin luggage": "carryon", "מזוודת עלייה למטוס": "carryon",
  "מזוודה": "suitcase", "checked luggage": "suitcase", "checked suitcase": "suitcase", "מזוודה לבטן המטוס": "suitcase",
  "תיק גב": "backpacks", backpack: "backpacks", "תיק גב למחשב": "laptop-bags", "תיק מחשב": "laptop-bags", "laptop bag": "laptop-bags",
  "תיק צד": "fashion-bags", "תיק כתף": "fashion-bags", "תיק יד": "fashion-bags", "פאוץ׳": "fashion-bags", "belt bag": "fashion-bags", "bum bag": "fashion-bags", "crossbody bag": "fashion-bags",
  "תיק נסיעות": "travel-bags", "travel bag": "travel-bags", "ארנק": "wallets", "ארנק עור": "wallets", wallet: "wallets",
  "נרתיק": "pouches", "תיק רחצה": "pouches", pouch: "pouches", "toiletry bag": "pouches",
};
const fail = (code: string): never => { throw new Error(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stable = (value: unknown): string => JSON.stringify(value === undefined ? null : value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export const copyAdoptionFingerprint = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");

/** No name/SKU guess, inventory test, or implicit permission to publish a draft. */
export function reviewedExistingCopyClassification(source: Pick<ShopifyOnboardingSnapshot, "vendor" | "productType">) {
  const brand = BRANDS[source.vendor.trim().toLowerCase()], category = TYPES[source.productType.trim().toLowerCase()];
  if (!brand || !category) fail("COPY_ADOPTION_CLASSIFICATION_REQUIRED");
  return { brand, category };
}
function galleryCopy(row: JsonRow): CopyAdoptionCopy {
  if (typeof row.title !== "string" || !row.title.trim() || (row.description !== null && typeof row.description !== "string") ||
      (row.description_html !== null && typeof row.description_html !== "string") ||
      (row.seo_title !== null && typeof row.seo_title !== "string") || (row.seo_description !== null && typeof row.seo_description !== "string")) fail("COPY_ADOPTION_GALLERY_INVALID");
  return { title: row.title as string, description: (row.description ?? "") as string, descriptionHtml: row.description_html as string | null,
    seoTitle: row.seo_title as string | null, seoDescription: row.seo_description as string | null };
}

/** Read-only review. The default preserves both independent copies; a diff never approves itself. */
export function planExistingCopyAdoption(input: CopyAdoptionObservation, resolution: CopyAdoptionResolution = "preserve_both"): CopyAdoptionPlan {
  const o = structuredClone(input), { source: p, gallery: g, binding: b } = o;
  if (resolution !== "preserve_both" && resolution !== "adopt_shopify") fail("COPY_ADOPTION_RESOLUTION_INVALID");
  if (o.shopDomain !== "toptikcoil.myshopify.com") fail("COPY_ADOPTION_SHOP_MISMATCH");
  if (p.status !== "ACTIVE" || !p.publishedOnPublication || !g.is_active || !b.is_published) fail("COPY_ADOPTION_NOT_PUBLIC");
  if (p.variants.length !== 1) fail("COPY_ADOPTION_SINGLE_VARIANT_REQUIRED");
  const v = p.variants[0], key = normalizeSyncSku(v.sku);
  if (!key || !/^gid:\/\/shopify\/Product\/\d+$/.test(p.id) || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(v.id) ||
      !isSafeShopifyProductHandle(p.handle) || !Number.isFinite(Date.parse(p.updatedAt)) ||
      b.product_gid !== p.id || b.variant_gid !== v.id || b.product_handle !== p.handle || b.carousel_item_id !== g.id ||
      b.catalog_key !== key || normalizeSyncSku(g.catalog_number) !== key || g.catalog_number !== v.sku ||
      !Number.isFinite(Date.parse(g.copy_updated_at)) || !Number.isSafeInteger(g.editor_revision) || g.editor_revision < 1 ||
      (b.source_updated_at !== null && !Number.isFinite(Date.parse(b.source_updated_at)))) fail("COPY_ADOPTION_IDENTITY_CONFLICT");
  if (!o.publicLink || o.publicLink.catalog_key !== key || o.publicLink.product_handle !== p.handle ||
      o.publicLink.variant_id !== v.id.split("/").at(-1) || o.publicLink.is_published !== true) fail("COPY_ADOPTION_PUBLICATION_CONFLICT");
  if (o.approval !== null || o.state !== null) fail("COPY_ADOPTION_ALREADY_BOOTSTRAPPED");
  if (o.unresolvedOutbox.length) fail("COPY_ADOPTION_OPEN_EDIT");
  const { brand, category } = reviewedExistingCopyClassification(p);
  assertSafeDescriptionHtml(p.descriptionHtml);
  if (!p.title.trim() || p.title.length > 120 || p.descriptionHtml.length > 250000 ||
      (p.seoTitle?.length ?? 0) > 512 || (p.seoDescription?.length ?? 0) > 5000) fail("COPY_ADOPTION_COPY_LIMIT");
  const local = galleryCopy(g), source: CopyAdoptionCopy = { title: p.title, description: descriptionTextFromHtml(p.descriptionHtml),
    descriptionHtml: p.descriptionHtml, seoTitle: p.seoTitle, seoDescription: p.seoDescription };
  const sourceHash = copyAdoptionFingerprint(p), galleryHash = copyAdoptionFingerprint({ gallery: g, binding: b, publicLink: o.publicLink, approval: o.approval, state: o.state, unresolvedOutbox: o.unresolvedOutbox });
  const differences = (Object.keys(source) as (keyof CopyAdoptionCopy)[]).filter(field => local[field] !== source[field])
    .map(field => ({ field, gallery: local[field], shopify: source[field] }));
  const unsigned = { policy: "reviewed-existing-copy-v1" as const, resolution, approved: false as const, sourceHash, galleryHash,
    observedSourceWatermark: b.source_updated_at, poisonedWatermark: b.source_updated_at !== null && Date.parse(b.source_updated_at) > Date.parse(p.updatedAt),
    brand, category, observation: o, galleryCopy: local, shopifyCopy: source, proposedGalleryCopy: resolution === "adopt_shopify" ? source : local, differences };
  return { ...unsigned, planHash: copyAdoptionFingerprint(unsigned) };
}

export type CopyAdoptionApproval = { approvalId: string; planHash: string; sourceHash: string; galleryHash: string;
  observedSourceWatermark: string | null; actorId: string; approvedAt: string; reviewReference: string };
export type CopyAdoptionReceipt = { approvalId: string; planHash: string; actorId: string; resolution: CopyAdoptionResolution; committedAt: string };
export type CopyAdoptionPorts = {
  /** Host verifies an owner role and supplies actorId. Browser assertions are not authority. */
  readReceipt(approvalId: string): Promise<CopyAdoptionReceipt | null>;
  withProductLease<T>(productGid: string, run: (leaseOwner: string) => Promise<T>): Promise<T>;
  readObservation(productGid: string): Promise<CopyAdoptionObservation>;
  /** Must recheck expected DB rows, open edits and the exact watermark under locks, then atomically
   * write eligibility, independent baselines, optional selected copy, and an immutable receipt.
   * It MUST NOT lower/rewrite the publication watermark or any Shopify field. */
  commitReviewed(plan: CopyAdoptionPlan, approval: CopyAdoptionApproval, leaseOwner: string): Promise<CopyAdoptionReceipt>;
};

/** No automatic adoption/replay loop. A lost reply is recovered from its immutable receipt. */
export async function applyReviewedCopyAdoption(plan: CopyAdoptionPlan, approval: CopyAdoptionApproval, ports: CopyAdoptionPorts) {
  const replan = planExistingCopyAdoption(plan.observation, plan.resolution);
  if (copyAdoptionFingerprint(replan) !== copyAdoptionFingerprint(plan) || approval.planHash !== plan.planHash || approval.sourceHash !== plan.sourceHash ||
      approval.galleryHash !== plan.galleryHash || approval.observedSourceWatermark !== plan.observedSourceWatermark ||
      !UUID.test(approval.approvalId) || !UUID.test(approval.actorId) ||
      !Number.isFinite(Date.parse(approval.approvedAt)) || !approval.reviewReference.trim()) fail("COPY_ADOPTION_REVIEW_REQUIRED");
  const prior = await ports.readReceipt(approval.approvalId);
  if (prior) {
    if (prior.planHash !== plan.planHash || prior.actorId !== approval.actorId || prior.resolution !== plan.resolution) fail("COPY_ADOPTION_RECEIPT_CONFLICT");
    return { receipt: prior, replayed: true, sourceVerifiedAfterCommit: false, galleryVerifiedAfterCommit: false };
  }
  return ports.withProductLease(plan.observation.source.id, async owner => {
    const fresh = planExistingCopyAdoption(await ports.readObservation(plan.observation.source.id), plan.resolution);
    if (fresh.planHash !== plan.planHash) fail("COPY_ADOPTION_OBSERVATION_CHANGED");
    const receipt = await ports.commitReviewed(fresh, approval, owner);
    // The DB receipt is authoritative even if a later Shopify read moves or fails. Never repeat a commit.
    let sourceVerifiedAfterCommit = false, galleryVerifiedAfterCommit = false;
    try {
      const after = await ports.readObservation(plan.observation.source.id);
      sourceVerifiedAfterCommit = copyAdoptionFingerprint(after.source) === plan.sourceHash;
      galleryVerifiedAfterCommit = stable(galleryCopy(after.gallery)) === stable(plan.proposedGalleryCopy) &&
        after.binding.source_updated_at === plan.observedSourceWatermark && after.approval?.enabled === true &&
        after.approval.product_gid === plan.observation.source.id && after.approval.catalog_key === plan.observation.binding.catalog_key &&
        stable(after.state?.gallery_baseline_payload) === stable(plan.proposedGalleryCopy) && stable(after.state?.shopify_baseline_payload) === stable(plan.shopifyCopy);
    } catch { /* preserved receipt, explicit incomplete readback */ }
    return { receipt, replayed: false, sourceVerifiedAfterCommit, galleryVerifiedAfterCommit };
  });
}
