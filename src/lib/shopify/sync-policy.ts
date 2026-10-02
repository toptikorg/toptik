import { descriptionPairsEquivalent } from "./description-document";

export type VisibleProductCopy = {
  title: string;
  description: string;
  /** null/undefined means legacy representation unknown; empty string means clear. */
  descriptionHtml?: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type CopyField = Exclude<keyof VisibleProductCopy, "descriptionHtml">;
export type CopyMergeResult = {
  copy: VisibleProductCopy;
  shopifyCopy: VisibleProductCopy;
  galleryCopy: VisibleProductCopy;
  shopifyChanged: boolean;
  galleryChanged: boolean;
  conflicts: Array<{ field: CopyField; winner: "gallery" | "shopify" | "review" }>;
};

const fields = ["title", "seoTitle", "seoDescription"] as const;
const nonEmpty = (value: string | null): boolean => Boolean(value?.trim());

const hasDescriptionHtml = (copy: VisibleProductCopy): boolean => typeof copy.descriptionHtml === "string";
const descriptionSame = (left: VisibleProductCopy, right: VisibleProductCopy): boolean =>
  descriptionPairsEquivalent(left, right);

/** Readback tolerates Shopify's equivalent HTML serialization, never removed structure. */
export function visibleCopiesEquivalent(left: VisibleProductCopy, right: VisibleProductCopy): boolean {
  return fields.every(field => left[field] === right[field]) && descriptionSame(left, right);
}

function assignDescription(target: VisibleProductCopy, source: VisibleProductCopy) {
  target.description = source.description;
  if (source.descriptionHtml === undefined) delete target.descriptionHtml;
  else target.descriptionHtml = source.descriptionHtml;
}

function descriptionChangedFrom(copy: VisibleProductCopy, baseline: VisibleProductCopy): boolean {
  // A version-1 baseline has no HTML evidence. Hydrate it from the current
  // snapshot instead of treating markup first observed after upgrade as an edit.
  return hasDescriptionHtml(copy) && hasDescriptionHtml(baseline)
    ? !descriptionSame(copy, baseline)
    : copy.description !== baseline.description;
}

/**
 * Deterministic, field-level bidirectional merge.
 * - A one-sided edit wins only that field.
 * - Simultaneous edits to one field use source timestamps; Shopify wins ties.
 * - On first binding, a value present on only one side fills the empty side.
 *   Different non-empty values are preserved independently and become
 *   side-specific baselines; they are not treated as new edits.
 * - After binding, each side is compared with its own last-synced snapshot.
 *   One-sided edits propagate field-by-field. Concurrent same-field edits use
 *   best-available timestamps and are returned for a private audit record.
 */
export function mergeVisibleProductCopy(
  gallery: VisibleProductCopy,
  shopify: VisibleProductCopy,
  lastSynced: VisibleProductCopy | null,
  galleryUpdatedAt: string,
  shopifyUpdatedAt: string,
  galleryBaseline: VisibleProductCopy | null = lastSynced,
  shopifyBaseline: VisibleProductCopy | null = lastSynced,
): CopyMergeResult {
  const shopifyCopy = { ...shopify };
  const galleryCopy = { ...gallery };
  const result = { ...shopify };
  const hasSideBaselines = galleryBaseline !== null && shopifyBaseline !== null;
  const conflicts: CopyMergeResult["conflicts"] = [];
  const parsedGalleryTime = Date.parse(galleryUpdatedAt);
  const parsedShopifyTime = Date.parse(shopifyUpdatedAt);
  const timestampsValid = Number.isFinite(parsedGalleryTime) && Number.isFinite(parsedShopifyTime);
  const galleryTime = timestampsValid ? parsedGalleryTime : 0;
  const shopifyTime = timestampsValid ? parsedShopifyTime : 0;

  for (const field of fields) {
    const galleryValue = gallery[field];
    const shopifyValue = shopify[field];
    if (galleryValue === shopifyValue) {
      result[field] = galleryValue as never;
      continue;
    }

    if (!hasSideBaselines) {
      const shopifyHasValue = nonEmpty(shopifyValue);
      const galleryHasValue = nonEmpty(galleryValue);
      if (galleryHasValue && !shopifyHasValue) {
        shopifyCopy[field] = galleryValue as never;
        result[field] = galleryValue as never;
      } else if (shopifyHasValue && !galleryHasValue) {
        galleryCopy[field] = shopifyValue as never;
        result[field] = shopifyValue as never;
      }
      // Different non-empty initial values are preserved on both sides.
      continue;
    }

    const galleryChanged = galleryValue !== galleryBaseline[field];
    const shopifyChanged = shopifyValue !== shopifyBaseline[field];
    if (!galleryChanged && !shopifyChanged) continue;

    let winner: "gallery" | "shopify";
    if (galleryChanged && !shopifyChanged) winner = "gallery";
    else if (shopifyChanged && !galleryChanged) winner = "shopify";
    else if (galleryValue === shopifyValue) continue;
    else winner = timestampsValid && galleryTime > shopifyTime ? "gallery" : "shopify";
    if (galleryChanged && shopifyChanged && galleryValue !== shopifyValue) conflicts.push({ field, winner });

    const winningValue = (winner === "gallery" ? galleryValue : shopifyValue) as never;
    shopifyCopy[field] = winningValue;
    galleryCopy[field] = winningValue;
    result[field] = winningValue;
  }

  // Description text and its rich document are one indivisible field. Initial
  // equal text can adopt the known rich representation without erasing markup.
  if (galleryCopy.description === shopifyCopy.description) {
    if (!hasDescriptionHtml(galleryCopy) && hasDescriptionHtml(shopifyCopy)) assignDescription(galleryCopy, shopifyCopy);
    else if (!hasDescriptionHtml(shopifyCopy) && hasDescriptionHtml(galleryCopy)) assignDescription(shopifyCopy, galleryCopy);
  }
  if (!descriptionSame(galleryCopy, shopifyCopy)) {
    if (!hasSideBaselines) {
      const galleryHasValue = nonEmpty(galleryCopy.description) || Boolean(galleryCopy.descriptionHtml?.trim());
      const shopifyHasValue = nonEmpty(shopifyCopy.description) || Boolean(shopifyCopy.descriptionHtml?.trim());
      if (galleryHasValue && !shopifyHasValue) assignDescription(shopifyCopy, galleryCopy);
      else if (shopifyHasValue && !galleryHasValue) assignDescription(galleryCopy, shopifyCopy);
    } else {
      const galleryChanged = descriptionChangedFrom(gallery, galleryBaseline);
      const shopifyChanged = descriptionChangedFrom(shopify, shopifyBaseline);
      if (galleryChanged || shopifyChanged) {
        const winner = galleryChanged && !shopifyChanged ? "gallery" :
          shopifyChanged && !galleryChanged ? "shopify" :
          timestampsValid && galleryTime > shopifyTime ? "gallery" : "shopify";
        if (galleryChanged && shopifyChanged) conflicts.push({ field: "description", winner });
        const winning = winner === "gallery" ? galleryCopy : shopifyCopy;
        assignDescription(galleryCopy, winning);
        assignDescription(shopifyCopy, winning);
      }
    }
  }
  assignDescription(result, shopifyCopy);

  return {
    copy: result,
    shopifyCopy,
    galleryCopy,
    shopifyChanged: !visibleCopiesEquivalent(shopifyCopy, shopify) || hasDescriptionHtml(shopifyCopy) !== hasDescriptionHtml(shopify),
    galleryChanged: !visibleCopiesEquivalent(galleryCopy, gallery) || hasDescriptionHtml(galleryCopy) !== hasDescriptionHtml(gallery),
    conflicts,
  };
}

const REVIEW_CODES = new Set([
  "SYNC_ONBOARDING_IDENTITY_INVALID",
  "SYNC_ONBOARDING_PRODUCT_ID_INVALID",
  "SYNC_ONBOARDING_PUBLICATION_MISMATCH",
  "SYNC_ONBOARDING_EVENT_ID_INVALID",
  "SYNC_ONBOARDING_MULTIPLE_VARIANTS",
  "SYNC_ONBOARDING_COPY_LIMIT",
  "SYNC_ONBOARDING_HTML_UNSAFE",
  "SYNC_ONBOARDING_MEDIA_LIMIT",
  "SYNC_ONBOARDING_MEDIA_IDENTITY_INVALID",
  "SYNC_ONBOARDING_IMAGE_HOST_UNSAFE",
  "SYNC_ONBOARDING_IMAGE_TOO_LARGE",
  "SYNC_ONBOARDING_SHOPIFY_SKU_COLLISION",
  "SYNC_ONBOARDING_GALLERY_SKU_COLLISION",
  "SYNC_ONBOARDING_CATALOG_LIMIT",
  "SYNC_ONBOARDING_SHOP_MISMATCH",
  "SYNC_ONBOARDING_NOT_ENABLED",
  "SYNC_ONBOARDING_EVIDENCE_INVALID",
  "SYNC_ONBOARDING_TIMESTAMP_INVALID",
  "SYNC_ONBOARDING_COPY_INVALID",
  "SYNC_ONBOARDING_MEDIA_INVALID",
  "SYNC_ONBOARDING_EVENT_INVALID",
  "SYNC_ONBOARDING_HELD_PRODUCT",
  "SYNC_ONBOARDING_IDEMPOTENCY_CONFLICT",
  "SYNC_ONBOARDING_CATALOG_CAPACITY",
  "SYNC_CANARY_DELETE_DISABLED",
  "SYNC_COPY_NOT_APPROVED",
  "SYNC_VERIFIED_COPY_IDENTITY_CONFLICT",
  "SYNC_VERIFIED_BASELINE_REQUIRED",
  "SYNC_VERIFIED_DELETE_DISABLED",
  "SYNC_MODE_NOT_CONFIGURED",
  "SYNC_CANARY_NOT_CONFIGURED",
  "SYNC_CANARY_VARIANT_AMBIGUOUS",
  "SYNC_CANARY_PRODUCT_HAS_MULTIPLE_VARIANTS",
  "SYNC_SKU_OUTSIDE_CANARY",
  "SYNC_OUTBOX_PAYLOAD_INVALID",
  "SYNC_OUTBOX_SKU_MISMATCH",
  "SYNC_BINDING_MISSING_OR_CONFLICTED",
  "SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS",
  "SYNC_SHOPIFY_PRODUCT_MISSING",
  "SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT",
  "SYNC_SHOPIFY_PRODUCT_IDENTITY_CONFLICT",
  "SYNC_COPY_CONCURRENT_UPDATE",
  "SYNC_COPY_READBACK_MISMATCH",
  "SHOPIFY_PRODUCT_COPY_WRITE_REJECTED",
  "SHOPIFY_PRODUCT_COPY_WRITE_MISSING",
  "SYNC_DESCRIPTION_HTML_UNSAFE",
  "SYNC_DESCRIPTION_PAIR_MISMATCH",
  "SYNC_DESCRIPTION_RICH_EDITOR_REQUIRED",
]);

export function isSyncReviewCode(code: string): boolean {
  return REVIEW_CODES.has(code) || code === "SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED";
}
