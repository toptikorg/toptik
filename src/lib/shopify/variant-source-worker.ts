import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, shopifyAdminGraphql, visibleCopyFromProduct, type ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml } from "./description-document";
import { verifyOnboardingImage } from "./onboarding-worker";
import { MD20_PRODUCT_GID, MD20_PRODUCT_HANDLE, MD20_VARIANTS, MD20_LEGACY_UNASSIGNED_MEDIA, exactVariantMedia, exactVariantSeo } from "./variant-source-policy";

export async function readMd20Snapshot(deadline: number): Promise<ShopifyOnboardingSnapshot | null> {
  const publicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim();
  if (publicationId !== "gid://shopify/Publication/79538258170") throw new Error("SYNC_ONBOARDING_PUBLICATION_MISMATCH");
  type Product = Omit<ShopifyOnboardingSnapshot, "variants" | "media" | "seoTitle" | "seoDescription"> & {
    variants: { nodes: (ShopifyOnboardingSnapshot["variants"][number] & { selectedOptions: { name: string; value: string }[] })[]; pageInfo: { hasNextPage: boolean } };
    media: { nodes: ShopifyOnboardingSnapshot["media"]; pageInfo: { hasNextPage: boolean } };
    seo: { title: string | null; description: string | null };
  };
  const result = await shopifyAdminGraphql<{ product: Product | null }>(`query GalleryMd20Source($id: ID!, $publicationId: ID!) {
    product(id: $id) { id handle title descriptionHtml status updatedAt vendor productType seo { title description }
      publishedOnPublication(publicationId: $publicationId)
      variants(first: 4) { nodes { id sku selectedOptions { name value } } pageInfo { hasNextPage } }
      media(first: 61) { nodes { id alt status mediaContentType ... on MediaImage { image { url altText width height } } } pageInfo { hasNextPage } }
    }
  }`, { id: MD20_PRODUCT_GID, publicationId }, 6000, deadline);
  const p = result.product;
  if (p === null) return null; // Only a successful authenticated null read means removed.
  if (!p || p.id !== MD20_PRODUCT_GID || p.handle !== MD20_PRODUCT_HANDLE ||
      !["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].includes(p.status) || typeof p.publishedOnPublication !== "boolean" ||
      p.variants.pageInfo.hasNextPage || p.variants.nodes.length !== 3 ||
      MD20_VARIANTS.some(v => !p.variants.nodes.some(row => row.id === `gid://shopify/ProductVariant/${v.variantId}` && row.sku === v.sku &&
        row.selectedOptions.some(option => option.name === "צבע" && option.value === v.color)))) {
    throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  }
  if (p.media.pageInfo.hasNextPage || p.media.nodes.length > 60) throw new Error("SYNC_ONBOARDING_MEDIA_LIMIT");
  if (new Set(p.media.nodes.map(m => m.id)).size !== p.media.nodes.length) {
    throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  }
  if (p.title.length > 120 || p.descriptionHtml.length > 250000) throw new Error("SYNC_ONBOARDING_COPY_LIMIT");
  assertSafeDescriptionHtml(p.descriptionHtml);
  if (p.status === "ACTIVE" && p.publishedOnPublication) {
    // Reject unknown or ambiguous media in both the normal and adoption paths.
    const assignments = new Map(MD20_VARIANTS.map(v => [v.sku, exactVariantMedia(p.media.nodes, v.sku)]));
    if (p.media.nodes.some(m => {
      const count = MD20_VARIANTS.filter(v => assignments.get(v.sku)!.some(a => a.id === m.id)).length;
      return count > 1 || (count === 0 && !MD20_LEGACY_UNASSIGNED_MEDIA.has(m.id));
    })) throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  }
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
export const sameMd20Source = (left: ShopifyOnboardingSnapshot | null, right: ShopifyOnboardingSnapshot | null) => {
  if (!left || !right) return left === right;
  // A timestamp-only change is not a content or identity change. All actual
  // source fields, publication and color/media identity remain compared.
  const a: Partial<ShopifyOnboardingSnapshot> = { ...left };
  const b: Partial<ShopifyOnboardingSnapshot> = { ...right };
  delete a.updatedAt; delete b.updatedAt;
  return canonical(a) === canonical(b);
};
export function md20SourceProjection(source: ShopifyOnboardingSnapshot, v: typeof MD20_VARIANTS[number]) {
  const media = exactVariantMedia(source.media, v.sku);
  const copy = visibleCopyFromProduct(source);
  const seo = exactVariantSeo(copy,v.sku);
  return {title:copy.title,description:copy.description || null,description_html:copy.descriptionHtml ?? null,
    seo_title:seo.seoTitle,seo_description:seo.seoDescription,cover_image_path:media[0].image!.url,cover_image_alt:media[0].alt,
    angles:media.map((m,i)=>({angle_key:String(i+1),angle_order:i+1,image_path:m.image!.url,image_alt:m.alt}))};
}

/** The normal webhook/recovery worker holds the product lease. Source-owned,
 * reviewed three-color intake only; no Shopify writes, binding changes or approvals. */
export async function reconcileApprovedVariants(db: SupabaseClient, deadline: number, leaseOwner: string): Promise<void> {
  if (configuredShopifyDomain() !== "toptikcoil.myshopify.com") throw new Error("SYNC_ONBOARDING_SHOP_MISMATCH");
  const source = await readMd20Snapshot(deadline);
  const published = !!source && source.status === "ACTIVE" && source.publishedOnPublication;
  const ids = MD20_VARIANTS.map(v => v.itemId);
  const [items, angles, bindings] = await Promise.all([
    db.from("carousel_items").select("*").in("id", ids),
    db.from("carousel_item_angles").select("*").in("item_id", ids),
    db.from("shopify_gallery_bindings").select("catalog_key,carousel_item_id,product_gid,variant_gid").in("carousel_item_id", ids),
  ]);
  if (items.error || angles.error || bindings.error || !items.data || !angles.data || !bindings.data) throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
  for (const v of MD20_VARIANTS.filter(v => items.data.some(row => row.id === v.itemId))) {
    const matches = bindings.data.filter(b => b.carousel_item_id === v.itemId);
    if (matches.length !== 1 || matches[0].catalog_key !== v.sku || matches[0].product_gid !== MD20_PRODUCT_GID ||
        matches[0].variant_gid !== `gid://shopify/ProductVariant/${v.variantId}`) throw new Error("SYNC_MD20_IDENTITY_CONFLICT");
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
  if (MD20_VARIANTS.some(v => identityRows.some(row =>
    (row.id === v.itemId && row.catalog_number !== v.sku) || (key(row.catalog_number) === key(v.sku) && row.id !== v.itemId)))) {
    throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  }
  // Visibility is managed by the publication projection. Missing rows and
  // editorial hides are never created or switched back on by this worker.
  if (!published || !source || !items.data.length) return;
  if (items.data.some(row => typeof row.is_active !== "boolean")) throw new Error("SYNC_MD20_INPUT_INVALID");
  const active = MD20_VARIANTS.filter(v => items.data.some(row => row.id === v.itemId && row.is_active));
  const mediaBySku = new Map(active.map(v => [v.sku, exactVariantMedia(source.media, v.sku)]));
  const projected: Record<string, unknown>[] = [];
  const projectedAngles: Record<string, unknown>[] = [];
  for (const v of active) {
    const projection = md20SourceProjection(source,v);
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
  if (!sameMd20Source(await readMd20Snapshot(deadline), source)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
  const entries = active.map(v => {
    const old = items.data.find(r => r.id === v.itemId)!;
    const projection = projected.find(p => p.id === v.itemId)!;
    const copyProjection = { ...projection };
    delete copyProjection.id;
    const itemAngles = projectedAngles.filter(a => a.item_id === v.itemId).map(a => ({
      angle_key:a.angle_key,angle_order:a.angle_order,image_path:a.image_path,image_alt:a.image_alt,
    }));
    return {itemId:v.itemId,catalogKey:v.sku,variantGid:`gid://shopify/ProductVariant/${v.variantId}`,
      expectedVersion:old.copy_updated_at,expectedRevision:old.editor_revision,projection:{...copyProjection,angles:itemAngles}};
  });
  if (entries.length) {
    const { data, error } = await db.rpc("apply_md20_owned_batch", {
      p_product_gid:MD20_PRODUCT_GID,p_owner:leaseOwner,p_entries:entries,
    });
    if (error) throw new Error(/^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_VARIANT_GALLERY_SAVE_FAILED");
    if (!Array.isArray(data?.items) || data.items.length !== entries.length ||
        entries.some(e => data.items.filter((r: {itemId:string;result:{status:string}}) => r.itemId === e.itemId &&
          ["baseline_recorded","updated","unchanged"].includes(r.result?.status)).length !== 1)) throw new Error("SYNC_VARIANT_GALLERY_SAVE_FAILED");
  }
  // A source edit during the atomic batch must not be acknowledged as a
  // completed reconciliation. The committed batch remains CAS protected.
  if (!sameMd20Source(await readMd20Snapshot(deadline), source)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
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
