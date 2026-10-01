import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, shopifyAdminGraphql } from "./admin-api";
import { buildMerchantIntent, fingerprint, prepareFinalization, SHOP, API_VERSION,
  type MerchantIntent, type CreationProof, type Snapshot } from "./commerce-finalization";
import { commercialPublicationMode } from "./commerce-mode";
import { commercialDatabase } from "./commerce-database";
import { runCommercialFinalization, type WorkerResult, type StoredFinalization } from "./commerce-worker";
import { sendCommercialRequest } from "./commerce-transport";
import { readCommerceShopify, assembleCommerceRead, type CommerceReadIdentity, type CommerceServerRead } from "./commerce-shopify-read";

const UUID = z.string().uuid(), HASH = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/);
/** The merchant supplies commerce only; all identity, provenance and lease proof is server-loaded. */
export const commerceEditSchema = z.object({ itemId: UUID, expectedRevision: HASH.nullable(), requestId: UUID,
  values: z.object({ price: money, compareAtPrice: money.nullable(), barcode: z.string().max(64).nullable(),
    taxable: z.boolean(), requiresShipping: z.literal(true), publishWhenReady: z.literal(true) }).strict() }).strict();
export type CommerceEdit = z.infer<typeof commerceEditSchema>;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function fail(code: string): never { throw new Error(`FINALIZE_${code}`); }
export function commerceCode(error: unknown) { return error instanceof Error && /^(FINALIZE|SYNC_CREATION|SHOPIFY)_[A-Z0-9_]{1,90}$/.test(error.message)
  ? error.message : "FINALIZE_OPERATION_UNCONFIRMED"; }
function signal(deadline: number) { const left = deadline - Date.now(); if (left <= 0) fail("TIME_BUDGET"); return AbortSignal.timeout(Math.min(3000, Math.floor(left))); }
type Source = { intent: MerchantIntent | null; identity: CommerceReadIdentity; proof: CreationProof; publicationActorId: string;
  pendingCommerce: { sellingPrice: string | null; compareAtPrice: string | null; barcode: string | null; taxable: boolean | null; requiresShipping: boolean | null; currency: string | null; storeIntent: string };
  galleryRowFingerprint: string; galleryCopyVersion: string; galleryCopy: Snapshot["galleryCopy"]; context: CommerceServerRead["context"] };
async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>, deadline: number) {
  const { data, error } = await db.rpc(name, args).abortSignal(signal(deadline));
  if (error) throw new Error(commerceCode(new Error(error.message)));
  if (Date.now() >= deadline) fail("TIME_BUDGET"); return data;
}
async function source(db: SupabaseClient, id: string, owner: string | null, deadline: number): Promise<Source> {
  const value = await rpc(db, "read_gallery_commerce_source", { p_id: UUID.parse(id), p_owner: owner }, deadline);
  if (!object(value) || !object(value.identity) || value.identity.itemId !== id || !object(value.proof) || !object(value.context) || !object(value.pendingCommerce)) fail("DATABASE_INVALID");
  return value as Source;
}
function enabled() { if (!commercialPublicationMode(process.env)) fail("NOT_ENABLED"); }
const ACTOR = "f4a10335-5d41-4b70-9e16-93bb74a52eba"; // Shared authenticated Gallery principal, not an individual human.
export async function saveCommerceEdit(db: SupabaseClient, raw: unknown, deadline = Date.now() + 9000, actorId = ACTOR) {
  enabled(); const edit = commerceEditSchema.parse(raw), loaded = await source(db, edit.itemId, null, deadline);
  const commercial = { price: edit.values.price, compareAtPrice: edit.values.compareAtPrice, barcode: edit.values.barcode,
    taxable: edit.values.taxable, requiresShipping: true as const, inventoryPolicy: "DENY" as const, tracked: false };
  const intent = buildMerchantIntent({ intentId: loaded.intent?.intentId ?? randomUUID(), galleryItemId: edit.itemId,
    sourceFingerprint: loaded.identity.sourceFingerprint, frozenPendingRevision: loaded.proof.frozenPendingRevision,
    currency: loaded.pendingCommerce.currency ?? "", targetStatus: "ACTIVE", storeIntent: "publish_when_ready", commercial, stock: [],
    provenance: { authority: "authenticated_gallery_editor", actorId: UUID.parse(actorId), requestId: edit.requestId, savedAt: new Date().toISOString() } });
  // A lost save response can be recovered with the same request ID, without changing facts or provenance.
  if (loaded.intent?.provenance.requestId === edit.requestId) {
    const comparable = (value: MerchantIntent) => ({ ...value, revision: null, provenance: { ...value.provenance, savedAt: null } });
    if (fingerprint(comparable(loaded.intent)) !== fingerprint(comparable(intent))) fail("REQUEST_REUSED");
    return loaded.intent;
  }
  return commercialDatabase(db).saveMerchant(intent, edit.expectedRevision, deadline);
}

/** Authenticated status only: no service keys, lease owners or server proof returned. */
export async function commerceStatus(db: SupabaseClient, id?: string, deadline = Date.now() + 9000) {
  const mode = Boolean(commercialPublicationMode(process.env));
  if (!id) {
    const { data, error } = await db.from("shopify_gallery_creation_drafts").select("id,stage,last_error,source,updated_at")
      .eq("stage", "draft_ready").order("updated_at", { ascending: false }).limit(100).abortSignal(signal(deadline));
    if (error) fail("STATUS_READ_FAILED");
    return { enabled: mode, items: (data ?? []).map(row => ({ id: row.id, title: row.source?.copy?.title ?? "", sku: row.source?.shopifySku ?? "", stage: row.stage })) };
  }
  UUID.parse(id);
  const [merchant, job, receipt, draft] = await Promise.all([
    db.from("gallery_creation_commercial_intents").select("record,frozen_at").eq("item_id", id).abortSignal(signal(deadline)).maybeSingle(),
    db.from("gallery_creation_commercial_jobs").select("state").eq("item_id", id).abortSignal(signal(deadline)).maybeSingle(),
    db.from("gallery_creation_commercial_receipts").select("receipt_id,product_gid,variant_gid").eq("item_id", id).abortSignal(signal(deadline)).maybeSingle(),
    db.from("shopify_gallery_creation_drafts").select("stage,last_error").eq("id", id).abortSignal(signal(deadline)).maybeSingle(),
  ]);
  if (merchant.error || job.error || receipt.error || draft.error) fail("STATUS_READ_FAILED");
  if (receipt.data) return { enabled: mode, id, status: "bound", frozen: true, revision: merchant.data?.record.revision ?? null, commerce: merchant.data?.record.commercial ?? null };
  if (!draft.data) fail("DRAFT_READY_REQUIRED");
  if (draft.data.stage !== "draft_ready") return { enabled: mode, id, status: "preparing", frozen: true, revision: null, commerce: null, code: draft.data.last_error ?? null };
  const loaded = await source(db, id, null, deadline);
  return { enabled: mode, id, title: loaded.proof.receipt ? loaded.galleryCopy.title : "", sku: loaded.identity.sku,
    status: job.data?.state.review ? "review" : job.data ? "pending" : "details_required", code: job.data?.state.review ?? null,
    frozen: Boolean(merchant.data?.frozen_at), revision: merchant.data?.record.revision ?? null,
    commerce: merchant.data?.record.commercial ?? { price: loaded.pendingCommerce.sellingPrice, compareAtPrice: loaded.pendingCommerce.compareAtPrice,
      barcode: loaded.pendingCommerce.barcode, taxable: loaded.pendingCommerce.taxable, requiresShipping: loaded.pendingCommerce.requiresShipping },
    currency: loaded.pendingCommerce.currency, completedSteps: job.data?.state.index ?? 0 };
}

export type CommerceRunResult = WorkerResult & { continuationNeeded: boolean };
/** New owned products only. Confirmed progress may continue; uncertain writes never loop. */
export async function runPersistedCommerce(db: SupabaseClient, id: string, outerDeadline = Date.now() + 40000): Promise<CommerceRunResult> {
  const mode = commercialPublicationMode(process.env);
  if (!mode) return { status: "disabled", mutationAttempted: false, continuationNeeded: false };
  const end = Math.min(outerDeadline, Date.now() + 40000), owner = randomUUID(), database = commercialDatabase(db);
  if (end - Date.now() < 12000) return { status: "budget", mutationAttempted: false, continuationNeeded: false };
  let initializedLease = false;
  try {
    UUID.parse(id);
    const { data: existing, error } = await db.from("gallery_creation_commercial_jobs").select("item_id").eq("item_id", id).abortSignal(signal(end)).maybeSingle();
    if (error) fail("DATABASE_UNCONFIRMED");
    if (!existing) {
      const claimed = await rpc(db, "claim_gallery_shopify_draft", { p_id: id, p_owner: owner, p_seconds: 60 }, end - 3000);
      if (!claimed) return { status: "busy", mutationAttempted: false, continuationNeeded: false };
      initializedLease = true;
      let loaded = await source(db, id, owner, end - 3000);
      if (!loaded.intent) {
        // Facts are from the exact frozen merchant intent; supplier/source data is never consulted.
        const c = loaded.pendingCommerce;
        await saveCommerceEdit(db, { itemId: id, expectedRevision: null, requestId: randomUUID(), values: {
          price: c.sellingPrice, compareAtPrice: c.compareAtPrice, barcode: c.barcode, taxable: c.taxable,
          requiresShipping: c.requiresShipping, publishWhenReady: c.storeIntent === "publish_when_ready" } }, end - 3000, UUID.parse(loaded.publicationActorId));
        loaded = await source(db, id, owner, end - 3000);
      }
      if (!loaded.intent || loaded.intent.commercial.tracked) fail("MERCHANT_DETAILS_REQUIRED");
      const observation = await readCommerceShopify(loaded.identity, Math.min(end - 6000, Date.now() + 8000));
      loaded = await source(db, id, owner, end - 3000);
      if (!loaded.intent) fail("MERCHANT_DETAILS_REQUIRED");
      const read = assembleCommerceRead(observation, { ...loaded, context: { ...loaded.context, now: Date.now(), mode, environment: "production" } });
      const prepared = prepareFinalization(loaded.intent, loaded.proof, read.snapshot, read.context);
      await database.reserve(prepared.plan, prepared.state, owner, end - 3000);
      return { status: "pending", mutationAttempted: false, continuationNeeded: true };
    }
    const result = await runCommercialFinalization(id, owner, {
      ...database, mode, now: Date.now,
      read: async (record: StoredFinalization, leaseOwner: string, deadline: number) => {
        const observed = await readCommerceShopify(record.plan.initial.identity, Math.min(deadline - 3000, Date.now() + 5000));
        const loaded = await source(db, id, leaseOwner, deadline);
        return assembleCommerceRead(observed, { ...loaded, context: { ...loaded.context, now: Date.now(), mode, environment: "production" } });
      },
      send: (request, deadline) => sendCommercialRequest({ now: Date.now, graphql: async (query, variables) => {
        if (configuredShopifyDomain() !== SHOP || (process.env.SHOPIFY_API_VERSION?.trim() || API_VERSION) !== API_VERSION) fail("CONFIG_MISMATCH");
        return { data: await shopifyAdminGraphql(query, variables, Math.min(8000, Math.max(1, deadline - Date.now())), deadline) };
      } }, request, deadline),
    }, end);
    return { ...result, continuationNeeded: result.status === "pending" && !result.code };
  } catch (error) { return { status: "review", mutationAttempted: false, continuationNeeded: false, code: commerceCode(error) }; }
  finally { if (initializedLease) try { await database.release(id, owner, Math.min(end, Date.now() + 3000)); } catch { /* bounded expiry */ } }
}
