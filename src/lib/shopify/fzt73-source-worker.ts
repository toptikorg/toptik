import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, shopifyAdminGraphql, visibleCopyFromProduct, type ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml } from "./description-document";
import { verifyOnboardingImage } from "./onboarding-worker";
import { FZT73_PRODUCT_GID, FZT73_PRODUCT_HANDLE, FZT73_VARIANTS, exactFzt73Media, exactVariantSeo } from "./variant-source-policy";

async function snapshot(deadline: number): Promise<ShopifyOnboardingSnapshot | null> {
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
      !["ACTIVE", "DRAFT", "ARCHIVED"].includes(p.status) || typeof p.publishedOnPublication !== "boolean" ||
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

/** The normal webhook/recovery worker holds the product lease. Source-owned,
 * reviewed four-color intake only; no Shopify writes, binding changes or approvals. */
export async function reconcileFzt73Variants(db: SupabaseClient, deadline: number): Promise<void> {
  if (configuredShopifyDomain() !== "toptikcoil.myshopify.com") throw new Error("SYNC_ONBOARDING_SHOP_MISMATCH");
  const source = await snapshot(deadline);
  const published = !!source && source.status === "ACTIVE" && source.publishedOnPublication;
  const ids = FZT73_VARIANTS.map(v => v.itemId);
  const [items, angles, settings] = await Promise.all([
    db.from("carousel_items").select("*").in("id", ids),
    db.from("carousel_item_angles").select("*").in("item_id", ids),
    db.from("carousel_settings").select("autoplay_ms,transition_mode,editor_revision").eq("id", 1).single(),
  ]);
  if (items.error || angles.error || settings.error || !settings.data || !items.data || !angles.data) throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
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
  if (!published && !items.data.length) return; // Never create a hidden product with no image.
  if (published && items.data.length < 4 && process.env.SHOPIFY_SYNC_AUTOCREATE !== "published_shopify") throw new Error("SYNC_ONBOARDING_NOT_ENABLED");
  const maxOrder = Math.max(0, ...identityRows.map(r => r.display_order));
  const mediaBySku = new Map(FZT73_VARIANTS.map(v => [v.sku, published ? exactFzt73Media(source!.media, v.sku) : []]));
  const copy = source ? visibleCopyFromProduct(source) : null;
  const projected: Record<string, unknown>[] = [];
  const projectedAngles: Record<string, unknown>[] = [];
  for (const [index,v] of FZT73_VARIANTS.entries()) {
    const old = items.data.find(r => r.id === v.itemId);
    if (!published && !old) continue;
    if (!published) {
      projected.push({id:v.itemId,is_active:false});
      projectedAngles.push(...angles.data.filter(a => a.item_id === v.itemId).map(a => ({
        id:a.id,item_id:a.item_id,angle_key:a.angle_key,angle_order:a.angle_order,image_path:a.image_path,image_alt:a.image_alt,
      })));
      continue;
    }
    const media = mediaBySku.get(v.sku)!;
    const seo = exactVariantSeo(copy!,v.sku);
    projected.push({
      id:v.itemId,title:copy!.title + ` בצבע ${v.color}`,description:copy!.description,description_html:copy!.descriptionHtml,
      seo_title:seo.seoTitle,seo_description:seo.seoDescription,is_active:true,
      cover_image_path:media[0].image!.url,cover_image_alt:media[0].alt,
      ...(!old ? {catalog_number:v.sku,display_order:maxOrder + index + 1,color:v.color,
        tech_specs:{category:"fashion-bags",colors:[],specs:[{heading:"פרטי מוצר",items:[{label:"מותג",value:"Mandarina Duck"}]}]},
      } : {}),
    });
    projectedAngles.push(...media.map((m,i) => ({
      id:angles.data.find(a => a.item_id === v.itemId && a.image_path === m.image!.url)?.id ?? randomUUID(),
      item_id:v.itemId,angle_key:String(i+1),angle_order:i+1,image_path:m.image!.url,image_alt:m.alt,
    })));
  }
  const changed = projected.some(p => !same(items.data.find(r => r.id === p.id),p)) ||
    projectedAngles.length !== angles.data.length || projectedAngles.some(p => !same(angles.data.find(r => r.id === p.id),p));
  if (changed && published) {
    const media = [...mediaBySku.values()].flat();
    for (let i=0;i<media.length;i+=3) await Promise.all(media.slice(i,i+3).map(m => verifyOnboardingImage(m,deadline)));
  }
  if (JSON.stringify(await snapshot(deadline)) !== JSON.stringify(source)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
  if (changed) {
    const result = await db.rpc("save_gallery_catalog_atomic",{
      p_items:projected,p_angles:projectedAngles,
      p_expected_versions:Object.fromEntries(projected.map(p=>[p.id,items.data.find(r=>r.id===p.id)?.copy_updated_at ?? null])),
      p_expected_editor_revisions:Object.fromEntries(projected.map(p=>[p.id,items.data.find(r=>r.id===p.id)?.editor_revision ?? null])),
      p_settings:{autoplay_ms:settings.data.autoplay_ms,transition_mode:settings.data.transition_mode},
      p_expected_settings_revision:settings.data.editor_revision,
    });
    if (result.error) throw new Error("SYNC_VARIANT_GALLERY_SAVE_FAILED");
  }
  const [readItems,readAngles] = await Promise.all([
    db.from("carousel_items").select("*").in("id",ids), db.from("carousel_item_angles").select("*").in("item_id",ids),
  ]);
  if (readItems.error || readAngles.error || projected.some(p=>!same(readItems.data?.find(r=>r.id===p.id),p)) ||
      readAngles.data?.length !== projectedAngles.length || projectedAngles.some(p=>!same(readAngles.data?.find(r=>r.id===p.id),p))) {
    throw new Error("SYNC_COPY_READBACK_MISMATCH");
  }
  const settled = await db.from("shopify_gallery_content_outbox").update({status:"synced",synced_at:new Date().toISOString(),last_error:null})
    .in("carousel_item_id",ids).in("catalog_key",FZT73_VARIANTS.map(v=>v.sku)).in("status",["pending","processing","review","failed"]);
  if (settled.error) throw new Error("SYNC_OUTBOX_FINALIZE_FAILED");
}

