import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyAdminGraphql, visibleCopyFromProduct, type ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml } from "./description-document";
import { readGroupMediaSnapshot } from "./group-media-read";
import { type GroupMediaBinding, type GroupMediaSnapshot } from "./group-media-policy";
import { assertOwnedMediaManifest, ownedMediaBinding, ownedMediaProjection, ownedMediaHash, planOwnedMediaObservation, type OwnedMediaManifest } from "./owned-media-plan";
import { readOwnedMediaRegistry, type OwnedMediaProjectionEntry, type OwnedMediaRegistryCard, type OwnedMediaRegistryContext } from "./owned-media-registry";
import { FZT73_PRODUCT_GID, FZT73_VARIANTS, MD20_VARIANTS, exactVariantSeo } from "./variant-source-policy";
import { requireVariantMediaToken, type OwnedVariant } from "./owned-edit-plan";

export type OwnedMappedSource = ShopifyOnboardingSnapshot & { ownedMediaMap?:{version:number;manifest:OwnedMediaManifest;graphIdentity:string} };
const contexts=new WeakMap<object,{registry:OwnedMediaRegistryContext;graph:GroupMediaSnapshot}>();
export const ownedSourceMediaContext=(source:ShopifyOnboardingSnapshot)=>contexts.get(source);

/** Bounded raw copy read. No legacy ALT/filename media inference; no registry write. */
async function rawCopy(binding:GroupMediaBinding,deadline:number):Promise<ShopifyOnboardingSnapshot>{
  type Product=Omit<ShopifyOnboardingSnapshot,"variants"|"media"|"seoTitle"|"seoDescription">&{
    seo:{title:string|null;description:string|null};variants:{nodes:(ShopifyOnboardingSnapshot["variants"][number]&{selectedOptions:{name:string;value:string}[]})[];pageInfo:{hasNextPage:boolean}};
    media:{nodes:ShopifyOnboardingSnapshot["media"];pageInfo:{hasNextPage:boolean}}};
  const result=await shopifyAdminGraphql<{product:Product|null}>(`query TopTikOwnedMediaCopy($id:ID!,$publicationId:ID!){product(id:$id){
    id handle title descriptionHtml status updatedAt vendor productType seo{title description} publishedOnPublication(publicationId:$publicationId)
    variants(first:5){nodes{id sku selectedOptions{name value}} pageInfo{hasNextPage}}
    media(first:250,sortKey:POSITION){nodes{id alt status mediaContentType ... on MediaImage{image{url altText width height}}} pageInfo{hasNextPage}}
  }}`,{id:binding.productGid,publicationId:"gid://shopify/Publication/79538258170"},6000,deadline);
  const p=result.product,rows=binding.productGid===FZT73_PRODUCT_GID?FZT73_VARIANTS:MD20_VARIANTS;
  if(!p||p.id!==binding.productGid||p.handle!==binding.handle||p.status!=="ACTIVE"||!p.publishedOnPublication||
    p.variants.pageInfo.hasNextPage||p.media.pageInfo.hasNextPage||p.title.length>120||p.descriptionHtml.length>250000||
    p.variants.nodes.length!==rows.length||rows.some(v=>!p.variants.nodes.some(n=>n.id===`gid://shopify/ProductVariant/${v.variantId}`&&n.sku===v.sku&&
      n.selectedOptions.some(option=>option.name==="צבע"&&option.value===v.color))))throw new Error("OWNED_MEDIA_COPY_IDENTITY_INVALID");
  assertSafeDescriptionHtml(p.descriptionHtml);
  return {...p,variants:p.variants.nodes,media:p.media.nodes,seoTitle:p.seo?.title??null,seoDescription:p.seo?.description??null};
}
function assertCopyGraph(copy:ShopifyOnboardingSnapshot,graph:GroupMediaSnapshot){
  if(copy.id!==graph.binding.productGid||copy.handle!==graph.binding.handle||copy.status!==graph.product.status||
    copy.publishedOnPublication!==graph.product.publishedOnPublication||copy.media.length!==graph.media.length||
    copy.media.some((m,i)=>m.id!==graph.media[i].mediaId||m.alt!==graph.media[i].alt||m.image?.url!==graph.media[i].image?.url||m.status!==graph.media[i].status))
    throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
}
/** Used only with a private registered map. Unknown native media deliberately stops the source worker. */
export async function readOwnedMappedSource(db:Pick<SupabaseClient,"rpc">,productGid:string,deadline:number):Promise<OwnedMappedSource|null>{
  const registry=await readOwnedMediaRegistry(db,productGid,deadline);
  if(!registry.registered)return null;
  if(registry.operation){
    if(registry.operation.status==="review")throw new Error("OWNED_MEDIA_OPERATION_REVIEW_REQUIRED");
    throw new Error("SYNC_RECONCILIATION_BUSY");
  }
  if(!registry.snapshot||!registry.manifest)throw new Error("OWNED_MEDIA_REGISTRY_INVALID");
  const graph=await readGroupMediaSnapshot(registry.binding,deadline);
  if(graph.product.status!=="ACTIVE"||!graph.product.publishedOnPublication)return null;
  const observation=planOwnedMediaObservation(registry.snapshot,registry.manifest,graph);
  if(observation.unassigned.length)throw new Error("OWNED_MEDIA_UNASSIGNED_REVIEW_REQUIRED");
  const copy=await rawCopy(registry.binding,deadline);assertCopyGraph(copy,graph);
  // ALT is already compared in copy.media. Keep the complete native association graph in source
  // equality without making our own ALT write look like unrelated identity drift.
  const graphIdentity=ownedMediaHash({binding:graph.binding,product:{...graph.product,updatedAt:""},variants:graph.variants,
    media:graph.media.map(m=>({mediaId:m.mediaId,mediaContentType:m.mediaContentType,status:m.status,fileStatus:m.fileStatus,image:m.image}))});
  const source:OwnedMappedSource={...copy,ownedMediaMap:{version:registry.mapVersion,manifest:observation.candidateManifest,graphIdentity}};
  contexts.set(source,{registry,graph});return source;
}
export function ownedMappedMediaProjection(source:ShopifyOnboardingSnapshot,itemId:string){
  const map=(source as OwnedMappedSource).ownedMediaMap;if(!map)return null;
  const row=map.manifest.variants.find(v=>v.itemId===itemId);if(!row)throw new Error("OWNED_MEDIA_ITEM_UNKNOWN");
  const media=(id:string)=>{const m=source.media.find(m=>m.id===id);if(!m?.image||m.status!=="READY")throw new Error("OWNED_MEDIA_SOURCE_NOT_READY");return m;};
  return {cover_image_path:media(row.coverMediaId).image!.url,cover_image_alt:media(row.coverMediaId).alt?.trim()||null,
    angles:row.orderedMediaIds.map((id,i)=>({angle_key:String(i+1),angle_order:i+1,image_path:media(id).image!.url,image_alt:media(id).alt?.trim()||null}))};
}
/** Mapped media has stable IDs, so ALT does not encode color identity. Legacy readers retain their token gate. */
export function assertOwnedMappedAlt(source:ShopifyOnboardingSnapshot,variant:OwnedVariant,currentAlt:string|null,desiredAlt:string){
  if(!(source as OwnedMappedSource).ownedMediaMap)return requireVariantMediaToken(variant,currentAlt,desiredAlt);
  const binding=ownedMediaBinding(source.id),map=(source as OwnedMappedSource).ownedMediaMap!;
  if(!binding||!binding.variants.some(v=>v.sku===variant.sku)||!map.manifest.variants.some(v=>v.sku===variant.sku))throw new Error("OWNED_MEDIA_IDENTITY_INVALID");
  if(typeof desiredAlt!=="string"||desiredAlt.length>512||/[\u0000-\u001f\u007f]/.test(desiredAlt))throw new Error("OWNED_MEDIA_ALT_INVALID");
}
/** Explicit desired map override for the native-write/readback -> atomic registry commit boundary. */
export async function readOwnedMediaProjectionEntries(_db:Pick<SupabaseClient,"rpc">,binding:GroupMediaBinding,graph:GroupMediaSnapshot,
  manifest:OwnedMediaManifest,cards:OwnedMediaRegistryCard[],deadline:number):Promise<OwnedMediaProjectionEntry[]>{
  assertOwnedMediaManifest(binding,graph,manifest);
  const copy=await rawCopy(binding,deadline);assertCopyGraph(copy,graph);
  const visible=visibleCopyFromProduct(copy),rows=binding.productGid===FZT73_PRODUCT_GID?FZT73_VARIANTS:MD20_VARIANTS;
  if(cards.length!==binding.variants.length||new Set(cards.map(c=>c.itemId)).size!==cards.length)throw new Error("OWNED_MEDIA_CARDS_INVALID");
  return cards.filter(c=>c.isActive).map(card=>{
    const v=rows.find(v=>v.itemId===card.itemId);if(!v||v.sku!==card.catalogKey||typeof card.expectedVersion!=="string"||!Number.isSafeInteger(card.expectedRevision))throw new Error("OWNED_MEDIA_CARDS_INVALID");
    const seo=exactVariantSeo(visible,v.sku);
    return {itemId:card.itemId,catalogKey:v.sku,variantGid:`gid://shopify/ProductVariant/${v.variantId}`,expectedVersion:card.expectedVersion,expectedRevision:card.expectedRevision,
      projection:{title:visible.title+(binding.productGid===FZT73_PRODUCT_GID?` בצבע ${v.color}`:""),description:visible.description||null,description_html:visible.descriptionHtml??null,
        seo_title:seo.seoTitle,seo_description:seo.seoDescription,...ownedMediaProjection(graph,manifest,card.itemId)}};
  });
}
