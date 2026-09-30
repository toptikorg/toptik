import "server-only";
import { randomUUID } from "node:crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { SourceProduct } from "@/lib/catalog-source/types";
import type { CatalogVendor } from "@/lib/catalog-source/provider";
import type { CarouselItem } from "@/lib/carousel/types";
import { normalizeSyncSku } from "./sync-rules";
import { galleryDraftCreationMode } from "./creation-runtime";
import { finalizedCreationIds } from "./creation-finalization-read";
import { assertCreationIntentRecord, assertCreationIdentityAllowed, saveCreationIntent, type CreationIntentInput } from "./creation-intent";
import { plainDescriptionToHtml, descriptionTextFromHtml } from "./description-document";

type ImportResult = { ok: boolean; item: CarouselItem; source: { vendor: string; catalogNumber: string; sourceUrl: string; importedImages: number } };
type Importer = (vendor: CatalogVendor, source: SourceProduct, target: string | undefined, inputLabel: string) => Promise<ImportResult>;
const ACTOR = "f4a10335-5d41-4b70-9e16-93bb74a52eba";

/** Import facts stay distinct from merchant commerce and exact store identity. */
export function importedCreationInput(item: CarouselItem, vendor: CatalogVendor): CreationIntentInput {
  const descriptionHtml = item.descriptionHtml ?? plainDescriptionToHtml(item.description ?? "");
  const urls = [...new Set([item.coverImagePath, ...item.angles.map(angle => angle.imagePath)].filter(Boolean))];
  // Do not silently discard image evidence to fit the creation limit.
  if (urls.length > 30) throw new Error("SYNC_CREATION_IMPORT_MEDIA_LIMIT");
  return { galleryItemId: item.id, shopifySku: null, manufacturerSku: item.catalogNumber ?? null,
    identityMappingReceiptId: null, brand: vendor === "mandarina" ? "Mandarina Duck" : "Bric's",
    category: item.techSpecs?.category === "carryon" || item.techSpecs?.category === "suitcase" ? item.techSpecs.category : null,
    copy: { title: item.title, description: descriptionTextFromHtml(descriptionHtml), descriptionHtml,
      seoTitle: item.seoTitle ?? null, seoDescription: item.seoDescription ?? null },
    media: urls.map(url => ({ url, alt: item.color ? `${item.title} — ${item.color}` : item.title })),
    commerce: { sellingPrice: null, currency: null, compareAtPrice: null, barcode: null, taxable: null,
      requiresShipping: null, inventory: { status: "unknown" }, storeIntent: "undecided" },
    sourceReferences: item.sourceUrl ? [item.sourceUrl] : [],
  };
}

/** Exact existing products keep their update path. New products never enter the catalog save payload. */
export async function runAdminManufacturerImport(vendor: CatalogVendor, source: SourceProduct,
  requestedTarget: string | undefined, inputLabel: string, importer: Importer) {
  const db = createSupabaseServiceRoleClient(), sku = source.catalogNumber || inputLabel;
  const rows: Array<{ id: string; catalog_number: string | null }> = [];
  for (let offset = 0; offset < 6000; offset += 1000) {
    const { data, error } = await db.from("carousel_items").select("id,catalog_number").order("id")
      .range(offset, offset + 999).abortSignal(AbortSignal.timeout(3000));
    if (error || !data) throw new Error("SYNC_CREATION_IMPORT_IDENTITY_READ_FAILED");
    rows.push(...data); if (data.length < 1000) break;
    if (offset === 5000) throw new Error("SYNC_CREATION_IMPORT_CATALOG_LIMIT");
  }
  const candidates = rows.filter(row => normalizeSyncSku(row.catalog_number) === normalizeSyncSku(sku));
  if (candidates.length > 1 || candidates.some(row => row.catalog_number !== sku)) throw new Error("SYNC_CREATION_IMPORT_IDENTITY_AMBIGUOUS");
  const existing = candidates[0];
  if (requestedTarget && (!existing || existing.id !== requestedTarget)) throw new Error("SYNC_CREATION_IMPORT_TARGET_MISMATCH");
  if (existing) {
    const { data: privateDraft, error } = await db.from("shopify_gallery_creation_drafts").select("id")
      .eq("id", existing.id).abortSignal(AbortSignal.timeout(3000)).maybeSingle();
    if (error && !(!galleryDraftCreationMode() && ["42P01", "PGRST205"].includes(error.code) &&
      error.message.includes("shopify_gallery_creation_drafts"))) throw new Error("SYNC_CREATION_IMPORT_IDENTITY_READ_FAILED");
    if (!privateDraft || (await finalizedCreationIds([existing.id], db)).has(existing.id)) {
      return importer(vendor, source, existing.id, inputLabel);
    }
    const receipt = await db.from("shopify_gallery_creation_imports").select("intent_id")
      .eq("vendor", vendor).eq("exact_manufacturer_sku", sku).abortSignal(AbortSignal.timeout(3000)).maybeSingle();
    if (receipt.error || receipt.data?.intent_id !== existing.id) throw new Error("SYNC_CREATION_PRIVATE_ITEM_USE_INTENT");
    // A reimport of an already-promoted private product must use its source
    // receipt replay, never the ordinary importer that writes side data.
  }
  if (!galleryDraftCreationMode()) throw new Error("SYNC_CREATION_INTENT_NOT_ENABLED");
  assertCreationIdentityAllowed(sku);
  const result = await importer(vendor, source, undefined, inputLabel);
  const input = importedCreationInput(result.item, vendor), now = new Date().toISOString();
  const record = saveCreationIntent(null, input, { actorId: ACTOR, requestId: randomUUID(), at: now, expectedRevision: null },
    { complete: true, capturedAt: now, existing: rows.map(row => ({ galleryItemId: row.id,
      exactGallerySku: row.catalog_number ?? "", exactShopifySku: row.catalog_number ?? "" })) });
  const { data, error } = await db.rpc("stage_gallery_creation_import", { p_record: record, p_vendor: vendor,
    p_exact_manufacturer_sku: sku, p_source: result.item }).abortSignal(AbortSignal.timeout(5000));
  if (error || !data?.record) throw new Error(error?.message && /^SYNC_CREATION_[A-Z0-9_]{1,80}$/.test(error.message)
    ? error.message : "SYNC_CREATION_IMPORT_SAVE_FAILED");
  const stored = assertCreationIntentRecord(data.record);
  return { ...result, pendingCreation: { id: stored.input.galleryItemId, revision: stored.revision,
    sourceChanged: Boolean(data.sourceChanged), replayed: Boolean(data.replayed) } };
}
