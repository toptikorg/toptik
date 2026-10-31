import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, fetchAllOnboardingVariantIdentities, fetchProductSnapshot } from "./admin-api";
import { isSafeShopifyProductHandle, normalizeSyncSku } from "./sync-rules";
import { FZT73_PRODUCT_GID, MD20_PRODUCT_GID } from "./variant-source-policy";

/** Publication is independent of copy/media approval. Caller holds the product lease.
 * Read current Shopify state even for delete events: a delayed event is not authority.
 * Only existing bindings are affected; editorial is_active and gallery-only rows stay intact.
 */
export async function refreshProductPublication(supabase: SupabaseClient, productGid: string, owner: string) {
  const product = await fetchProductSnapshot(productGid);
  if (product && (product.id !== productGid || !["ACTIVE", "DRAFT", "ARCHIVED"].includes(product.status) ||
      typeof product.publishedOnPublication !== "boolean" || !Number.isFinite(Date.parse(product.updatedAt)) ||
      !isSafeShopifyProductHandle(product.handle))) throw new Error("SYNC_PUBLICATION_SNAPSHOT_INVALID");
  const published = !!product && product.status === "ACTIVE" && product.publishedOnPublication;
  const variants = product?.variants.map(variant => variant.id) ?? [];
  if (variants.some(id => !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)) || new Set(variants).size !== variants.length) {
    throw new Error("SYNC_PUBLICATION_VARIANTS_INVALID");
  }
  const { error } = await supabase.rpc("refresh_shopify_gallery_publication", {
    p_product_gid: productGid, p_owner: owner, p_is_published: published,
    p_source_updated_at: product?.updatedAt ?? null, p_handle: product?.handle ?? null,
    p_visible_variant_gids: published ? variants : [],
  });
  if (error) throw new Error("SYNC_PUBLICATION_WRITE_FAILED");
  return { published, product };
}

export type ExactGalleryBinding = { catalogKey: string; itemId: string; variantGid: string };

/** Attach an already-existing Gallery row to an exact, freshly verified Shopify
 * variant. Callers hold the product lease and have already proved unique SKU,
 * product handle, publication state and item identity. This changes only the
 * narrow purchase-link projection; it never rewrites editorial copy or media. */
export async function upsertExactGalleryBindings(supabase: SupabaseClient, input: {
  productGid: string; handle: string; sourceUpdatedAt: string; published: boolean;
  bindings: ExactGalleryBinding[];
}): Promise<void> {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(input.productGid) ||
      !isSafeShopifyProductHandle(input.handle) || !Number.isFinite(Date.parse(input.sourceUpdatedAt)) ||
      input.bindings.length === 0) throw new Error("SYNC_EXISTING_GALLERY_BINDING_INVALID");
  const keys = new Set<string>();
  const items = new Set<string>();
  const variants = new Set<string>();
  for (const binding of input.bindings) {
    if (!/^[A-Z0-9]+$/.test(binding.catalogKey) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.itemId) ||
        !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(binding.variantGid) ||
        keys.has(binding.catalogKey) || items.has(binding.itemId) || variants.has(binding.variantGid)) {
      throw new Error("SYNC_EXISTING_GALLERY_BINDING_INVALID");
    }
    keys.add(binding.catalogKey); items.add(binding.itemId); variants.add(binding.variantGid);
  }
  for (const binding of input.bindings) {
    const { data, error } = await supabase.rpc("upsert_shopify_gallery_binding", {
      p_catalog_key: binding.catalogKey, p_carousel_item_id: binding.itemId,
      p_product_gid: input.productGid, p_variant_gid: binding.variantGid,
      p_product_handle: input.handle, p_is_published: input.published,
      p_source_updated_at: input.sourceUpdatedAt,
    });
    if (error || data !== true) throw new Error("SYNC_EXISTING_GALLERY_BINDING_WRITE_FAILED");
  }
}

/** Daily repair of missed deliveries, deduplicated without resetting old events.
 * Generic replay does publication only. The explicitly reviewed FZT73 family
 * also repairs its source-owned projection, including missing initial intake.
 */
export async function enqueuePublicationRecovery(supabase: SupabaseClient, day = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("SYNC_PUBLICATION_DAY_INVALID");
  // Include the approved unbound family so a missed create webhook self-recovers.
  const ids = new Set<string>([FZT73_PRODUCT_GID, MD20_PRODUCT_GID]);
  const boundVariantIds = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("shopify_gallery_bindings").select("catalog_key,product_gid,variant_gid")
      .order("catalog_key").range(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error("SYNC_PUBLICATION_BINDINGS_READ_FAILED");
    for (const row of data) {
      if (!/^gid:\/\/shopify\/Product\/\d+$/.test(row.product_gid)) throw new Error("SYNC_PUBLICATION_BINDING_INVALID");
      if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(row.variant_gid)) throw new Error("SYNC_PUBLICATION_BINDING_INVALID");
      ids.add(row.product_gid);
      boundVariantIds.add(row.variant_gid);
    }
    if (data.length < 500) break;
    if (offset >= 9500) throw new Error("SYNC_PUBLICATION_BINDINGS_LIMIT");
  }
  const galleryCatalogKeys = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("carousel_items").select("catalog_number")
      .order("id").range(offset, offset + 999);
    if (error || !Array.isArray(data)) throw new Error("SYNC_CATALOG_COVERAGE_GALLERY_READ_FAILED");
    for (const row of data) {
      const key = normalizeSyncSku(row.catalog_number);
      if (key) galleryCatalogKeys.add(key);
    }
    if (data.length < 1000) break;
    if (offset >= 9000) throw new Error("SYNC_CATALOG_COVERAGE_GALLERY_LIMIT");
  }
  const variants = await fetchAllOnboardingVariantIdentities(Date.now() + 40_000);
  const unboundVariants = variants.filter(variant => !boundVariantIds.has(variant.id));
  const missingProductIds = new Set(unboundVariants.filter(variant =>
    !galleryCatalogKeys.has(normalizeSyncSku(variant.sku) ?? "")).map(variant => variant.product.id));
  const unlinkedProductIds = new Set(unboundVariants.filter(variant =>
    galleryCatalogKeys.has(normalizeSyncSku(variant.sku) ?? "")).map(variant => variant.product.id));
  if ([...missingProductIds, ...unlinkedProductIds].some(id => !/^gid:\/\/shopify\/Product\/\d+$/.test(id))) {
    throw new Error("SYNC_CATALOG_COVERAGE_IDENTITY_INVALID");
  }
  const rows: Array<{ delivery_id: string; topic: "products/update"; shop_domain: string;
    payload: Record<string, unknown>; status: "pending" }> = [...ids].map(id => ({ delivery_id: `publication-recovery:${day}:${id}`, topic: "products/update",
    shop_domain: configuredShopifyDomain(), payload: { id: id.split("/").at(-1), publication_recovery: true }, status: "pending" }));
  rows.push(...[...missingProductIds].map(id => ({ delivery_id: `catalog-coverage:${day}:${id}`, topic: "products/update" as const,
    shop_domain: configuredShopifyDomain(), payload: { id: id.split("/").at(-1), catalog_coverage_recovery: true }, status: "pending" as const })));
  rows.push(...[...unlinkedProductIds].map(id => ({ delivery_id: `catalog-link:${day}:${id}`, topic: "products/update" as const,
    shop_domain: configuredShopifyDomain(), payload: { id: id.split("/").at(-1), catalog_link_recovery: true }, status: "pending" as const })));
  for (let offset = 0; offset < rows.length; offset += 100) {
    const { error } = await supabase.from("shopify_webhook_events").upsert(rows.slice(offset, offset + 100),
      { onConflict: "delivery_id", ignoreDuplicates: true });
    if (error) throw new Error("SYNC_PUBLICATION_RECOVERY_QUEUE_FAILED");
  }
  return rows.length;
}
