import manifest from "./reviewed-media-manifest.json";
import type { CarouselPayload } from "../carousel/types";
import type { MediaIdentity } from "./media-sync-core";

export type ReviewedMediaEntry = {
  sku: string; shopifySku: string; productId: string; variantId: string; galleryId: string;
  imageUrl: string; sourceUrl: string | null; sourceImageSha256: string | null;
  evidence: string; decodedSha256?: string;
};
export type ReviewRegistry = { items: ReviewedMediaEntry[]; deniedUrls: string[]; deniedSha256: string[] };
type Proof = { product_gid: string; evidence_id: string; asset_key: string; content_id: string; side?: "gallery" | "shopify"; proof: Record<string, unknown> };
const registry: ReviewRegistry = manifest;
export function reviewedMediaRegistry(entries: ReviewedMediaEntry[] = []): ReviewRegistry {
  return { ...registry, items: [...registry.items, ...entries] };
}
export function changedCatalogMedia(input: unknown, current: CarouselPayload): { itemId: string; url: string }[] {
  if (!input || typeof input !== "object" || !("items" in input) || !Array.isArray(input.items)) hold("");
  const result: { itemId: string; url: string }[] = [];
  for (const next of (input as CarouselPayload).items) {
    const old = current.items.find(i => i.id === next.id);
    if (!old) hold(next.catalogNumber ?? "");
    if (next.coverImagePath !== old.coverImagePath) result.push({ itemId: next.id, url: next.coverImagePath });
    for (const angle of next.angles) if (!old.angles.some(a => a.id === angle.id && a.imagePath === angle.imagePath))
      result.push({ itemId: next.id, url: angle.imagePath });
  }
  return [...new Map(result.map(r => [r.itemId + "\n" + r.url, r])).values()];
}
const cleanUrl = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
const skuLabel = (sku: string) => /^[A-Za-z0-9._/-]{1,80}$/.test(sku) ? sku : "לא מזוהה";
function hold(sku: string): never {
  throw Object.assign(new Error("MEDIA_REVIEW_REQUIRED"), { reviewSku: skuLabel(sku) });
}
export function mediaReviewMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "MEDIA_REVIEW_REQUIRED") {
    const sku = "reviewSku" in error ? skuLabel(String(error.reviewSku)) : "לא מזוהה";
    return `MEDIA_REVIEW_REQUIRED: מק״ט ${sku}, התמונה ממתינה לאימות הדגם והצבע המדויקים לפני פרסום.`;
  }
  return error.message === "MEDIA_REVIEW_REJECTED" ? "MEDIA_REVIEW_REJECTED: תמונה שנמצאה משויכת לצבע שגוי, הפרסום נעצר." : null;
}
export function assertNotDeniedMedia(url: string, sha?: string, reviews: ReviewRegistry = registry) {
  if (reviews.deniedUrls.some(value => cleanUrl(value) === cleanUrl(url)) || (sha && reviews.deniedSha256.includes(sha))) {
    throw new Error("MEDIA_REVIEW_REJECTED");
  }
}
/** Server-owned visual review only. Alt text, filename, order and a similar
 * base model confer no approval. Upload-byte SHA is evidence, not a checksum
 * of Shopify's independently reencoded rendition. */
export function isReviewedMedia(identity: MediaIdentity, url: string, sha?: string, reviews: ReviewRegistry = registry) {
  assertNotDeniedMedia(url, sha, reviews);
  return reviews.items.some(r => r.sku === identity.exactGallerySku && r.shopifySku === identity.exactShopifySku &&
    r.productId === identity.productId && r.variantId === identity.variantId && r.galleryId === identity.itemId &&
    r.imageUrl === url && (!r.decodedSha256 || r.decodedSha256 === sha));
}
export function requireReviewedMedia(identity: MediaIdentity, url: string, sha?: string, reviews: ReviewRegistry = registry) {
  if (!isReviewedMedia(identity, url, sha, reviews)) hold(identity.exactGallerySku);
}

/** A verified Gallery CAS stores identical bytes without transformed lineage.
 * Resolve that narrow server-owned copy to one genuine Shopify proof, never
 * approve by a matching checksum alone or by an arbitrary owned-storage URL. */
function exactGalleryCopySource(identity: MediaIdentity, copy: Proof, proofs: Proof[]): Proof | null {
  const p = copy.proof, sha = p.decodedSha256;
  if (copy.side !== "gallery" || p.ownership !== "owned_storage" || typeof sha !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha) || copy.content_id !== sha ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(identity.itemId) ||
      [p.width, p.height, p.byteLength].some(v => !Number.isSafeInteger(v) || Number(v) < 1)) return null;
  const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" };
  const extension = typeof p.mime === "string" && Object.hasOwn(extensions, p.mime) ? extensions[p.mime] : undefined;
  if (!extension) return null;
  const path = `sync-media/${identity.itemId}/${sha}.${extension}`;
  if (p.platformRef !== path || p.url !== `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/${path}`) return null;
  const matches = proofs.filter(x => x.side === "shopify" && x.product_gid === identity.productId &&
    x.asset_key === copy.asset_key && x.content_id === copy.content_id && x.proof.decodedSha256 === sha);
  if (matches.length !== 1) return null;
  const source = matches[0], s = source.proof;
  if (s.ownership !== "reference_only" || typeof s.platformRef !== "string" || !/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(s.platformRef) ||
      s.mime !== p.mime || s.width !== p.width || s.height !== p.height || s.byteLength !== p.byteLength ||
      typeof s.url !== "string" || /[\s\\#]/.test(s.url)) return null;
  try {
    const url = new URL(s.url);
    if (url.href !== s.url || url.origin !== "https://cdn.shopify.com" || url.username || url.password || url.port ||
        !url.pathname.startsWith("/s/files/") || /%(?:2e|2f|5c)/i.test(url.pathname)) return null;
  } catch { return null; }
  return source;
}

/** These rows come only from the service-owned provenance RPC. SQL already
 * validates transformed proof parent/operation/verified transport receipts.
 * Follow that lineage with exact product, key and semantic content checks;
 * never accept a browser-provided operationId or arbitrary storage URL. */
export function isReviewedMediaProof(identity: MediaIdentity, initial: Proof, proofs: Proof[], reviews: ReviewRegistry = registry) {
  let p = initial;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (p.product_gid !== identity.productId || seen.has(p.evidence_id)) return false;
    seen.add(p.evidence_id);
    const url = String(p.proof.url ?? ""), sha = String(p.proof.decodedSha256 ?? "");
    if (isReviewedMedia(identity, url, sha, reviews)) return true;
    if (!("operationId" in p.proof) && !("sourceEvidenceId" in p.proof)) {
      const source = exactGalleryCopySource(identity, p, proofs);
      if (!source) return false;
      p = source;
      continue;
    }
    if (typeof p.proof.operationId !== "string" || typeof p.proof.sourceEvidenceId !== "string") return false;
    const parents = proofs.filter(x => x.evidence_id === p.proof.sourceEvidenceId && x.product_gid === identity.productId &&
      x.asset_key === p.asset_key && x.content_id === p.content_id);
    if (parents.length !== 1) return false;
    p = parents[0];
  }
  return false;
}

/** Guard already-queued attach/replace steps as well as newly planned ones.
 * Removing/reordering media and changing copy/prices remain available. */
export function assertReviewedMediaOperation(d: {
  identity: MediaIdentity; step: Record<string, unknown>; provenance: Record<string, unknown>[];
}, reviews: ReviewRegistry = registry) {
  const body = d.step.body as { kind?: string; target?: string; key?: string } | undefined;
  if (!body || !["attach", "replace_reference", "alt"].includes(body.kind ?? "")) return;
  const expected = d.step.expected_pair as Record<string, { assets?: { key: string; evidenceId: string; contentId: string }[] }>;
  const assets = expected?.[body.target ?? ""]?.assets?.filter(a => a.key === body.key) ?? [];
  if (assets.length !== 1) hold(d.identity.exactGallerySku);
  const a = assets[0], proofs = d.provenance as Proof[];
  const matches = proofs.filter(p => p.product_gid === d.identity.productId && p.evidence_id === a.evidenceId &&
    p.asset_key === a.key && p.content_id === a.contentId);
  if (matches.length !== 1) hold(d.identity.exactGallerySku);
  assertNotDeniedMedia(String(matches[0].proof.url), String(matches[0].proof.decodedSha256), reviews);
  // Alt-only cloning preserves the existing exact product image; it does not
  // authorize a new source image. The runtime independently validates its key.
  if (body.kind !== "alt" && !isReviewedMediaProof(d.identity, matches[0], proofs, reviews)) hold(d.identity.exactGallerySku);
}

/** Existing catalog saves are guarded before the original revision-checked
 * atomic RPC. Unchanged legacy fields are kept; there is no bulk approval. */
export function assertReviewedCatalogMedia(input: unknown, current: CarouselPayload, reviews: ReviewRegistry = registry) {
  // prepareExistingCatalogSave already validates the full payload schema.
  if (!input || typeof input !== "object" || !("items" in input) || !Array.isArray(input.items)) hold("");
  const candidate = input as CarouselPayload;
  for (const next of candidate.items) {
    const old = current.items.find(i => i.id === next.id);
    if (!old) hold(next.catalogNumber ?? "");
    const sameIdentity = old.catalogNumber === next.catalogNumber &&
      (next.shopifyLink === undefined || old.shopifyLink?.variantId === next.shopifyLink?.variantId);
    const approve = (url: string, unchanged: boolean) => {
      assertNotDeniedMedia(url, undefined, reviews);
      if (sameIdentity && unchanged) return;
      const exact = reviews.items.filter(r => r.galleryId === old.id && r.sku === next.catalogNumber &&
        r.variantId === `gid://shopify/ProductVariant/${old.shopifyLink?.variantId}` && r.imageUrl === url);
      if (!sameIdentity || !exact.length) hold(next.catalogNumber ?? "");
    };
    approve(next.coverImagePath, old.coverImagePath === next.coverImagePath);
    for (const angle of next.angles) approve(angle.imagePath, old.angles.some(a => a.id === angle.id && a.imagePath === angle.imagePath));
    // Legacy sibling-color galleries are preserved byte-for-byte. A changed
    // sibling needs its own independently reviewed SKU/variant assignment.
    assertReviewedColorAssignments(next.catalogNumber ?? "", next.colors, old.colors);
    for (const color of next.colors ?? []) for (const url of [color.imagePath, ...(color.angles ?? [])]) assertNotDeniedMedia(url, undefined, reviews);
  }
}

export function assertReviewedColorAssignments(sku: string, next: unknown, previous: unknown) {
  const assignment = (colors: unknown) => Array.isArray(colors) ? colors.map(c => ({
    sku: c.catalogNumber ?? null, name: c.name ?? null, code: c.colorCode ?? null,
    image: c.imagePath ?? null, angles: c.angles ?? [], source: c.sourceUrl ?? null,
  })) : [];
  if (JSON.stringify(assignment(next)) !== JSON.stringify(assignment(previous))) hold(sku);
}

/** Existing-product manufacturer imports can otherwise write color media
 * directly. Keep unreviewed source media out of that side-effect path. New
 * imports still stage private drafts under the separate creation approval. */
export function assertReviewedManufacturerImport(itemId: string, sku: string, urls: string[], reviews: ReviewRegistry = registry) {
  if (!urls.length || urls.some(url => {
    assertNotDeniedMedia(url, undefined, reviews);
    return !reviews.items.some(r => r.galleryId === itemId && r.sku === sku && (r.imageUrl === url || r.sourceUrl === url));
  })) hold(sku);
}
