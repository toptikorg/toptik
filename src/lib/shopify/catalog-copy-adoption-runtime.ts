import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, shopifyAdminGraphql, type ShopifyOnboardingSnapshot } from "./admin-api";
import { applyReviewedCopyAdoption, planExistingCopyAdoption, type CopyAdoptionApproval, type CopyAdoptionObservation,
  type CopyAdoptionPlan, type CopyAdoptionReceipt, type CopyAdoptionResolution } from "./catalog-copy-adoption";

type RawSource = Omit<ShopifyOnboardingSnapshot, "variants" | "media" | "seoTitle" | "seoDescription"> & {
  seo: { title: string | null; description: string | null } | null;
  variants: { nodes: ShopifyOnboardingSnapshot["variants"]; pageInfo: { hasNextPage: boolean } };
  media: { nodes: ShopifyOnboardingSnapshot["media"]; pageInfo: { hasNextPage: boolean } };
};
const QUERY = `query ReviewedExistingCopySource($id:ID!,$publicationId:ID!){product(id:$id){
 id handle title descriptionHtml status updatedAt vendor productType seo{title description}
 publishedOnPublication(publicationId:$publicationId)
 variants(first:2){nodes{id sku price inventoryQuantity selectedOptions{name value}} pageInfo{hasNextPage}}
 media(first:50){nodes{id alt status mediaContentType ... on MediaImage{image{url altText width height}}} pageInfo{hasNextPage}}
}}`;
function remaining(deadline: number) {
  const ms = deadline - Date.now();
  if (ms < 1) throw new Error("COPY_ADOPTION_TIME_BUDGET");
  return Math.min(ms, 6000);
}
async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>, deadline: number) {
  const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(remaining(deadline)));
  if (error) throw new Error(/^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "COPY_ADOPTION_RPC_FAILED");
  return data;
}
/** Private operator read only. No API route, worker or automatic bootstrap calls this adapter. */
export async function readExistingCopyAdoptionObservation(db: SupabaseClient, productGid: string, deadline = Date.now() + 45000): Promise<CopyAdoptionObservation> {
  if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productGid) || configuredShopifyDomain() !== "toptikcoil.myshopify.com") throw new Error("COPY_ADOPTION_SHOP_MISMATCH");
  const publicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim();
  if (publicationId !== "gid://shopify/Publication/79538258170") throw new Error("COPY_ADOPTION_PUBLICATION_UNCONFIGURED");
  const result = await shopifyAdminGraphql<{ product: RawSource | null }>(QUERY, { id: productGid, publicationId }, remaining(deadline), deadline);
  const p = result.product;
  if (!p || p.id !== productGid || p.variants.pageInfo.hasNextPage || p.variants.nodes.length !== 1 || p.media.pageInfo.hasNextPage) throw new Error("COPY_ADOPTION_SOURCE_INCOMPLETE");
  const { seo, variants, media, ...base } = p;
  const source: ShopifyOnboardingSnapshot = { ...base, seoTitle: seo?.title ?? null, seoDescription: seo?.description ?? null, variants: variants.nodes, media: media.nodes };
  const bindings = await db.from("shopify_gallery_bindings").select("*").eq("product_gid", productGid).limit(2)
    .abortSignal(AbortSignal.timeout(remaining(deadline)));
  if (bindings.error || bindings.data?.length !== 1) throw new Error("COPY_ADOPTION_BINDING_CONFLICT");
  const binding = bindings.data[0] as CopyAdoptionObservation["binding"], key = binding.catalog_key, itemId = binding.carousel_item_id;
  const [gallery, link, eligibility, state, outbox] = await Promise.all([
    db.from("carousel_items").select("*").eq("id", itemId).abortSignal(AbortSignal.timeout(remaining(deadline))).maybeSingle(),
    db.from("shopify_gallery_public_links").select("*").eq("catalog_key", key).abortSignal(AbortSignal.timeout(remaining(deadline))).maybeSingle(),
    db.from("shopify_gallery_copy_eligibility").select("*").eq("product_gid", productGid).abortSignal(AbortSignal.timeout(remaining(deadline))).maybeSingle(),
    db.from("shopify_gallery_sync_state").select("*").eq("catalog_key", key).abortSignal(AbortSignal.timeout(remaining(deadline))).maybeSingle(),
    db.from("shopify_gallery_content_outbox").select("id,catalog_key,status,attempts,created_at,content_hash").eq("carousel_item_id", itemId)
      .in("status", ["pending", "processing", "review", "failed"]).limit(100).abortSignal(AbortSignal.timeout(remaining(deadline))),
  ]);
  if (gallery.error || !gallery.data || link.error || eligibility.error || state.error || outbox.error || !outbox.data) throw new Error("COPY_ADOPTION_GALLERY_READ_FAILED");
  return { shopDomain: configuredShopifyDomain(), source, gallery: gallery.data as CopyAdoptionObservation["gallery"], binding,
    publicLink: link.data, approval: eligibility.data, state: state.data, unresolvedOutbox: outbox.data };
}

/** Always produces a non-approved difference package; default does not overwrite either side. */
export async function prepareExistingCopyAdoption(db: SupabaseClient, productGid: string, resolution: CopyAdoptionResolution = "preserve_both") {
  return planExistingCopyAdoption(await readExistingCopyAdoptionObservation(db, productGid), resolution);
}

/** Private operator adapter. The host must obtain the owner's approval of this exact planHash and
 * bind actorId to that authenticated owner, never accept a browser-supplied role/approval assertion.
 * No public route or queue currently exposes this operation. The owner can review the default
 * preserve_both package separately from an explicit adopt_shopify overwrite package. */
export async function commitExistingCopyAdoption(db: SupabaseClient, plan: CopyAdoptionPlan, approval: CopyAdoptionApproval) {
  const deadline = Date.now() + 55000;
  return applyReviewedCopyAdoption(plan, approval, {
    readReceipt: async id => await rpc(db, "read_reviewed_copy_adoption_receipt", { p_approval_id: id }, deadline) as CopyAdoptionReceipt | null,
    withProductLease: async (productGid, run) => {
      const owner = randomUUID();
      if (await rpc(db, "acquire_shopify_reconciliation_lease", { p_product_gid: productGid, p_owner: owner }, deadline) !== true) throw new Error("SYNC_RECONCILIATION_BUSY");
      try { return await run(owner); }
      finally {
        try { await rpc(db, "release_shopify_reconciliation_lease", { p_product_gid: productGid, p_owner: owner }, Date.now() + 3000); }
        catch { console.error("Reviewed copy adoption lease release failed"); }
      }
    },
    readObservation: id => readExistingCopyAdoptionObservation(db, id, deadline),
    commitReviewed: async (reviewed, evidence, owner) => await rpc(db, "commit_reviewed_copy_adoption", { p_plan: reviewed, p_approval: evidence, p_owner: owner }, deadline) as CopyAdoptionReceipt,
  });
}
