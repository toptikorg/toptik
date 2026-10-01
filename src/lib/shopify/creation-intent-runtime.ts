import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCreationIntentRecord, assessCreationIntent, creationIntentInputSchema, draftFromCreationIntent,
  saveCreationIntent, type CreationIdentityProof, type CreationIntentRecord, type VerifiedManufacturerMapping } from "./creation-intent";
import { galleryDraftCreationMode } from "./creation-runtime";

// Identifies the existing shared admin-token principal, not an individual human.
const ADMIN_TOKEN_ACTOR = "f4a10335-5d41-4b70-9e16-93bb74a52eba";
function fail(code: string): never { throw new Error(`SYNC_CREATION_INTENT_${code}`); }
function errorCode(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message && /^SYNC_CREATION_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : fallback);
}
function enabled() { if (!galleryDraftCreationMode()) fail("NOT_ENABLED"); }
function signal(deadline: number) { const remaining = deadline - Date.now(); if (remaining < 1) fail("TIME_BUDGET"); return AbortSignal.timeout(Math.min(3000, remaining)); }
export async function loadCreationIntent(db: SupabaseClient, id: string, deadline = Date.now() + 9000) {
  const { data, error } = await db.from("shopify_gallery_creation_intents").select("record,frozen_at").eq("id", id).abortSignal(signal(deadline)).maybeSingle();
  if (error) fail("READ_FAILED");
  return data ? { record: assertCreationIntentRecord(data.record), frozen: data.frozen_at !== null } : null;
}
async function readIdentities(db: SupabaseClient, deadline: number): Promise<CreationIdentityProof> {
  const existing: CreationIdentityProof["existing"] = [];
  for (const [table, columns] of [["carousel_items", "id,catalog_number"],
    ["shopify_gallery_copy_eligibility", "carousel_item_id,exact_gallery_sku,exact_shopify_sku"],
    ["shopify_gallery_bindings", "carousel_item_id,catalog_key"]]) {
    let complete = false;
    for (let offset = 0; offset < 6000; offset += 1000) {
      const { data, error } = await db.from(table).select(columns).order(table === "carousel_items" ? "id" : "carousel_item_id")
        .range(offset, offset + 999).abortSignal(signal(deadline));
      if (error || !data) fail("IDENTITY_READ_FAILED");
      // SQL independently rechecks these identities under the shared transaction lock.
      for (const raw of data as unknown as Array<Record<string, unknown>>) existing.push({
        galleryItemId: String(raw.id ?? raw.carousel_item_id),
        exactGallerySku: String(raw.catalog_number ?? raw.exact_gallery_sku ?? raw.catalog_key ?? ""),
        exactShopifySku: String(raw.exact_shopify_sku ?? raw.catalog_number ?? raw.catalog_key ?? ""),
      });
      if (data.length < 1000) { complete = true; break; }
    }
    if (!complete) fail("CATALOG_LIMIT");
  }
  return { complete: true, capturedAt: new Date().toISOString(), existing };
}
async function mappingFor(db: SupabaseClient, record: CreationIntentRecord, deadline: number): Promise<VerifiedManufacturerMapping | null> {
  const id = record.input.identityMappingReceiptId;
  if (!id) return null;
  const { data, error } = await db.from("shopify_gallery_creation_mappings")
    .select("id,gallery_item_id,exact_shopify_sku,exact_manufacturer_sku,source_url,evidence_sha256,verified_at")
    .eq("id", id).eq("revoked", false).abortSignal(signal(deadline)).maybeSingle();
  if (error) fail("MAPPING_READ_FAILED");
  return data ? { id: data.id, galleryItemId: data.gallery_item_id, shopifySku: data.exact_shopify_sku,
    manufacturerSku: data.exact_manufacturer_sku, sourceUrl: data.source_url, evidenceSha256: data.evidence_sha256,
    verifiedAt: new Date(data.verified_at).toISOString() } : null;
}
export async function promoteCreationIntent(db: SupabaseClient, id: string, expectedRevision: string, deadline = Date.now() + 9000) {
  enabled();
  const loaded = await loadCreationIntent(db, id, deadline);
  if (!loaded || loaded.record.revision !== expectedRevision) fail("STALE_EDIT");
  // Do not reconstruct frozen sources during recovery; the original draft owns its receipt.
  if (!loaded.frozen) draftFromCreationIntent(loaded.record, await mappingFor(db, loaded.record, deadline), Date.now());
  const { data, error } = await db.rpc("promote_gallery_creation_intent", { p_id: id, p_expected_revision: expectedRevision }).abortSignal(signal(deadline));
  if (error || !data?.id) errorCode(error, "SYNC_CREATION_INTENT_PROMOTE_FAILED");
  return { id: data.id as string, stage: data.stage as string };
}
export async function savePendingCreationIntent(db: SupabaseClient, input: unknown, expectedRevision: string | null, deadline = Date.now() + 9000) {
  enabled();
  const parsed = creationIntentInputSchema.safeParse(input);
  if (!parsed.success) fail("INPUT_INVALID");
  const prior = await loadCreationIntent(db, parsed.data.galleryItemId, deadline);
  const exactReplay = prior && JSON.stringify(prior.record.input) === JSON.stringify(parsed.data) &&
    (expectedRevision === prior.record.revision || expectedRevision === prior.record.parentRevision);
  if (prior?.frozen && !exactReplay) fail("FROZEN");
  let record: CreationIntentRecord;
  if (exactReplay) record = prior.record;
  else {
    record = saveCreationIntent(prior?.record ?? null, parsed.data, { expectedRevision,
      actorId: ADMIN_TOKEN_ACTOR, requestId: randomUUID(), at: new Date().toISOString() }, await readIdentities(db, deadline));
    const result = await db.rpc("save_gallery_creation_intent", { p_record: record, p_expected_revision: expectedRevision }).abortSignal(signal(deadline));
    if (result.error || !result.data) errorCode(result.error, "SYNC_CREATION_INTENT_SAVE_FAILED");
    record = assertCreationIntentRecord(result.data);
  }
  const readiness = assessCreationIntent(record);
  let creation: { id: string; stage: string } | null = null, creationError: string | null = null;
  if (!readiness.draftBlockers.length) {
    try { creation = await promoteCreationIntent(db, record.input.galleryItemId, record.revision, deadline); }
    catch (error) { creationError = error instanceof Error && /^SYNC_CREATION_[A-Z0-9_]{1,80}$/.test(error.message)
      ? error.message : "SYNC_CREATION_INTENT_PROMOTE_FAILED"; }
  }
  // Saving succeeded even if trusted identity evidence has not yet been provisioned.
  return { record, readiness, creation, creationError, frozen: Boolean(creation || prior?.frozen) };
}
