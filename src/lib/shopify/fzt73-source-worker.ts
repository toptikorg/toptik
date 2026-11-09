import "server-only";
import type { OwnedCard } from "./owned-edit-plan";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readOwnedMappedSource, ownedMappedMediaProjection, ownedSourceMediaContext, type OwnedMappedSource } from "./owned-media-projection";
import { applyOwnedMediaSourceProjection } from "./owned-media-registry";
import { configuredShopifyDomain, shopifyAdminGraphql, visibleCopyFromProduct, type ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml } from "./description-document";
import { verifyOnboardingImage } from "./onboarding-worker";
import { FZT73_PRODUCT_GID, FZT73_PRODUCT_HANDLE, FZT73_VARIANTS, exactFzt73Media, exactVariantSeo } from "./variant-source-policy";

export async function readFzt73Snapshot(deadline: number, db?: SupabaseClient): Promise<ShopifyOnboardingSnapshot | null> {
  if (db) { const mapped=await readOwnedMappedSource(db,FZT73_PRODUCT_GID,deadline); if(mapped)return mapped; }
  const publicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim();
  if (publicationId !== "gid://shopify/Publication/79538258170") throw new Error("SYNC_ONBOARDING_PUBLICATION_MISMATCH");
  type Product = Omit<ShopifyOnboardingSnapshot, "variants" | "media" | "seoTitle" | "seoDescription"> & {
    variants: { nodes: (ShopifyOnboardingSnapshot["variants"][number] & { selectedOptions: { name: string; value: string }[] })[]; pageInfo: { hasNextPage: boolean } };
    media: { nodes: ShopifyOnboardingSnapshot["media"]; pageInfo: { hasNextPage: boolean } };
    seo: { title: string | null; description: string | null };
  };
  const result = await shopifyAdminGraphql<{ product: Product | null }>(`query GalleryFzt73Source($id: ID!, $publicationId: ID!) {
    product(id: $id) { id handle title descriptionHtml status updatedAt vendor productType seo { title description }
      publishedOnPublication(publicationId: $publicationId)
      variants(first: 5) { nodes { id sku selectedOptions { name value } } pageInfo { hasNextPage } }
      media(first: 61) { nodes { id alt status mediaContentType ... on MediaImage { image { url altText width height } } } pageInfo { hasNextPage } }
    }
  }`, { id: FZT73_PRODUCT_GID, publicationId }, 6000, deadline);
  const p = result.product;
  if (p === null) return null; // Only a successful authenticated null read means removed.
  if (!p || p.id !== FZT73_PRODUCT_GID || p.handle !== FZT73_PRODUCT_HANDLE ||
      !["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].includes(p.status) || typeof p.publishedOnPublication !== "boolean" ||
      p.variants.pageInfo.hasNextPage || p.variants.nodes.length !== 4 ||
      FZT73_VARIANTS.some(v => !p.variants.nodes.some(row => row.id === `gid://shopify/ProductVariant/${v.variantId}` && row.sku === v.sku &&
        row.selectedOptions.some(option => option.name === "צבע" && option.value === v.color)))) {
    throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  }
  if (p.media.pageInfo.hasNextPage || p.media.nodes.length > 60) throw new Error("SYNC_ONBOARDING_MEDIA_LIMIT");
  if (p.title.length > 120 || p.descriptionHtml.length > 250000) throw new Error("SYNC_ONBOARDING_COPY_LIMIT");
  assertSafeDescriptionHtml(p.descriptionHtml);
  return { ...p, variants: p.variants.nodes, media: p.media.nodes, seoTitle: p.seo?.title ?? null, seoDescription: p.seo?.description ?? null };
}

const key = (sku: string | null) => (sku ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/TU$/, "");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
};
const same = (row: Record<string, unknown> | undefined, patch: Record<string, unknown>) =>
  !!row && Object.entries(patch).every(([k,v]) => canonical(row[k]) === canonical(v));
export const sameFzt73Source = (left: ShopifyOnboardingSnapshot | null, right: ShopifyOnboardingSnapshot | null) => {
  if (!left || !right) return left === right;
  // A timestamp-only change is not a content or identity change. All actual
  // source fields, publication and color/media identity remain compared.
  const a: Partial<ShopifyOnboardingSnapshot> = { ...left };
  const b: Partial<ShopifyOnboardingSnapshot> = { ...right };
  delete a.updatedAt; delete b.updatedAt;
  for(const row of [a,b]){const map=(row as OwnedMappedSource).ownedMediaMap;if(map)(row as OwnedMappedSource).ownedMediaMap={...map,version:0};}
  return canonical(a) === canonical(b);
};
export function fzt73SourceProjection(source: ShopifyOnboardingSnapshot, v: typeof FZT73_VARIANTS[number]): OwnedCard {
  const mapped=ownedMappedMediaProjection(source,v.itemId);
  const media = mapped ? [] : exactFzt73Media(source.media, v.sku);
  const copy = visibleCopyFromProduct(source);
  const seo = exactVariantSeo(copy,v.sku);
  return {title:copy.title + ` בצבע ${v.color}`,description:copy.description || null,description_html:copy.descriptionHtml ?? null,
    seo_title:seo.seoTitle,seo_description:seo.seoDescription,cover_image_path:mapped?.cover_image_path??media[0].image!.url,cover_image_alt:mapped?mapped.cover_image_alt:media[0].alt,
    angles:media.map((m,i)=>({angle_key:String(i+1),angle_order:i+1,image_path:m.image!.url,image_alt:m.alt})),...(mapped??{})};
}

/** The normal webhook/recovery worker holds the product lease. Source-owned,
 * reviewed four-color intake only; no Shopify writes, binding changes or approvals. */
export async function reconcileFzt73Variants(db: SupabaseClient, deadline: number, leaseOwner: string): Promise<void> {
  if (configuredShopifyDomain() !== "toptikcoil.myshopify.com") throw new Error("SYNC_ONBOARDING_SHOP_MISMATCH");
  const source = await readFzt73Snapshot(deadline,db);
  const published = !!source && source.status === "ACTIVE" && source.publishedOnPublication;
  const ids = FZT73_VARIANTS.map(v => v.itemId);
  const [items, angles, bindings] = await Promise.all([
    db.from("carousel_items").select("*").in("id", ids),
    db.from("carousel_item_angles").select("*").in("item_id", ids),
    db.from("shopify_gallery_bindings").select("catalog_key,carousel_item_id,product_gid,variant_gid").in("carousel_item_id", ids),
  ]);
  if (items.error || angles.error || bindings.error || !items.data || !angles.data || !bindings.data) throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
  for (const v of FZT73_VARIANTS.filter(v => items.data.some(row => row.id === v.itemId))) {
    const matches = bindings.data.filter(b => b.carousel_item_id === v.itemId);
    if (matches.length !== 1 || matches[0].catalog_key !== v.sku || matches[0].product_gid !== FZT73_PRODUCT_GID ||
        matches[0].variant_gid !== `gid://shopify/ProductVariant/${v.variantId}`) throw new Error("SYNC_FZT73_IDENTITY_CONFLICT");
  }
  const identityRows: { id: string; catalog_number: string | null; display_order: number }[] = [];
  for (let offset = 0; ; offset += 1000) {
    if (Date.now() >= deadline - 3000) throw new Error("SYNC_ONBOARDING_TIME_BUDGET");
    const result = await db.from("carousel_items").select("id,catalog_number,display_order").order("id").range(offset, offset + 999);
    if (result.error || !Array.isArray(result.data)) throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
    identityRows.push(...result.data);
    if (result.data.length < 1000) break;
    if (offset >= 9000) throw new Error("SYNC_ONBOARDING_CATALOG_LIMIT");
  }
  if (FZT73_VARIANTS.some(v => identityRows.some(row =>
    (row.id === v.itemId && row.catalog_number !== v.sku) || (key(row.catalog_number) === key(v.sku) && row.id !== v.itemId)))) {
    throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  }
  // Visibility is managed by the publication projection. Missing rows and
  // editorial hides are never created or switched back on by this worker.
  if (!published || !source || !items.data.length) return;
  if (items.data.some(row => typeof row.is_active !== "boolean")) throw new Error("SYNC_FZT73_INPUT_INVALID");
  const active = FZT73_VARIANTS.filter(v => items.data.some(row => row.id === v.itemId && row.is_active));
  const mappedContext=ownedSourceMediaContext(source);
  const mediaBySku = new Map(active.map(v => [v.sku, mappedContext ? source.media.filter(m=>(source as OwnedMappedSource).ownedMediaMap!.manifest.variants.find(r=>r.itemId===v.itemId)!.orderedMediaIds.includes(m.id)) : exactFzt73Media(source.media, v.sku)]));
  const projected: Record<string, unknown>[] = [];
  const projectedAngles: Record<string, unknown>[] = [];
  for (const v of active) {
    const projection = fzt73SourceProjection(source,v);
    const {angles:sourceAngles,...copyProjection}=projection;
    projected.push({id:v.itemId,...copyProjection});
    projectedAngles.push(...sourceAngles.map(a=>({item_id:v.itemId,...a})));
  }
  const changed = projected.some(p => !same(items.data.find(r => r.id === p.id),p)) ||
    projectedAngles.length !== angles.data.filter(a => active.some(v => v.itemId === a.item_id)).length ||
    projectedAngles.some(p => !angles.data.some(a => same(a,p)));
  if (changed) {
    const media = [...mediaBySku.values()].flat();
    for (let i=0;i<media.length;i+=3) await Promise.all(media.slice(i,i+3).map(m => verifyOnboardingImage(m,deadline)));
  }
  if (!sameFzt73Source(await readFzt73Snapshot(deadline,db), source)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
  const entries = active.map(v => {
    const old = items.data.find(r => r.id === v.itemId)!;
    return {itemId:v.itemId,catalogKey:v.sku,variantGid:`gid://shopify/ProductVariant/${v.variantId}`,
      expectedVersion:old.copy_updated_at,expectedRevision:old.editor_revision,projection:fzt73SourceProjection(source,v)};
  });
  if(entries.length && mappedContext) {
    await applyOwnedMediaSourceProjection(db,{productGid:FZT73_PRODUCT_GID,owner:leaseOwner,requestId:randomUUID(),expectedMapVersion:mappedContext.registry.mapVersion,
      source:mappedContext.graph,manifest:(source as OwnedMappedSource).ownedMediaMap!.manifest,entries},deadline);
  } else if (entries.length) {
    const { data, error } = await db.rpc("apply_fzt73_owned_batch", {
      p_product_gid:FZT73_PRODUCT_GID,p_owner:leaseOwner,p_entries:entries,
    });
    if (error) throw new Error(/^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_VARIANT_GALLERY_SAVE_FAILED");
    if (!Array.isArray(data?.items) || data.items.length !== entries.length ||
        entries.some(e => data.items.filter((r: {itemId:string;result:{status:string}}) => r.itemId === e.itemId &&
          ["baseline_recorded","updated","unchanged"].includes(r.result?.status)).length !== 1)) throw new Error("SYNC_VARIANT_GALLERY_SAVE_FAILED");
  }
  // A source edit during the atomic batch must not be acknowledged as a
  // completed reconciliation. The committed batch remains CAS protected.
  if (!sameFzt73Source(await readFzt73Snapshot(deadline,db), source)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
  const [readItems,readAngles] = await Promise.all([
    db.from("carousel_items").select("*").in("id",ids), db.from("carousel_item_angles").select("*").in("item_id",ids),
  ]);
  if (readItems.error || readAngles.error || projected.some(p=>!same(readItems.data?.find(r=>r.id===p.id),p)) ||
      readAngles.data?.filter(a => active.some(v => v.itemId === a.item_id)).length !== projectedAngles.length ||
      projectedAngles.some(p=>!readAngles.data?.some(a=>same(a,p)))) {
    throw new Error("SYNC_COPY_READBACK_MISMATCH");
  }
  // The source projection never proves that a Gallery edit reached Shopify.
}

