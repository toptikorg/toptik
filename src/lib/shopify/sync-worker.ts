import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchProductSnapshot,
  visibleCopyFromProduct,
  writeShopifyVisibleCopy,
  type ShopifyProductSnapshot,
  type ShopifyVisibleCopy,
} from "./admin-api";
import { assertVerifiedCopyApproval, assertVerifiedCopyIdentity, configuredShopifySyncMode, configuredSyncCanarySku, isSafeShopifyProductHandle, isSyncCanarySku, matchExactSkus, normalizeSyncSku, numericVariantId, shopifyProductGid, staleBindingKeys, type VerifiedCopyEligibility } from "./sync-rules";
import { readVerifiedCopyEligibility } from "./copy-eligibility";
import { ensurePublicShopifyOnboarding } from "./onboarding-worker";
import { isSyncReviewCode, mergeVisibleProductCopy, visibleCopiesEquivalent, type VisibleProductCopy } from "./sync-policy";

const BATCH_SIZE = 20;
type InboxEvent = { id: string; topic: "products/create" | "products/update" | "products/delete"; payload: Record<string, unknown> };
type OutboxRow = { id: string; carousel_item_id: string; catalog_key: string; content_hash: string; payload: VisibleProductCopy };
type BindingRow = { catalog_key: string; carousel_item_id: string; product_gid: string; variant_gid: string; product_handle: string; is_published: boolean; source_updated_at: string | null };
type GalleryCopyRow = { id: string; catalog_number: string | null; title: string; description: string | null; description_html?: string | null; seo_title: string | null; seo_description: string | null; copy_updated_at: string };

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "SYNC_UNKNOWN";
  return /^[A-Z0-9_]{1,80}$/.test(message) ? message : "SYNC_UNKNOWN";
}

function eventProductGid(event: InboxEvent): string | null {
  const id = event.payload.id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return shopifyProductGid(id);
}

function galleryCopy(row: GalleryCopyRow): VisibleProductCopy {
  return { title: row.title, description: row.description ?? "", descriptionHtml: row.description_html ?? null, seoTitle: row.seo_title, seoDescription: row.seo_description };
}

function assertCanarySnapshotIdentity(product: ShopifyProductSnapshot, binding: BindingRow): void {
  if (product.id !== binding.product_gid || product.variants.length !== 1 ||
      product.variants[0].id !== binding.variant_gid || normalizeSyncSku(product.variants[0].sku) !== binding.catalog_key) {
    throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  }
}

function hashCopy(payload: VisibleProductCopy): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function normalizedPayload(payload: unknown, catalogKey: string): VisibleProductCopy {
  if (!payload || typeof payload !== "object") throw new Error("SYNC_OUTBOX_PAYLOAD_INVALID");
  const value = payload as Partial<VisibleProductCopy>;
  if (typeof value.title !== "string" || !value.title.trim() || typeof value.description !== "string" ||
      !(value.descriptionHtml == null || typeof value.descriptionHtml === "string") ||
      !(value.seoTitle === null || typeof value.seoTitle === "string") ||
      !(value.seoDescription === null || typeof value.seoDescription === "string")) {
    throw new Error("SYNC_OUTBOX_PAYLOAD_INVALID");
  }
  // Verify the queue identity separately from the visible text. SKU never
  // becomes part of a product title or description by this integration.
  if (!/^[A-Z0-9]+$/.test(catalogKey)) throw new Error("SYNC_OUTBOX_SKU_MISMATCH");
  return { title: value.title.trim(), description: value.description, descriptionHtml: value.descriptionHtml ?? null, seoTitle: value.seoTitle, seoDescription: value.seoDescription };
}

async function updateExactProductBindings(supabase: SupabaseClient, event: InboxEvent, productGid: string, canarySku: string) {
  if (event.topic === "products/delete") {
    // The one-SKU canary is for copy round-trips only; deletion is deliberately
    // held for review and cannot deactivate a live Gallery binding.
    const { data, error } = await supabase.from("shopify_gallery_bindings")
      .select("catalog_key").eq("product_gid", productGid).eq("catalog_key", canarySku).limit(1);
    if (error) throw new Error("SYNC_BINDING_READ_FAILED");
    if (!data?.length) return { reviewCount: 0, product: null as ShopifyProductSnapshot | null };
    throw new Error("SYNC_CANARY_DELETE_DISABLED");
  }
  const product = await fetchProductSnapshot(productGid);
  if (!product) return { reviewCount: 0, product: null as ShopifyProductSnapshot | null };
  if (!isSafeShopifyProductHandle(product.handle)) throw new Error("SYNC_SHOPIFY_HANDLE_UNSAFE");
  const canaryVariants = product.variants.filter(variant => isSyncCanarySku(variant.sku, canarySku));
  if (canaryVariants.length === 0) return { reviewCount: 0, product: null as ShopifyProductSnapshot | null };
  if (canaryVariants.length > 1) throw new Error("SYNC_CANARY_VARIANT_AMBIGUOUS");
  // Shopify copy belongs to the product, not a variant. A one-SKU canary
  // must not change copy shared by unselected sibling variants.
  if (product.variants.length !== 1) throw new Error("SYNC_CANARY_PRODUCT_HAS_MULTIPLE_VARIANTS");
  const { data: allItems, error: itemError } = await supabase.from("carousel_items").select("id,catalog_number");
  if (itemError || !allItems) throw new Error("SYNC_GALLERY_CATALOG_READ_FAILED");
  const { data: previousBindings, error: bindingReadError } = await supabase.from("shopify_gallery_bindings")
    .select("catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at").eq("product_gid", productGid);
  if (bindingReadError) throw new Error("SYNC_BINDING_READ_FAILED");
  const previous = ((previousBindings ?? []) as BindingRow[]).filter(row => row.catalog_key === canarySku);
  const previousKeys = new Set(previous.map(row => row.catalog_key));
  const galleryItems = (allItems as Array<{id:string;catalog_number:string|null}>).filter(row => {
    const key = normalizeSyncSku(row.catalog_number);
    return key === canarySku || (key !== null && previousKeys.has(key));
  });
  const result = matchExactSkus(galleryItems.map(row => ({ id: row.id, catalogNumber: row.catalog_number })), canaryVariants);
  const conflicts = result.reviews.map(review => `${review.reason}:${review.catalogKey ?? "none"}`);
  const protectedKeys = new Set(result.reviews.filter(r => r.reason === "duplicate_gallery_sku" || r.reason === "duplicate_shopify_sku")
    .map(r => r.catalogKey).filter((key): key is string => key !== null));
  const existingByKey = new Map(previous.map(row => [row.catalog_key, row]));
  const isPublished = product.status === "ACTIVE" && product.publishedOnPublication;
  const accepted = new Set<string>();
  for (const match of result.matches) {
    const variantId = numericVariantId(match.variantGid);
    if (!variantId) { conflicts.push(`invalid_variant_gid:${match.catalogKey}`); protectedKeys.add(match.catalogKey); continue; }
    const old = existingByKey.get(match.catalogKey);
    if (old && (old.carousel_item_id !== match.galleryItemId || old.variant_gid !== match.variantGid || old.product_gid !== productGid)) {
      conflicts.push(`existing_binding_conflict:${match.catalogKey}`); protectedKeys.add(match.catalogKey); continue;
    }
    const { data: upserted, error } = await supabase.rpc("upsert_shopify_gallery_binding", {
      p_catalog_key: match.catalogKey, p_carousel_item_id: match.galleryItemId, p_product_gid: productGid,
      p_variant_gid: match.variantGid, p_product_handle: product.handle, p_is_published: isPublished, p_source_updated_at: product.updatedAt,
    });
    if (error) throw new Error("SYNC_BINDING_WRITE_FAILED");
    if (upserted !== true) { conflicts.push(`binding_unique_constraint_conflict:${match.catalogKey}`); protectedKeys.add(match.catalogKey); continue; }
    accepted.add(match.catalogKey);
  }
  const stale = staleBindingKeys(previous.map(row => row.catalog_key), accepted, protectedKeys);
  if (stale.length) {
    const { error } = await supabase.rpc("deactivate_shopify_gallery_keys", { p_product_gid: productGid, p_catalog_keys: stale, p_source_updated_at: product.updatedAt });
    if (error) throw new Error("SYNC_STALE_BINDING_DEACTIVATE_FAILED");
  }
  return { reviewCount: conflicts.length, reviewSummary: conflicts.slice(0, 20).join(","), product };
}

async function singleBindingForProduct(supabase: SupabaseClient, productGid: string, expectedKey?: string) {
  const { data, error } = await supabase.from("shopify_gallery_bindings")
    .select("catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at")
    .eq("product_gid", productGid).limit(2);
  if (error) throw new Error("SYNC_BINDING_READ_FAILED");
  const rows = (data ?? []) as BindingRow[];
  if (rows.length !== 1 || (expectedKey && rows[0].catalog_key !== expectedKey)) throw new Error("SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS");
  return rows[0];
}

async function readGalleryCopyRow(supabase: SupabaseClient, binding: BindingRow): Promise<GalleryCopyRow> {
  const { data, error } = await supabase.from("carousel_items")
    .select("id,catalog_number,title,description,description_html,seo_title,seo_description,copy_updated_at")
    .eq("id", binding.carousel_item_id).maybeSingle();
  if (error || !data) throw new Error("SYNC_GALLERY_COPY_READ_FAILED");
  if (normalizeSyncSku(data.catalog_number) !== binding.catalog_key) throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  return data as GalleryCopyRow;
}

async function saveGalleryCopy(supabase: SupabaseClient, row: GalleryCopyRow, copy: VisibleProductCopy): Promise<string> {
  const updatedAt = new Date().toISOString();
  const { data, error } = await supabase.from("carousel_items").update({
    title: copy.title, description: copy.description || null, description_html: copy.descriptionHtml ?? null, seo_title: copy.seoTitle,
    seo_description: copy.seoDescription, copy_updated_at: updatedAt,
  }).eq("id", row.id).eq("copy_updated_at", row.copy_updated_at).select("id").maybeSingle();
  if (error) throw new Error("SYNC_GALLERY_COPY_WRITE_FAILED");
  if (!data) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
  return updatedAt;
}

async function writeConflictAudit(supabase: SupabaseClient, binding: BindingRow, merged: ReturnType<typeof mergeVisibleProductCopy>, gallery: VisibleProductCopy, shopify: VisibleProductCopy, galleryUpdatedAt: string, shopifyUpdatedAt: string) {
  if (!merged.conflicts.length) return;
  const rows = merged.conflicts.map(conflict => {
    const field = conflict.field;
    const galleryValue = field === "description" ? JSON.stringify({ text: gallery.description, html: gallery.descriptionHtml ?? null }) : gallery[field];
    const shopifyValue = field === "description" ? JSON.stringify({ text: shopify.description, html: shopify.descriptionHtml ?? null }) : shopify[field];
    const conflictKey = createHash("sha256").update(JSON.stringify([binding.catalog_key, field, galleryValue, shopifyValue, conflict.winner, galleryUpdatedAt, shopifyUpdatedAt])).digest("hex");
    return {
      conflict_key: conflictKey, catalog_key: binding.catalog_key, carousel_item_id: binding.carousel_item_id,
      product_gid: binding.product_gid, field_name: field === "seoTitle" ? "seo_title" : field === "seoDescription" ? "seo_description" : field,
      gallery_value: galleryValue, shopify_value: shopifyValue, winner: conflict.winner,
      gallery_updated_at: galleryUpdatedAt, shopify_updated_at: shopifyUpdatedAt,
    };
  });
  const { error } = await supabase.from("shopify_gallery_sync_conflicts").upsert(rows, { onConflict: "conflict_key", ignoreDuplicates: true });
  if (error) throw new Error("SYNC_CONFLICT_AUDIT_WRITE_FAILED");
}

async function mergeAndPersist(supabase: SupabaseClient, binding: BindingRow, product: ShopifyProductSnapshot, initialGallery?: GalleryCopyRow,
  verified?: { approval: VerifiedCopyEligibility; leaseOwner: string }) {
  let galleryRow = initialGallery ?? await readGalleryCopyRow(supabase, binding);
  const verifyCurrentIdentity = async (snapshot: ShopifyProductSnapshot) => {
    if (!verified) { assertCanarySnapshotIdentity(snapshot, binding); return; }
    const approval = await readVerifiedCopyEligibility(supabase, binding.product_gid);
    assertVerifiedCopyApproval(approval);
    if (approval.approval_id !== verified.approval.approval_id) throw new Error("SYNC_COPY_NOT_APPROVED");
    const currentBinding = await singleBindingForProduct(supabase, binding.product_gid, binding.catalog_key);
    const currentGallery = await readGalleryCopyRow(supabase, currentBinding);
    assertVerifiedCopyIdentity(approval, currentBinding, currentGallery, snapshot);
    if (currentGallery.copy_updated_at !== galleryRow.copy_updated_at) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
  };
  if (verified) await verifyCurrentIdentity(product);
  let shopifyCopy: ShopifyVisibleCopy = visibleCopyFromProduct(product);
  const { data: state, error: stateError } = await supabase.from("shopify_gallery_sync_state")
    .select("last_synced_payload,gallery_baseline_payload,shopify_baseline_payload").eq("catalog_key", binding.catalog_key).maybeSingle();
  if (stateError) throw new Error("SYNC_STATE_READ_FAILED");
  if (verified && (!state?.last_synced_payload || !state.gallery_baseline_payload || !state.shopify_baseline_payload)) throw new Error("SYNC_VERIFIED_BASELINE_REQUIRED");
  const lastSynced = (state?.last_synced_payload ?? null) as VisibleProductCopy | null;
  const galleryBaseline = (state?.gallery_baseline_payload ?? lastSynced) as VisibleProductCopy | null;
  const shopifyBaseline = (state?.shopify_baseline_payload ?? lastSynced) as VisibleProductCopy | null;
  let merged = mergeVisibleProductCopy(
    galleryCopy(galleryRow), shopifyCopy, lastSynced, galleryRow.copy_updated_at, product.updatedAt,
    galleryBaseline, shopifyBaseline,
  );
  await writeConflictAudit(supabase, binding, merged, galleryCopy(galleryRow), shopifyCopy, galleryRow.copy_updated_at, product.updatedAt);

  // Shopify's productUpdate mutation has no compare-and-swap token. Re-read
  // immediately before writing and abort if Shopify copy changed since merge.
  if (merged.shopifyChanged) {
    const latest = await fetchProductSnapshot(binding.product_gid);
    if (!latest) throw new Error("SYNC_SHOPIFY_PRODUCT_MISSING");
    await verifyCurrentIdentity(latest);
    const latestCopy = visibleCopyFromProduct(latest);
    if (!visibleCopiesEquivalent(latestCopy, shopifyCopy)) {
      shopifyCopy = latestCopy;
      merged = mergeVisibleProductCopy(
        galleryCopy(galleryRow), shopifyCopy, lastSynced, galleryRow.copy_updated_at, latest.updatedAt,
        galleryBaseline, shopifyBaseline,
      );
      await writeConflictAudit(supabase, binding, merged, galleryCopy(galleryRow), shopifyCopy, galleryRow.copy_updated_at, latest.updatedAt);
      if (merged.shopifyChanged) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
    } else {
      if (verified) {
        const { data: authorized, error } = await supabase.rpc("assert_shopify_verified_copy_write", {
          p_item_id: galleryRow.id, p_catalog_key: binding.catalog_key, p_exact_sku: verified.approval.exact_gallery_sku,
          p_product_gid: binding.product_gid, p_variant_gid: binding.variant_gid,
          p_exact_shopify_sku: verified.approval.exact_shopify_sku, p_expected_version: galleryRow.copy_updated_at,
          p_lease_owner: verified.leaseOwner,
        });
        if (error) throw new Error(/^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_COPY_NOT_APPROVED");
        if (authorized !== true) throw new Error("SYNC_COPY_NOT_APPROVED");
      }
      await writeShopifyVisibleCopy(binding.product_gid, merged.shopifyCopy, latest);
    }
  }

  if (merged.galleryChanged) {
    let newGalleryUpdatedAt: string;
    if (verified) {
      const latest = await fetchProductSnapshot(binding.product_gid);
      if (!latest) throw new Error("SYNC_SHOPIFY_PRODUCT_MISSING");
      await verifyCurrentIdentity(latest);
      if (!visibleCopiesEquivalent(visibleCopyFromProduct(latest), merged.shopifyCopy)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
      const { data, error } = await supabase.rpc("apply_shopify_verified_copy", {
        p_item_id: galleryRow.id, p_catalog_key: binding.catalog_key, p_exact_sku: verified.approval.exact_gallery_sku,
        p_product_gid: binding.product_gid, p_variant_gid: binding.variant_gid,
        p_exact_shopify_sku: verified.approval.exact_shopify_sku, p_expected_version: galleryRow.copy_updated_at,
        p_copy: merged.galleryCopy, p_lease_owner: verified.leaseOwner,
      });
      if (error) throw new Error(/^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_GALLERY_COPY_WRITE_FAILED");
      if (!data?.copyUpdatedAt) throw new Error("SYNC_GALLERY_COPY_WRITE_FAILED");
      newGalleryUpdatedAt = data.copyUpdatedAt;
    } else {
      newGalleryUpdatedAt = await saveGalleryCopy(supabase, galleryRow, merged.galleryCopy);
    }
    galleryRow = { ...galleryRow, ...{
      title: merged.galleryCopy.title, description: merged.galleryCopy.description || null, description_html: merged.galleryCopy.descriptionHtml ?? null,
      seo_title: merged.galleryCopy.seoTitle, seo_description: merged.galleryCopy.seoDescription, copy_updated_at: newGalleryUpdatedAt,
    } };
  }

  const latestProduct = await fetchProductSnapshot(binding.product_gid);
  if (!latestProduct) throw new Error("SYNC_SHOPIFY_PRODUCT_MISSING");
  await verifyCurrentIdentity(latestProduct);
  const verifiedShopifyCopy = visibleCopyFromProduct(latestProduct);
  const verifiedGalleryCopy = galleryCopy(await readGalleryCopyRow(supabase, binding));
  if (!visibleCopiesEquivalent(verifiedShopifyCopy, merged.shopifyCopy) ||
      !visibleCopiesEquivalent(verifiedGalleryCopy, merged.galleryCopy)) {
    throw new Error("SYNC_COPY_READBACK_MISMATCH");
  }
  const nextState = {
    catalog_key: binding.catalog_key,
    last_synced_payload: verifiedShopifyCopy,
    last_synced_hash: hashCopy(verifiedShopifyCopy),
    gallery_baseline_payload: verifiedGalleryCopy,
    shopify_baseline_payload: verifiedShopifyCopy,
    gallery_updated_at: galleryRow.copy_updated_at,
    shopify_updated_at: latestProduct.updatedAt,
    synced_at: new Date().toISOString(),
  };
  const { data: savedState, error: stateWriteError } = verified
    ? await supabase.from("shopify_gallery_sync_state").update(nextState).eq("catalog_key", binding.catalog_key).select("catalog_key").maybeSingle()
    : await supabase.from("shopify_gallery_sync_state").upsert(nextState, { onConflict: "catalog_key" });
  if (stateWriteError) throw new Error("SYNC_STATE_WRITE_FAILED");
  if (verified && !savedState) throw new Error("SYNC_VERIFIED_BASELINE_REQUIRED");
}

async function withProductReconciliationLease<T>(supabase: SupabaseClient, productGid: string, action: (owner: string) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const { data: acquired, error } = await supabase.rpc("acquire_shopify_reconciliation_lease", {
    p_product_gid: productGid, p_owner: owner,
  });
  if (error) throw new Error("SYNC_RECONCILIATION_LEASE_FAILED");
  if (acquired !== true) throw new Error("SYNC_RECONCILIATION_BUSY");
  try {
    return await action(owner);
  } finally {
    const { error: releaseError } = await supabase.rpc("release_shopify_reconciliation_lease", {
      p_product_gid: productGid, p_owner: owner,
    });
    if (releaseError) console.error("Shopify reconciliation lease release failed", { code: "SYNC_RECONCILIATION_LEASE_RELEASE_FAILED" });
  }
}

async function processOneInboxEvent(supabase: SupabaseClient, event: InboxEvent, deadline: number) {
  const productGid = eventProductGid(event);
  if (!productGid) throw new Error("SYNC_PRODUCT_GID_INVALID");
  return withProductReconciliationLease(supabase, productGid, owner => reconcileInboxEvent(supabase, event, productGid, owner, deadline));
}

async function reconcileInboxEvent(supabase: SupabaseClient, event: InboxEvent, productGid: string, leaseOwner: string, deadline: number) {
  const mode = configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE);
  if (mode === "disabled") throw new Error("SYNC_MODE_NOT_CONFIGURED");
  if (mode === "verified_catalog") {
    const approval = await readVerifiedCopyEligibility(supabase, productGid);
    if (!approval && event.topic !== "products/delete" && process.env.SHOPIFY_SYNC_AUTOCREATE === "published_shopify") {
      // Admission creates independent copy baselines in one transaction. Do not
      // merge again here: a subsequent real edit is reconciled by its own event.
      // Explicitly excluded brands/drafts are acknowledged without catalog writes.
      await ensurePublicShopifyOnboarding(supabase, { eventId: event.id, productGid, leaseOwner, deadline });
      const { error } = await supabase.from("shopify_webhook_events").update({ status: "processed", processed_at: new Date().toISOString(), last_error: null }).eq("id", event.id);
      if (error) throw new Error("SYNC_EVENT_FINALIZE_FAILED");
      return "processed";
    }
    assertVerifiedCopyApproval(approval);
    if (event.topic === "products/delete") throw new Error("SYNC_VERIFIED_DELETE_DISABLED");
    const binding = await singleBindingForProduct(supabase, productGid, approval.catalog_key);
    const gallery = await readGalleryCopyRow(supabase, binding);
    const product = await fetchProductSnapshot(productGid);
    if (!product) throw new Error("SYNC_SHOPIFY_PRODUCT_MISSING");
    assertVerifiedCopyIdentity(approval, binding, gallery, product);
    await mergeAndPersist(supabase, binding, product, gallery, { approval, leaseOwner });
    const { error } = await supabase.from("shopify_webhook_events").update({ status: "processed", processed_at: new Date().toISOString(), last_error: null }).eq("id", event.id);
    if (error) throw new Error("SYNC_EVENT_FINALIZE_FAILED");
    return "processed";
  }
  const canarySku = configuredSyncCanarySku(process.env.SHOPIFY_SYNC_CANARY_SKU);
  if (!canarySku) throw new Error("SYNC_CANARY_NOT_CONFIGURED");
  const result = await updateExactProductBindings(supabase, event, productGid, canarySku);
  let copyAmbiguous = false;
  if (result.product && !result.reviewCount) {
    const binding = await singleBindingForProduct(supabase, productGid).catch(error => {
      if (error instanceof Error && error.message === "SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS") { copyAmbiguous = true; return null; }
      throw error;
    });
    if (binding) await mergeAndPersist(supabase, binding, result.product);
  }
  const status = result.reviewCount || copyAmbiguous ? "review" : "processed";
  const { error } = await supabase.from("shopify_webhook_events").update({
    status, processed_at: new Date().toISOString(), last_error: copyAmbiguous ? "SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS" : result.reviewCount ? result.reviewSummary ?? "SYNC_REVIEW_REQUIRED" : null,
  }).eq("id", event.id);
  if (error) throw new Error("SYNC_EVENT_FINALIZE_FAILED");
  return status;
}

async function processOneOutboxRow(supabase: SupabaseClient, row: OutboxRow, canarySku: string | null) {
  const mode = configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE);
  if (mode === "disabled") throw new Error("SYNC_MODE_NOT_CONFIGURED");
  if (mode !== "verified_catalog" && !isSyncCanarySku(row.catalog_key, canarySku)) throw new Error("SYNC_SKU_OUTSIDE_CANARY");
  const { data: bindingData, error } = await supabase.from("shopify_gallery_bindings")
    .select("catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at")
    .eq("catalog_key", row.catalog_key).maybeSingle();
  if (error) throw new Error("SYNC_BINDING_READ_FAILED");
  const binding = bindingData as BindingRow | null;
  if (!binding || binding.carousel_item_id !== row.carousel_item_id) throw new Error("SYNC_BINDING_MISSING_OR_CONFLICTED");
  return withProductReconciliationLease(supabase, binding.product_gid, owner => reconcileOutboxRow(supabase, row, binding, owner));
}

async function reconcileOutboxRow(supabase: SupabaseClient, row: OutboxRow, binding: BindingRow, leaseOwner?: string) {
  const verifiedMode = configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE) === "verified_catalog";
  const approval = verifiedMode ? await readVerifiedCopyEligibility(supabase, binding.product_gid) : null;
  if (verifiedMode) assertVerifiedCopyApproval(approval);
  const product = await fetchProductSnapshot(binding.product_gid);
  if (!product) throw new Error("SYNC_SHOPIFY_PRODUCT_MISSING");
  if (product.variants.length !== 1) throw new Error("SYNC_CANARY_PRODUCT_HAS_MULTIPLE_VARIANTS");
  const variant = product.variants.find(candidate => candidate.id === binding.variant_gid);
  if (!variant || (!verifiedMode && normalizeSyncSku(variant.sku) !== row.catalog_key)) throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  const oneBinding = await singleBindingForProduct(supabase, binding.product_gid, row.catalog_key);
  const currentGallery = await readGalleryCopyRow(supabase, oneBinding);
  if (verifiedMode && approval) assertVerifiedCopyIdentity(approval, oneBinding, currentGallery, product);
  const queued = normalizedPayload(row.payload, row.catalog_key);
  // Use the latest saved Gallery value, never a stale historical queue body.
  // Queue bodies are immutable snapshots. A later Gallery edit supersedes the
  // queued snapshot; always reconcile the latest saved row to avoid stale writes.
  void queued;
  if (verifiedMode && !leaseOwner) throw new Error("SYNC_RECONCILIATION_LEASE_FAILED");
  await mergeAndPersist(supabase, oneBinding, product, currentGallery,
    verifiedMode && approval ? { approval, leaseOwner: leaseOwner! } : undefined);
  const { error: finalizeError } = await supabase.from("shopify_gallery_content_outbox").update({ status: "synced", synced_at: new Date().toISOString(), last_error: null }).eq("id", row.id);
  if (finalizeError) throw new Error("SYNC_OUTBOX_FINALIZE_FAILED");
  return "synced";
}

async function processQueue<T extends { id: string; attempts?: number }>(supabase: SupabaseClient, rpcName: "claim_shopify_webhook_events" | "claim_shopify_gallery_outbox", processor: (row: T) => Promise<string>, deadline = Infinity) {
  // Do not strand a batch of claimed rows when the serverless invocation ends.
  // Reserve one HTTP timeout before starting another existing-product operation.
  if (Date.now() + 15_000 >= deadline) return { processed: 0, reviewed: 0, failed: 0 };
  const verifiedMode = configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE) === "verified_catalog";
  const { data, error } = await supabase.rpc(rpcName, { p_limit: verifiedMode ? 1 : BATCH_SIZE });
  if (error) throw new Error(`SYNC_QUEUE_CLAIM_FAILED_${rpcName === "claim_shopify_webhook_events" ? "EVENT" : "OUTBOX"}`);
  let processed = 0, reviewed = 0, failed = 0;
  for (const row of (data ?? []) as T[]) {
    try {
      const status = await processor(row);
      if (status === "review") reviewed++; else processed++;
    } catch (error) {
      const code = safeErrorCode(error);
      const table = rpcName === "claim_shopify_webhook_events" ? "shopify_webhook_events" : "shopify_gallery_content_outbox";
      const busy = code === "SYNC_RECONCILIATION_BUSY";
      const status = busy ? "pending" : isSyncReviewCode(code) ? "review" : "failed";
      const failureUpdate = busy
        ? { status, attempts: Math.max(0, (row.attempts ?? 1) - 1), claimed_at: null, last_error: code }
        : rpcName === "claim_shopify_webhook_events"
        ? { status, processed_at: status === "review" ? new Date().toISOString() : null, last_error: code }
        : { status, last_error: code };
      const { error: markError } = await supabase.from(table).update(failureUpdate).eq("id", row.id);
      if (markError) throw new Error("SYNC_FAILED_ROW_STATUS_WRITE_FAILED");
      if (status === "review") reviewed++; else failed++;
    }
  }
  return { processed, reviewed, failed };
}

export async function processShopifySyncQueues(supabase: SupabaseClient, deadline = Date.now() + 45_000) {
  const mode = configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE);
  if (mode === "disabled") throw new Error("SYNC_MODE_NOT_CONFIGURED");
  const canarySku = configuredSyncCanarySku(process.env.SHOPIFY_SYNC_CANARY_SKU);
  if (mode === "canary" && !canarySku) throw new Error("SYNC_CANARY_NOT_CONFIGURED");
  const events = await processQueue<InboxEvent>(supabase, "claim_shopify_webhook_events", row => processOneInboxEvent(supabase, row, deadline), deadline);
  const outbox = await processQueue<OutboxRow>(supabase, "claim_shopify_gallery_outbox", row => processOneOutboxRow(supabase, row, canarySku), deadline);
  return { events, outbox };
}

/** Drain bounded batches without immediately hammering transient failures. */
export async function drainShopifySyncQueues(supabase: SupabaseClient, budgetMs = 45_000) {
  const start = Date.now();
  const total = { events: { processed: 0, reviewed: 0, failed: 0 }, outbox: { processed: 0, reviewed: 0, failed: 0 } };
  let exhausted = false;
  for (let round = 0; round < 10 && Date.now() - start < budgetMs; round++) {
    const next = await processShopifySyncQueues(supabase, start + budgetMs);
    for (const key of ["events", "outbox"] as const) {
      total[key].processed += next[key].processed;
      total[key].reviewed += next[key].reviewed;
      total[key].failed += next[key].failed;
    }
    const didWork = next.events.processed + next.events.reviewed + next.outbox.processed + next.outbox.reviewed;
    if (next.events.failed + next.outbox.failed > 0) break;
    if (didWork === 0) {
      // An empty inbox read can consume the remaining reserve before outbox
      // claiming. Earlier progress must still wake pending work in that case.
      exhausted = Date.now() + 15_000 >= start + budgetMs &&
        total.events.processed + total.events.reviewed + total.outbox.processed + total.outbox.reviewed > 0;
      break;
    }
    if (round === 9 || Date.now() + 15_000 >= start + budgetMs) { exhausted = true; break; }
  }
  let continuationNeeded = false;
  if (exhausted && configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE) === "verified_catalog" &&
      total.events.failed + total.outbox.failed === 0) {
    // Only fresh pending work can continue a successful drain. Failed, leased,
    // busy-requeued and exhausted-attempt rows never fuel an immediate loop.
    const remaining = await Promise.all(["shopify_webhook_events", "shopify_gallery_content_outbox"].map(table =>
      supabase.from(table).select("id").eq("status", "pending").lt("attempts", 5).is("last_error", null).limit(1)));
    if (remaining.some(result => result.error)) throw new Error("SYNC_CONTINUATION_QUEUE_READ_FAILED");
    continuationNeeded = remaining.some(result => (result.data?.length ?? 0) > 0);
  }
  return { ...total, continuationNeeded };
}

export function gallerySyncHash(payload: VisibleProductCopy): string { return hashCopy(payload); }
export function outboxPayload(payload: VisibleProductCopy): VisibleProductCopy { return { ...payload }; }
