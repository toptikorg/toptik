import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, fetchProductSnapshot } from "./admin-api";
import { isSafeShopifyProductHandle } from "./sync-rules";
import { FZT73_PRODUCT_GID } from "./variant-source-policy";

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

/** Daily repair of missed deliveries, deduplicated without resetting old events.
 * Generic replay does publication only. The explicitly reviewed FZT73 family
 * also repairs its source-owned projection, including missing initial intake.
 */
export async function enqueuePublicationRecovery(supabase: SupabaseClient, day = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("SYNC_PUBLICATION_DAY_INVALID");
  // Include the approved unbound family so a missed create webhook self-recovers.
  const ids = new Set<string>([FZT73_PRODUCT_GID]);
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("shopify_gallery_bindings").select("catalog_key,product_gid")
      .order("catalog_key").range(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error("SYNC_PUBLICATION_BINDINGS_READ_FAILED");
    for (const row of data) {
      if (!/^gid:\/\/shopify\/Product\/\d+$/.test(row.product_gid)) throw new Error("SYNC_PUBLICATION_BINDING_INVALID");
      ids.add(row.product_gid);
    }
    if (data.length < 500) break;
    if (offset >= 9500) throw new Error("SYNC_PUBLICATION_BINDINGS_LIMIT");
  }
  const rows = [...ids].map(id => ({ delivery_id: `publication-recovery:${day}:${id}`, topic: "products/update",
    shop_domain: configuredShopifyDomain(), payload: { id: id.split("/").at(-1), publication_recovery: true }, status: "pending" }));
  for (let offset = 0; offset < rows.length; offset += 100) {
    const { error } = await supabase.from("shopify_webhook_events").upsert(rows.slice(offset, offset + 100),
      { onConflict: "delivery_id", ignoreDuplicates: true });
    if (error) throw new Error("SYNC_PUBLICATION_RECOVERY_QUEUE_FAILED");
  }
  return rows.length;
}
