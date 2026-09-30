import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSafeDescriptionHtml, canonicalDescriptionHtml, descriptionTextFromHtml, plainDescriptionToHtml } from "./description-document";
import { normalizeSyncSku } from "./sync-rules";

/** Pure, private policy. No API/DB calls and no path that publishes a product. */
export const GALLERY_CREATION_POLICY = "gallery-shopify-draft-v1";
export const CREATION_SHOP = "toptikcoil.myshopify.com";
export const CREATION_CUSTOM_ID_KEY = "source_item_id";
export const CREATION_SOURCE_HASH_KEY = "creation_source_hash";
export const CREATION_STORAGE_ORIGIN = "https://ekgpaoavsavrtbhlbwdg.supabase.co";
const HELD_KEYS = new Set(["P10OSV0405J", "P10ZJT0624U", "ORI05500909", "ORI05500024"]);
const ISO = z.string().datetime({ offset: true });
const SKU = z.string().min(2).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._ /-]*$/)
  .refine(value => value === value.trim());
const MONEY = z.string().regex(/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/)
  .refine(value => Number(value) > 0);
const mediaSchema = z.object({ url: z.string().min(1).max(2048), alt: z.string().min(1).max(200) }).strict();

export const galleryCreationDraftSchema = z.object({
  galleryItemId: z.string().uuid().transform(value => value.toLowerCase()),
  copyUpdatedAt: ISO,
  /** Exact sellable/store identity. Never replace it with a manufacturer model. */
  shopifySku: SKU,
  manufacturerSku: SKU.nullable(),
  /** Required when the two raw identifiers differ. Persisted private evidence. */
  identityMapping: z.object({
    shopifySku: SKU, manufacturerSku: SKU, sourceUrl: z.string().url().max(2000),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), verifiedAt: ISO,
  }).strict().nullable(),
  brand: z.enum(["Mandarina Duck", "Bric's", "Samsonite"]),
  category: z.enum(["carryon", "suitcase"]).nullable(),
  copy: z.object({ title: z.string().min(1).max(120), description: z.string().max(50000),
    descriptionHtml: z.string().max(200000).nullable(), seoTitle: z.string().max(512).nullable(),
    seoDescription: z.string().max(5000).nullable() }).strict(),
  media: z.array(mediaSchema).min(1).max(10),
  commerce: z.object({
    sellingPrice: MONEY.nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
    compareAtPrice: MONEY.nullable(), barcode: z.string().min(1).max(64).nullable(),
    taxable: z.boolean().nullable(), requiresShipping: z.literal(true),
    // Unknown stock is not zero stock and never permission to disable tracking.
    inventory: z.object({ status: z.literal("unknown") }).strict(),
    storeIntent: z.literal("draft"),
  }).strict(),
}).strict();

export type GalleryCreationDraft = z.infer<typeof galleryCreationDraftSchema>;
export type CustomIdDefinition = {
  namespace: string; key: string; ownerType: string; type: string; uniqueValuesEnabled: boolean;
};
export type DecodedCreationImage = {
  url: string; galleryItemId: string; exactSku: string; sha256: string; mime: string;
  width: number; height: number; byteLength: number; verifiedAt: string;
};
export type CreationCatalogProof = {
  complete: boolean; capturedAt: string;
  gallery: Array<{ id: string; catalogNumber: string | null; isActive: boolean }>;
  shopify: Array<{ productGid: string; variantGid: string; sku: string | null; status: string }>;
};
export type DraftReadinessContext = {
  mode: string | undefined; now: number; shopDomain: string; shopCurrency: string;
  expectedAppNamespace: string; definition: CustomIdDefinition;
  catalog: CreationCatalogProof; images: DecodedCreationImage[];
  /** Server-read immutable receipt and current custom-ID lookup, never browser input. */
  recovery?: { receipt: GalleryCreationReceipt; snapshot: OwnedDraftSnapshot };
};
export type ReadyGalleryDraft = {
  policyVersion: typeof GALLERY_CREATION_POLICY; draft: GalleryCreationDraft; catalogKey: string;
  sourceFingerprint: string; customId: { namespace: string; key: string; value: string };
  imageEvidence: DecodedCreationImage[]; readyForPublication: false;
  outstanding: Array<"selling_price" | "tax_policy" | "inventory" | "publication_not_supported_v1">;
};

function fail(code: string): never { throw new Error(`SYNC_CREATION_${code}`); }
function fresh(value: string, now: number) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= now - 300000 && time <= now + 30000;
}
function money(value: string) { return Number(value).toFixed(2); }
export function galleryCreationFingerprint(draft: GalleryCreationDraft): string {
  // Parsing fixes property order; unknown fields cannot disappear into the hash.
  const parsed = galleryCreationDraftSchema.safeParse(draft);
  if (!parsed.success) fail("DRAFT_INVALID");
  return createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
}

/** Freeze image content too. Re-verification time changes are not content edits. */
export function galleryCreationIntentFingerprint(draft: GalleryCreationDraft, images: DecodedCreationImage[]): string {
  return createHash("sha256").update(JSON.stringify({ source: galleryCreationFingerprint(draft),
    images: images.map(image => ({ url: image.url, galleryItemId: image.galleryItemId, exactSku: image.exactSku,
      sha256: image.sha256, mime: image.mime, width: image.width, height: image.height, byteLength: image.byteLength })) })).digest("hex");
}

export function approvedCreationImageUrl(raw: string): boolean {
  if (/[\s\\#]/.test(raw) || raw.length > 2048) return false;
  const bases = [CREATION_STORAGE_ORIGIN + "/storage/v1/object/public/carousel-media/", "https://cdn.shopify.com/s/files/"];
  const base = bases.find(candidate => raw.startsWith(candidate));
  if (!base) return false;
  try {
    const url = new URL(raw);
    // Reject encoded traversal/separators rather than letting URL normalization
    // disguise another object. This also excludes generic local hero images.
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
      url.href.startsWith(base) && !/%(?:2e|2f|5c)/i.test(url.pathname) && url.pathname.length > new URL(base).pathname.length;
  } catch { return false; }
}

export function parseGalleryCreationDraft(input: unknown): GalleryCreationDraft {
  const parsed = galleryCreationDraftSchema.safeParse(input);
  if (!parsed.success) fail("DRAFT_INVALID");
  const draft = parsed.data;
  const key = normalizeSyncSku(draft.shopifySku);
  if (!key || HELD_KEYS.has(key) || (draft.manufacturerSku && HELD_KEYS.has(normalizeSyncSku(draft.manufacturerSku) ?? ""))) fail("HELD_OR_INVALID_SKU");
  if (!draft.copy.title.trim() || draft.copy.title.trim() === "מוצר חדש") fail("PLACEHOLDER_COPY");
  if (draft.manufacturerSku !== null && draft.manufacturerSku !== draft.shopifySku) {
    const mapping = draft.identityMapping;
    if (!mapping || mapping.shopifySku !== draft.shopifySku || mapping.manufacturerSku !== draft.manufacturerSku ||
        !mapping.sourceUrl.startsWith("https://")) fail("MANUFACTURER_MAPPING_REQUIRED");
  } else if (draft.identityMapping && (draft.identityMapping.shopifySku !== draft.shopifySku || draft.identityMapping.manufacturerSku !== draft.manufacturerSku)) {
    fail("MANUFACTURER_MAPPING_INVALID");
  }
  if (draft.copy.descriptionHtml !== null) {
    try { assertSafeDescriptionHtml(draft.copy.descriptionHtml); } catch { fail("HTML_UNSAFE"); }
    if (descriptionTextFromHtml(draft.copy.descriptionHtml) !== draft.copy.description) fail("DESCRIPTION_PAIR_MISMATCH");
  }
  if (draft.media.some(image => !approvedCreationImageUrl(image.url) || !image.alt.trim()) ||
      new Set(draft.media.map(image => image.url)).size !== draft.media.length) fail("MEDIA_INVALID");
  if (draft.commerce.compareAtPrice !== null && (draft.commerce.sellingPrice === null || Number(draft.commerce.compareAtPrice) <= Number(draft.commerce.sellingPrice))) fail("COMPARE_PRICE_INVALID");
  return draft;
}

/** Require complete proof over all statuses: drafts and inactive rows can collide. */
export function assertCreationCatalogAbsent(draft: GalleryCreationDraft, catalog: CreationCatalogProof, now: number): void {
  if (!catalog.complete || !fresh(catalog.capturedAt, now)) fail("CATALOG_PROOF_STALE");
  const key = normalizeSyncSku(draft.shopifySku);
  const sameId = catalog.gallery.filter(row => row.id === draft.galleryItemId);
  if (sameId.length !== 1 || sameId[0].catalogNumber !== draft.shopifySku) fail("GALLERY_IDENTITY_CHANGED");
  if (catalog.gallery.some(row => row.id !== draft.galleryItemId && normalizeSyncSku(row.catalogNumber) === key)) fail("GALLERY_SKU_COLLISION");
  if (catalog.shopify.some(row => normalizeSyncSku(row.sku) === key)) fail("SHOPIFY_SKU_COLLISION");
}

export function readyGalleryCreationDraft(input: unknown, context: DraftReadinessContext): ReadyGalleryDraft {
  if (context.mode !== "draft_only") fail("NOT_ENABLED");
  if (!Number.isFinite(context.now) || context.shopDomain !== CREATION_SHOP || !/^[A-Z]{3}$/.test(context.shopCurrency)) fail("SHOP_CONFIG_INVALID");
  const draft = parseGalleryCreationDraft(input);
  if (Date.parse(draft.copyUpdatedAt) > context.now + 30000) fail("SOURCE_VERSION_INVALID");
  if (draft.commerce.currency !== context.shopCurrency) fail("CURRENCY_MISMATCH");
  const def = context.definition;
  if (!/^app--[1-9][0-9]*--toptik_gallery$/.test(context.expectedAppNamespace) || def.namespace !== context.expectedAppNamespace ||
      def.key !== CREATION_CUSTOM_ID_KEY || def.ownerType !== "PRODUCT" || def.type !== "id" || def.uniqueValuesEnabled !== true) fail("CUSTOM_ID_DEFINITION_INVALID");
  const candidate: ReadyGalleryDraft = { policyVersion: GALLERY_CREATION_POLICY, draft,
    catalogKey: normalizeSyncSku(draft.shopifySku)!, sourceFingerprint: galleryCreationIntentFingerprint(draft, context.images),
    customId: { namespace: def.namespace, key: def.key, value: `${CREATION_SHOP}:gallery:${draft.galleryItemId}` },
    imageEvidence: structuredClone(context.images), readyForPublication: false,
    outstanding: [...(draft.commerce.sellingPrice === null ? ["selling_price" as const] : []),
      ...(draft.commerce.taxable === null ? ["tax_policy" as const] : []), "inventory", "publication_not_supported_v1"] };
  let catalog = context.catalog;
  if (context.recovery) {
    const { receipt, snapshot } = context.recovery;
    assertReceiptIdentity(candidate, receipt);
    assertOwnedGalleryDraft(candidate, snapshot);
    if (receipt.stage === "reserved" || receipt.stage === "review" ||
        (receipt.productGid !== null && receipt.productGid !== snapshot.productGid) ||
        (receipt.variantGid !== null && receipt.variantGid !== snapshot.variantGid)) fail("RECOVERY_IDENTITY_CONFLICT");
    const owned = catalog.shopify.filter(row => row.productGid === snapshot.productGid);
    if (owned.length !== 1 || owned[0].variantGid !== snapshot.variantGid || owned[0].sku !== snapshot.sku || owned[0].status !== "DRAFT") fail("RECOVERY_CATALOG_CONFLICT");
    // Exempt only the proved app-created draft, never an arbitrary SKU match.
    catalog = { ...catalog, shopify: catalog.shopify.filter(row => row.productGid !== snapshot.productGid) };
  }
  assertCreationCatalogAbsent(draft, catalog, context.now);
  if (context.images.length !== draft.media.length) fail("MEDIA_PROOF_MISSING");
  for (const [i, image] of context.images.entries()) {
    if (image.url !== draft.media[i].url || image.galleryItemId !== draft.galleryItemId || image.exactSku !== draft.shopifySku ||
        !/^[a-f0-9]{64}$/.test(image.sha256) || !["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(image.mime) ||
        !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 ||
        image.width > 16000 || image.height > 16000 || image.width * image.height > 16000000 ||
        !Number.isInteger(image.byteLength) || image.byteLength < 1 || image.byteLength > 8388608 || !fresh(image.verifiedAt, context.now)) fail("MEDIA_PROOF_INVALID");
  }
  return candidate;
}

/** Creates only a draft, never productSet/upsert, inventory, publication or collections. */
export function buildGalleryDraftCreateVariables(ready: ReadyGalleryDraft) {
  const draft = parseGalleryCreationDraft(ready.draft);
  if (ready.policyVersion !== GALLERY_CREATION_POLICY || ready.sourceFingerprint !== galleryCreationIntentFingerprint(draft, ready.imageEvidence) ||
      ready.customId.key !== CREATION_CUSTOM_ID_KEY || ready.customId.value !== `${CREATION_SHOP}:gallery:${draft.galleryItemId}` ||
      !/^app--[1-9][0-9]*--toptik_gallery$/.test(ready.customId.namespace)) fail("READY_PROOF_CHANGED");
  return { product: { title: draft.copy.title, descriptionHtml: draft.copy.descriptionHtml ?? plainDescriptionToHtml(draft.copy.description),
    vendor: draft.brand, status: "DRAFT" as const,
    seo: { title: draft.copy.seoTitle, description: draft.copy.seoDescription },
    ...(draft.category ? { productType: draft.category === "carryon" ? "טרולי" : "מזוודה" } : {}),
    metafields: [{ namespace: ready.customId.namespace, key: CREATION_CUSTOM_ID_KEY, type: "id", value: ready.customId.value },
      { namespace: ready.customId.namespace, key: CREATION_SOURCE_HASH_KEY, type: "single_line_text_field", value: ready.sourceFingerprint }] },
    media: draft.media.map(image => ({ originalSource: image.url, alt: image.alt, mediaContentType: "IMAGE" as const })) };
}

export type OwnedDraftSnapshot = {
  productGid: string; variantGid: string; variantCount: number; sku: string; status: string;
  publishedAnywhere: boolean; customId: { namespace: string; key: string; value: string };
  sourceFingerprint: string; updatedAt: string;
  copy: { title: string; descriptionHtml: string; seoTitle: string | null; seoDescription: string | null };
  brand: string; commercial: DraftCommercialSnapshot;
};

export type DraftCommercialSnapshot = {
  price: string; compareAtPrice: string | null; barcode: string | null;
  taxable: boolean; requiresShipping: boolean;
};

/** Capture from the initial productCreate response, not from a later retry. */
export function galleryDraftCommercialFingerprint(value: DraftCommercialSnapshot): string {
  const parsed = z.object({ price: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
    compareAtPrice: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).nullable(), barcode: z.string().max(64).nullable(),
    taxable: z.boolean(), requiresShipping: z.boolean() }).strict().safeParse(value);
  if (!parsed.success) fail("COMMERCIAL_SNAPSHOT_INVALID");
  return createHash("sha256").update(JSON.stringify({ ...parsed.data, price: money(parsed.data.price),
    compareAtPrice: parsed.data.compareAtPrice === null ? null : money(parsed.data.compareAtPrice) })).digest("hex");
}

export function assertOwnedGalleryDraft(ready: ReadyGalleryDraft, snapshot: OwnedDraftSnapshot): void {
  if (!/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(snapshot.productGid) ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(snapshot.variantGid) || snapshot.variantCount !== 1 ||
      snapshot.status !== "DRAFT" || snapshot.publishedAnywhere !== false ||
      snapshot.customId.namespace !== ready.customId.namespace || snapshot.customId.key !== ready.customId.key || snapshot.customId.value !== ready.customId.value ||
      snapshot.sourceFingerprint !== ready.sourceFingerprint || !Number.isFinite(Date.parse(snapshot.updatedAt)) ||
      (snapshot.sku !== "" && snapshot.sku !== ready.draft.shopifySku)) fail("OWNED_DRAFT_IDENTITY_CONFLICT");
  const expected = ready.draft.copy;
  if (snapshot.copy.title !== expected.title || snapshot.copy.seoTitle !== expected.seoTitle ||
      snapshot.copy.seoDescription !== expected.seoDescription || snapshot.brand !== ready.draft.brand ||
      canonicalDescriptionHtml(snapshot.copy.descriptionHtml) !== canonicalDescriptionHtml(expected.descriptionHtml ?? plainDescriptionToHtml(expected.description))) {
    fail("OWNED_DRAFT_COPY_CHANGED");
  }
}

/** Only the single newly created default variant; omitted prices stay omitted. */
export function buildGalleryDraftVariantVariables(ready: ReadyGalleryDraft, snapshot: OwnedDraftSnapshot, expectedShopifyVersion: string,
  expectedCommercialFingerprint: string) {
  buildGalleryDraftCreateVariables(ready); // Revalidates the frozen source proof.
  assertOwnedGalleryDraft(ready, snapshot);
  if (!expectedShopifyVersion || snapshot.updatedAt !== expectedShopifyVersion) fail("DRAFT_VERSION_CHANGED");
  if (!/^[a-f0-9]{64}$/.test(expectedCommercialFingerprint) ||
      galleryDraftCommercialFingerprint(snapshot.commercial) !== expectedCommercialFingerprint) fail("DRAFT_COMMERCE_CHANGED");
  const commerce = ready.draft.commerce;
  return { productId: snapshot.productGid, allowPartialUpdates: false,
    variants: [{ id: snapshot.variantGid, inventoryItem: { sku: ready.draft.shopifySku, requiresShipping: true },
      ...(commerce.sellingPrice === null ? {} : { price: money(commerce.sellingPrice) }),
      ...(commerce.compareAtPrice === null ? {} : { compareAtPrice: money(commerce.compareAtPrice) }),
      ...(commerce.barcode === null ? {} : { barcode: commerce.barcode }),
      ...(commerce.taxable === null ? {} : { taxable: commerce.taxable }) }] };
}

export type GalleryCreationStage = "reserved" | "create_started" | "draft_found" | "variant_started" | "draft_ready" | "uncertain" | "review";
export type GalleryCreationReceipt = {
  policyVersion: typeof GALLERY_CREATION_POLICY; galleryItemId: string; sourceFingerprint: string;
  customId: { namespace: string; key: string; value: string }; stage: GalleryCreationStage;
  productGid: string | null; variantGid: string | null;
  shopifyUpdatedAt: string | null; commercialFingerprint: string | null;
  initialCommercial: DraftCommercialSnapshot | null;
};
export type CreationRecoveryAction =
  | { kind: "create_draft"; variables: ReturnType<typeof buildGalleryDraftCreateVariables> }
  | { kind: "configure_variant"; variables: ReturnType<typeof buildGalleryDraftVariantVariables> }
  | { kind: "lookup_custom_id"; identifier: { customId: ReadyGalleryDraft["customId"] } }
  | { kind: "verify_draft"; productGid: string }
  | { kind: "stop"; code: string };

function assertReceiptIdentity(ready: ReadyGalleryDraft, receipt: GalleryCreationReceipt): void {
  if (!["reserved", "create_started", "draft_found", "variant_started", "draft_ready", "uncertain", "review"].includes(receipt.stage)) fail("STAGE_INVALID");
  if (receipt.policyVersion !== GALLERY_CREATION_POLICY || receipt.galleryItemId !== ready.draft.galleryItemId ||
      receipt.sourceFingerprint !== ready.sourceFingerprint || receipt.customId.namespace !== ready.customId.namespace ||
      receipt.customId.key !== ready.customId.key || receipt.customId.value !== ready.customId.value) fail("RECEIPT_CHANGED");
  if (receipt.initialCommercial !== null && galleryDraftCommercialFingerprint(receipt.initialCommercial) !== receipt.commercialFingerprint) fail("RECEIPT_CHANGED");
}

/** Caller must hold a durable UUID+SKU lease, persist started BEFORE sending,
 * and reread the exact source/version. Uncertain requests are never resent.
 */
export function planGalleryCreationRecovery(ready: ReadyGalleryDraft, receipt: GalleryCreationReceipt,
  lookup: { complete: boolean; found: OwnedDraftSnapshot | null }): CreationRecoveryAction {
  buildGalleryDraftCreateVariables(ready);
  assertReceiptIdentity(ready, receipt);
  if (receipt.stage === "review") return { kind: "stop", code: "SYNC_CREATION_REVIEW_REQUIRED" };
  if (!lookup.complete) return { kind: "lookup_custom_id", identifier: { customId: { ...ready.customId } } };
  if (!lookup.found) {
    if (receipt.stage !== "reserved" || receipt.productGid !== null || receipt.variantGid !== null) {
      return { kind: "lookup_custom_id", identifier: { customId: { ...ready.customId } } };
    }
    return { kind: "create_draft", variables: buildGalleryDraftCreateVariables(ready) };
  }
  assertOwnedGalleryDraft(ready, lookup.found);
  if ((receipt.productGid !== null && receipt.productGid !== lookup.found.productGid) ||
      (receipt.variantGid !== null && receipt.variantGid !== lookup.found.variantGid)) fail("RECEIPT_IDENTITY_CONFLICT");
  if (receipt.stage !== "draft_found") {
    // Read actual variant/media values before deciding whether an interrupted
    // write succeeded. Never replay a write over a later merchant edit.
    return { kind: "verify_draft", productGid: lookup.found.productGid };
  }
  if (!receipt.productGid || !receipt.variantGid || !receipt.shopifyUpdatedAt || !receipt.commercialFingerprint) fail("RECEIPT_IDENTITY_MISSING");
  return { kind: "configure_variant", variables: buildGalleryDraftVariantVariables(ready, lookup.found, receipt.shopifyUpdatedAt, receipt.commercialFingerprint) };
}

export type DraftMediaReadback = {
  productGid: string; mediaGid: string; status: string; url: string; alt: string;
  sha256: string; mime: string; width: number; height: number; byteLength: number; verifiedAt: string;
};

/** Conservative content proof. Merely decoding a different image is insufficient.
 * Shopify transformations that change the bytes remain under review in this v1.
 */
export function assertCreatedDraftReadback(ready: ReadyGalleryDraft, snapshot: OwnedDraftSnapshot,
  media: DraftMediaReadback[], now: number, initialCommercial: DraftCommercialSnapshot): void {
  buildGalleryDraftCreateVariables(ready);
  assertOwnedGalleryDraft(ready, snapshot);
  if (snapshot.sku !== ready.draft.shopifySku || !Number.isFinite(now)) fail("DRAFT_READBACK_INVALID");
  const commerce = ready.draft.commerce, current = snapshot.commercial;
  galleryDraftCommercialFingerprint(current);
  galleryDraftCommercialFingerprint(initialCommercial);
  const expectedCommercial = { ...initialCommercial,
    ...(commerce.sellingPrice === null ? {} : { price: money(commerce.sellingPrice) }),
    ...(commerce.compareAtPrice === null ? {} : { compareAtPrice: money(commerce.compareAtPrice) }),
    ...(commerce.barcode === null ? {} : { barcode: commerce.barcode }),
    ...(commerce.taxable === null ? {} : { taxable: commerce.taxable }), requiresShipping: true };
  if (galleryDraftCommercialFingerprint(current) !== galleryDraftCommercialFingerprint(expectedCommercial)) fail("DRAFT_READBACK_COMMERCE_MISMATCH");
  if ((commerce.sellingPrice !== null && money(current.price) !== money(commerce.sellingPrice)) ||
      (commerce.compareAtPrice !== null && (current.compareAtPrice === null || money(current.compareAtPrice) !== money(commerce.compareAtPrice))) ||
      (commerce.taxable !== null && current.taxable !== commerce.taxable) ||
      (commerce.barcode !== null && current.barcode !== commerce.barcode) || current.requiresShipping !== true) fail("DRAFT_READBACK_COMMERCE_MISMATCH");
  if (media.length !== ready.imageEvidence.length || new Set(media.map(item => item.mediaGid)).size !== media.length) fail("DRAFT_READBACK_MEDIA_MISMATCH");
  media.forEach((item, index) => {
    const expected = ready.imageEvidence[index];
    if (item.productGid !== snapshot.productGid || !/^gid:\/\/shopify\/MediaImage\/[1-9][0-9]*$/.test(item.mediaGid) || item.status !== "READY" ||
        !approvedCreationImageUrl(item.url) || !item.url.startsWith("https://cdn.shopify.com/s/files/") || item.alt !== ready.draft.media[index].alt ||
        item.sha256 !== expected.sha256 || item.mime !== expected.mime || item.width !== expected.width || item.height !== expected.height ||
        item.byteLength !== expected.byteLength || !fresh(item.verifiedAt, now)) fail("DRAFT_READBACK_MEDIA_MISMATCH");
  });
}

/** Explicit allowed durable transitions; a ready draft is never published here. */
export function transitionGalleryCreationStage(from: GalleryCreationStage, to: GalleryCreationStage): GalleryCreationStage {
  const allowed: Record<GalleryCreationStage, GalleryCreationStage[]> = {
    reserved: ["create_started", "review"], create_started: ["draft_found", "uncertain", "review"],
    draft_found: ["variant_started", "review"], variant_started: ["draft_ready", "uncertain", "review"],
    uncertain: ["draft_ready", "review"], draft_ready: ["review"], review: [],
  };
  if (!Object.hasOwn(allowed, from) || !allowed[from].includes(to)) fail("STAGE_TRANSITION_INVALID");
  return to;
}
