import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
export async function load(path, names, exports) {
  const code=stripTypeScriptTypes(readFileSync(path,'utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export\s*\{[^}]+\}\s*from[^;]+;\r?\n/gm,'').replace(/^export /gm,'');
  const m=await import('data:text/javascript;base64,'+Buffer.from(`export function make(d){const{${names.join(',')}}=d;${code};return{${exports.join(',')}}}`).toString('base64'));
  return m.make;
}
const core=(await load('src/lib/shopify/media-sync-core.ts',['createHash'],['mediaSnapshotFingerprint']))({createHash});
export const legacy=(await load('src/lib/shopify/media-transport-read.ts',['createHash','mediaSnapshotFingerprint','MAX_EXISTING_MEDIA_PIXELS'],['parseTransportMedia']))({...core,createHash,MAX_EXISTING_MEDIA_PIXELS:25_000_000});
export const policy=(await load('src/lib/shopify/group-media-policy.ts',['createHash','parseTransportMedia','MEDIA_API_VERSION','MEDIA_PUBLICATION_ID'],
 ['assertGroupMediaBinding','groupMediaFingerprint','buildGroupMediaReadRequest','buildGroupMediaPageRequest','GROUP_VARIANT_MEDIA_PAGE_QUERY','parseGroupMediaResponse','assertGroupMediaReady']))({...legacy,createHash,MEDIA_API_VERSION:'2026-07',MEDIA_PUBLICATION_ID:'gid://shopify/Publication/79538258170'});
export const transport=(await load('src/lib/shopify/group-media-transport.ts',['createHash','MAX_EXISTING_MEDIA_PIXELS','parseTransportMedia','assertGroupMediaBinding','assertGroupMediaReady','groupMediaFingerprint'],
 ['groupOwnedFilename','buildGroupMediaPhase','verifyGroupMediaPhase']))({...legacy,...policy,createHash,MAX_EXISTING_MEDIA_PIXELS:25_000_000});
export const phases=(await load('src/lib/shopify/owned-media-phases.ts',['buildGroupMediaPhase'],
 ['buildOwnedMediaPhaseSpecs','ownedMediaCreatedIds','resolveOwnedMediaPhase']))(transport);
export const operation=(await load('src/lib/shopify/group-media-operation.ts',['randomUUID','readGroupMediaSnapshot','sendGroupMediaMutation','observeGroupOwnedFile','readGroupMediaJob','buildGroupMediaPhase','verifyGroupMediaPhase','ownedMediaCreatedIds','resolveOwnedMediaPhase'],
 ['runGroupMediaPhase','runOwnedMediaOperationPhases']))({...transport,...phases,randomUUID});
export const product='gid://shopify/Product/123';
export const operationId='a0000000-0000-4000-8000-000000000009',owner='a0000000-0000-4000-8000-000000000008';
export const binding={productGid:product,handle:'fixture-group',variants:[
 {itemId:'a0000000-0000-4000-8000-000000000001',variantGid:'gid://shopify/ProductVariant/11',sku:'SKU-A'},
 {itemId:'a0000000-0000-4000-8000-000000000002',variantGid:'gid://shopify/ProductVariant/12',sku:'SKU-B'}]};
export const conn=nodes=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
export const image=n=>({id:`gid://shopify/MediaImage/${n}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',alt:`photo ${n}`,updatedAt:'2026-11-09T10:00:00Z',
 image:{id:`gid://shopify/ImageSource/${n}`,url:`https://cdn.shopify.com/s/files/1/group-${n}.jpg`,width:1000,height:1000}});
export function raw(){return{data:{product:{id:product,handle:binding.handle,status:'ACTIVE',publishedOnPublication:true,updatedAt:'2026-11-09T10:00:00Z',
 mediaCount:{count:4,precision:'EXACT'},media:conn([1,2,3,4].map(image)),variants:conn([
 {id:binding.variants[0].variantGid,sku:'SKU-A',image:{id:'gid://shopify/ProductImage/101',url:image(1).image.url},media:conn([1,2].map(n=>({id:image(n).id})))},
 {id:binding.variants[1].variantGid,sku:'SKU-B',image:{id:'gid://shopify/ProductImage/103',url:image(3).image.url},media:conn([{id:image(3).id}])},
 {id:'gid://shopify/ProductVariant/13',sku:'UNBOUND-PROTECTED',image:{id:'gid://shopify/ProductImage/104',url:image(4).image.url},media:conn([{id:image(4).id}])}])}}};}
export const snapshot=()=>policy.parseGroupMediaResponse(raw(),binding);
export function restamp(graph){graph.fingerprint=policy.groupMediaFingerprint(graph);return graph;}
export const staged={itemId:binding.variants[0].itemId,receiptId:'a0000000-0000-4000-8000-000000000007',sha256:'a'.repeat(64),mime:'image/jpeg',byteLength:1000,width:1000,height:1000,
 url:`https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/sync-owned/${binding.variants[0].itemId}/${'a'.repeat(64)}.jpg`};
export function receipt(index=0){const filename=transport.groupOwnedFilename(operationId,index,staged.sha256,staged.mime),media=legacy.parseTransportMedia(image(90+index));media.image.url=`https://cdn.shopify.com/s/files/1/${filename}`;
 return{productGid:product,itemId:binding.variants[0].itemId,operationId,createPhaseIndex:index,filename,sourceSha256:staged.sha256,mime:staged.mime,receiptId:staged.receiptId,media,decodedSha256:'b'.repeat(64),decodedByteLength:1000};}
