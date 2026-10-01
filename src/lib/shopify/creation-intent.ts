import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSafeDescriptionHtml, descriptionTextFromHtml } from "./description-document";
import { normalizeSyncSku } from "./sync-rules";
import { approvedCreationImageUrl, galleryCreationDraftSchema, planGalleryCreationRecovery,
  readyGalleryCreationDraft, type DraftReadinessContext, type GalleryCreationReceipt,
  type OwnedDraftSnapshot, type ReadyGalleryDraft } from "./creation-policy";

/** Private preparation only. Persist with DB CAS before invoking any worker. */
export const CREATION_INTENT_VERSION = "gallery-creation-intent-v1";
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const ISO = z.string().datetime({ offset: true });
const SKU = galleryCreationDraftSchema.shape.shopifySku;
const HELD = new Set(["P10OSV0405J", "P10ZJT0624U", "ORI05500909", "ORI05500024"]);
const NULLABLE_MONEY = galleryCreationDraftSchema.shape.commerce.shape.sellingPrice;

/** Null means unknown; an empty SEO/body string is an explicit blank, not missing. */
export const creationIntentInputSchema = z.object({
  galleryItemId: z.string().uuid().transform(value => value.toLowerCase()),
  shopifySku: SKU.nullable(), manufacturerSku: SKU.nullable(),
  identityMappingReceiptId: z.string().uuid().nullable(),
  brand: galleryCreationDraftSchema.shape.brand.nullable(),
  category: galleryCreationDraftSchema.shape.category,
  copy: galleryCreationDraftSchema.shape.copy.extend({
    title: z.string().max(120).nullable(), description: z.string().max(50000).nullable(),
  }).strict(),
  media: z.array(z.object({ url: z.string().max(2048), alt: z.string().max(200).nullable() }).strict()).max(30),
  commerce: galleryCreationDraftSchema.shape.commerce.extend({
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(), requiresShipping: z.literal(true).nullable(),
    storeIntent: z.enum(["undecided", "draft", "publish_when_ready"]),
    sellingPrice: NULLABLE_MONEY,
  }).strict(),
  /** User-supplied references are unverified claims, never verification receipts. */
  sourceReferences: z.array(z.string().url().max(2000)).max(10),
}).strict();
export type CreationIntentInput = z.infer<typeof creationIntentInputSchema>;

export const CREATION_FIELD_AUTHORITY = {
  shopifySku: "merchant_identity", manufacturerSku: "manufacturer_identity_claim",
  identityMappingReceiptId: "server_verified_mapping_reference", brand: "merchant_identity",
  category: "merchant_classification", title: "merchant_copy", description: "merchant_copy_pair",
  seoTitle: "merchant_copy", seoDescription: "merchant_copy", media: "merchant_image_claim",
  sellingPrice: "merchant_commerce", currency: "shop_currency_match_required",
  compareAtPrice: "merchant_commerce", barcode: "merchant_identity", taxable: "merchant_tax_policy",
  requiresShipping: "merchant_shipping_policy", inventory: "shopify_authoritative_unknown",
  storeIntent: "merchant_publication_intent", sourceReferences: "unverified_reference",
} as const;
type IntentField = keyof typeof CREATION_FIELD_AUTHORITY;
const provenanceSchema = z.object({ actorId: z.string().uuid(), requestId: z.string().uuid(),
  at: ISO, authority: z.enum(Object.values(CREATION_FIELD_AUTHORITY)), verifiedManufacturerFact: z.literal(false) }).strict();
type IntentProvenance = z.infer<typeof provenanceSchema>;
const provenanceMapSchema = z.object(Object.fromEntries(Object.keys(CREATION_FIELD_AUTHORITY)
  .map(key => [key, provenanceSchema])) as Record<IntentField, typeof provenanceSchema>).strict();
const recordSchema = z.object({ policyVersion: z.literal(CREATION_INTENT_VERSION), input: creationIntentInputSchema,
  revision: HASH, parentRevision: HASH.nullable(), updatedAt: ISO,
  provenance: provenanceMapSchema }).strict();
export type CreationIntentRecord = z.infer<typeof recordSchema>;
export type CreationEditContext = {
  /** Must come from verified server authentication, never the request JSON. */
  actorId: string; requestId: string; at: string; expectedRevision: string | null;
};
export type ExistingCreationIdentity = { galleryItemId: string; exactGallerySku: string; exactShopifySku: string };
export type CreationIdentityProof = {
  complete: boolean; capturedAt: string;
  /** Includes enabled/disabled approvals and existing bindings, not only active78. */
  existing: ExistingCreationIdentity[];
};
export type VerifiedManufacturerMapping = {
  id: string; galleryItemId: string; shopifySku: string; manufacturerSku: string;
  sourceUrl: string; evidenceSha256: string; verifiedAt: string;
};

function fail(code: string): never { throw new Error(`SYNC_CREATION_INTENT_${code}`); }
export function assertCreationIdentityAllowed(sku: string | null) {
  if (sku && HELD.has(normalizeSyncSku(sku) ?? "")) fail("HELD_IDENTITY");
}
function sha(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function fieldValues(input: CreationIntentInput): Record<IntentField, unknown> {
  return { shopifySku: input.shopifySku, manufacturerSku: input.manufacturerSku,
    identityMappingReceiptId: input.identityMappingReceiptId, brand: input.brand, category: input.category,
    title: input.copy.title, description: [input.copy.description, input.copy.descriptionHtml],
    seoTitle: input.copy.seoTitle, seoDescription: input.copy.seoDescription, media: input.media,
    ...input.commerce, sourceReferences: input.sourceReferences };
}
function assertInput(input: unknown): CreationIntentInput {
  const parsed = creationIntentInputSchema.safeParse(input);
  if (!parsed.success) fail("INPUT_INVALID");
  const value = parsed.data;
  [value.shopifySku, value.manufacturerSku].forEach(assertCreationIdentityAllowed);
  if (value.copy.descriptionHtml !== null) {
    assertSafeDescriptionHtml(value.copy.descriptionHtml);
    if (value.copy.description === null || descriptionTextFromHtml(value.copy.descriptionHtml) !== value.copy.description) fail("DESCRIPTION_PAIR_MISMATCH");
  }
  const knownUrls = value.media.map(item => item.url).filter(Boolean);
  if (knownUrls.some(url => !approvedCreationImageUrl(url)) || new Set(knownUrls).size !== knownUrls.length) fail("MEDIA_INVALID");
  if (value.sourceReferences.some(raw => { const url = new URL(raw); return url.protocol !== "https:" || !!url.username || !!url.password; })) fail("REFERENCE_INVALID");
  if (value.commerce.compareAtPrice !== null && value.commerce.sellingPrice !== null &&
    Number(value.commerce.compareAtPrice) <= Number(value.commerce.sellingPrice)) fail("COMPARE_PRICE_INVALID");
  return value;
}
function payload(record: Omit<CreationIntentRecord, "revision">) {
  return { policyVersion: record.policyVersion, input: record.input, parentRevision: record.parentRevision,
    updatedAt: record.updatedAt, provenance: record.provenance };
}
export function assertCreationIntentRecord(record: unknown): CreationIntentRecord {
  const result = recordSchema.safeParse(record);
  if (!result.success) fail("RECORD_INVALID");
  assertInput(result.data.input);
  if (sha(payload(result.data)) !== result.data.revision) fail("RECORD_CHANGED");
  for (const field of Object.keys(CREATION_FIELD_AUTHORITY) as IntentField[]) {
    if (result.data.provenance[field].authority !== CREATION_FIELD_AUTHORITY[field]) fail("PROVENANCE_INVALID");
  }
  return result.data;
}
export function assertNewCreationIdentity(input: CreationIntentInput, proof: CreationIdentityProof, now: number) {
  if (!Number.isFinite(now) || !proof.complete || !ISO.safeParse(proof.capturedAt).success ||
    Date.parse(proof.capturedAt) < now - 300000 || Date.parse(proof.capturedAt) > now + 30000) fail("IDENTITY_PROOF_REQUIRED");
  const key = normalizeSyncSku(input.shopifySku);
  if (proof.existing.some(row => row.galleryItemId === input.galleryItemId || (key !== null &&
    [row.exactGallerySku, row.exactShopifySku].some(sku => normalizeSyncSku(sku) === key)))) fail("EXISTING_PRODUCT_USE_SYNC");
}

/** Produces a CAS candidate, not a persisted authorization. Caller stores it atomically. */
export function saveCreationIntent(previous: CreationIntentRecord | null, input: unknown,
  context: CreationEditContext, identity: CreationIdentityProof): CreationIntentRecord {
  if (!Object.hasOwn(context, "expectedRevision") || !z.object({ actorId: z.string().uuid(), requestId: z.string().uuid(),
    at: ISO, expectedRevision: HASH.nullable() }).strict().safeParse(context).success) fail("EDIT_CONTEXT_INVALID");
  const next = assertInput(input), prior = previous === null ? null : assertCreationIntentRecord(previous);
  if (context.expectedRevision !== (prior?.revision ?? null)) fail("STALE_EDIT");
  assertNewCreationIdentity(next, identity, Date.parse(context.at));
  if (prior && (prior.input.galleryItemId !== next.galleryItemId ||
    (prior.input.shopifySku !== null && prior.input.shopifySku !== next.shopifySku) ||
    (prior.input.manufacturerSku !== null && prior.input.manufacturerSku !== next.manufacturerSku))) fail("IDENTITY_IMMUTABLE");
  if (prior && Date.parse(context.at) < Date.parse(prior.updatedAt)) fail("EDIT_TIME_REVERSED");
  const before = prior && fieldValues(prior.input), after = fieldValues(next);
  if (prior && JSON.stringify(prior.input) === JSON.stringify(next)) return prior;
  const provenance = {} as Record<IntentField, IntentProvenance>;
  for (const field of Object.keys(CREATION_FIELD_AUTHORITY) as IntentField[]) {
    provenance[field] = prior && JSON.stringify(before![field]) === JSON.stringify(after[field]) ? prior.provenance[field] : {
      actorId: context.actorId, requestId: context.requestId, at: context.at,
      authority: CREATION_FIELD_AUTHORITY[field], verifiedManufacturerFact: false,
    };
  }
  const record: Omit<CreationIntentRecord, "revision"> = { policyVersion: CREATION_INTENT_VERSION, input: next, parentRevision: prior?.revision ?? null,
    updatedAt: context.at, provenance };
  return { ...record, revision: sha(payload(record)) };
}

export type CreationReadinessReason = "store_sku" | "brand" | "title" | "description" | "media" |
  "media_alt" | "media_limit" | "selling_price" | "currency" | "tax_policy" | "shipping_policy" | "store_intent" |
  "manufacturer_mapping_receipt" | "server_verification";
/** Local details, proof readiness and public readiness are deliberately distinct. */
export function assessCreationIntent(record: CreationIntentRecord) {
  const { input } = assertCreationIntentRecord(record);
  const draftBlockers: CreationReadinessReason[] = [];
  if (!input.shopifySku) draftBlockers.push("store_sku");
  if (!input.brand) draftBlockers.push("brand");
  if (!input.copy.title?.trim() || input.copy.title.trim() === "מוצר חדש") draftBlockers.push("title");
  if (input.copy.description === null) draftBlockers.push("description");
  if (!input.media.length || input.media.some(item => !item.url)) draftBlockers.push("media");
  if (input.media.length > 10) draftBlockers.push("media_limit");
  if (input.media.some(item => !item.alt?.trim())) draftBlockers.push("media_alt");
  if (!input.commerce.currency) draftBlockers.push("currency");
  if (input.commerce.requiresShipping !== true) draftBlockers.push("shipping_policy");
  if (input.commerce.storeIntent === "undecided") draftBlockers.push("store_intent");
  if (input.manufacturerSku !== null && input.manufacturerSku !== input.shopifySku && !input.identityMappingReceiptId) draftBlockers.push("manufacturer_mapping_receipt");
  if (input.commerce.compareAtPrice !== null && input.commerce.sellingPrice === null) draftBlockers.push("selling_price");
  const publicBlockers: CreationReadinessReason[] = [...draftBlockers];
  if (input.commerce.sellingPrice === null && !publicBlockers.includes("selling_price")) publicBlockers.push("selling_price");
  if (input.commerce.taxable === null) publicBlockers.push("tax_policy");
  publicBlockers.push("server_verification");
  return { state: draftBlockers.length ? "needs_details" as const : "ready_for_server_proof" as const,
    draftBlockers, publicBlockers, readyForPublication: false as const };
}

export type FrozenCreationIntent = {
  intentRevision: string; requestedStoreIntent: "draft" | "publish_when_ready";
  ready: ReadyGalleryDraft;
};
/** Validated private DTO only; caller must still reserve atomically and run fresh server proof. */
export function draftFromCreationIntent(record: CreationIntentRecord, mapping: VerifiedManufacturerMapping | null, now: number) {
  const current = assertCreationIntentRecord(record), input = current.input;
  if (!Number.isFinite(now)) fail("TIME_INVALID");
  if (assessCreationIntent(current).draftBlockers.length) fail("DETAILS_REQUIRED");
  let identityMapping = null;
  if (input.manufacturerSku !== null && input.manufacturerSku !== input.shopifySku) {
    if (!mapping || mapping.id !== input.identityMappingReceiptId || mapping.galleryItemId !== input.galleryItemId ||
      mapping.shopifySku !== input.shopifySku || mapping.manufacturerSku !== input.manufacturerSku ||
      !z.string().uuid().safeParse(mapping.id).success || !HASH.safeParse(mapping.evidenceSha256).success ||
      !ISO.safeParse(mapping.verifiedAt).success || Date.parse(mapping.verifiedAt) > now + 30000) fail("MAPPING_RECEIPT_MISMATCH");
    let url: URL; try { url = new URL(mapping.sourceUrl); } catch { fail("MAPPING_RECEIPT_MISMATCH"); }
    if (url.protocol !== "https:" || url.username || url.password) fail("MAPPING_RECEIPT_MISMATCH");
    identityMapping = { shopifySku: mapping.shopifySku, manufacturerSku: mapping.manufacturerSku,
      sourceUrl: mapping.sourceUrl, evidenceSha256: mapping.evidenceSha256, verifiedAt: mapping.verifiedAt };
  } else if (input.identityMappingReceiptId !== null) fail("UNUSED_MAPPING_RECEIPT");
  return galleryCreationDraftSchema.parse({ galleryItemId: input.galleryItemId, copyUpdatedAt: current.updatedAt,
    shopifySku: input.shopifySku, manufacturerSku: input.manufacturerSku, identityMapping, brand: input.brand,
    category: input.category, copy: input.copy, media: input.media,
    commerce: { ...input.commerce, storeIntent: "draft" } });
}
/** Only a server-read receipt can become identityMapping; client references never do. */
export function freezeCreationIntent(record: CreationIntentRecord, context: DraftReadinessContext,
  identity: CreationIdentityProof, mapping: VerifiedManufacturerMapping | null): FrozenCreationIntent {
  const current = assertCreationIntentRecord(record), input = current.input;
  assertNewCreationIdentity(input, identity, context.now);
  const ready = readyGalleryCreationDraft(draftFromCreationIntent(current, mapping, context.now), context);
  return { intentRevision: current.revision, requestedStoreIntent: input.commerce.storeIntent as "draft" | "publish_when_ready", ready };
}

/** Frozen revision must still be current under the durable lease before every send. */
export function planCreationIntentRetry(frozen: FrozenCreationIntent, current: CreationIntentRecord,
  receipt: GalleryCreationReceipt, lookup: { complete: boolean; found: OwnedDraftSnapshot | null }) {
  const valid = assertCreationIntentRecord(current);
  if (frozen.intentRevision !== valid.revision || frozen.ready.draft.galleryItemId !== valid.input.galleryItemId ||
    frozen.ready.draft.shopifySku !== valid.input.shopifySku || frozen.requestedStoreIntent !== valid.input.commerce.storeIntent) fail("SOURCE_CHANGED_REVIEW");
  return planGalleryCreationRecovery(frozen.ready, receipt, lookup);
}
