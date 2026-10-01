import { resolveImageLimits } from './existing-media-limits.mjs';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
export const src=n=>readFileSync(new URL(`../../src/lib/shopify/${n}.ts`,import.meta.url),'utf8');
export const mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(resolveImageLimits(s))).toString('base64');
export const stripped=n=>stripTypeScriptTypes(resolveImageLimits(src(n))).replace(/^import[\s\S]*?;\r?\n/gm,'');
export const coreUrl=mod(src('media-sync-core'));
export const readyUrl=mod(src('media-read-adapter').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`));
export const galleryUrl=mod(src('media-gallery-transport').replace('import "server-only";','').replace('import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";','const createSupabaseServiceRoleClient=()=>{throw Error("SECRET_FACTORY");};').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`));
export const core=await import(coreUrl),ready=await import(readyUrl),gallery=await import(galleryUrl);
export const id={productId:'gid://shopify/Product/123',variantId:'gid://shopify/ProductVariant/456',itemId:'a0000000-0000-4000-8000-000000000001',exactGallerySku:'ABC-01-TU',exactShopifySku:'ABC01',productHandle:'abc'};
export const owner='a0000000-0000-4000-8000-000000000002',angle='a0000000-0000-4000-8000-000000000003',opId='a0000000-0000-4000-8000-000000000004';
export const stamp='2026-10-01T06:00:00Z',now=Date.parse(stamp),hash='a'.repeat(64),url='https://cdn.shopify.com/s/files/1/image.png';
export function fixture(){
 const conn=nodes=>({nodes,pageInfo:{hasNextPage:false}});
 const raw={identity:id,version:1,revision:'b'.repeat(64),item:{id:id.itemId,catalog_number:id.exactGallerySku,title:'bag',cover_image_path:url,cover_image_alt:null,is_active:true},angles:[{id:angle,item_id:id.itemId,angle_key:'front',image_path:url,angle_order:1,image_alt:null}]};
 const refs=[{role:'cover',angleId:null,key:'existing',evidenceId:'g-existing'},{role:'angle',angleId:angle,key:'existing',evidenceId:'g-existing'}];
 const image={id:'gid://shopify/MediaImage/1',mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',alt:'bag',updatedAt:stamp,image:{id:'gid://shopify/ImageSource/1',url,width:40,height:60}};
 const product={id:id.productId,handle:id.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt:stamp,mediaCount:{count:1,precision:'EXACT'},media:conn([image]),variants:conn([{id:id.variantId,sku:id.exactShopifySku,image:null,media:conn([])}])};
 const read=ready.parseMediaReadResponse({data:{product}},id);
 const proof=(side,evidence)=>({product_gid:id.productId,side,asset_key:'existing',evidence_id:evidence,content_id:hash,proof:{platformRef:side==='gallery'?`angle:${angle}`:image.id,url,decodedSha256:hash,width:40,height:60,mime:'image/png',byteLength:100,verifiedAt:stamp,ownership:'reference_only'}});
 const provenance=[proof('gallery','g-existing'),proof('shopify','s-existing')];
 const g=gallery.galleryRawToSnapshot(raw,refs,provenance.filter(p=>p.side==='gallery').map(p=>({side:p.side,key:p.asset_key,evidenceId:p.evidence_id,contentId:p.content_id,proof:p.proof})));
 const s=ready.mediaReadToSnapshot(read,i=>({identity:id,side:'shopify',mediaId:i.mediaId,imageId:i.imageId,url:i.url,width:i.width,height:i.height,platformUpdatedAt:i.updatedAt,decodedSha256:hash,byteLength:100,mime:'image/png',key:'existing',contentId:hash,evidenceId:'s-existing'}));
 const context={identity:id,stateVersion:1,baselines:{gallery:g,shopify:s},removals:[],detached:[],operations:[],steps:[],galleryRaw:raw,galleryRefs:refs,provenance};
 return structuredClone({context,read,product,raw,refs,pair:context.baselines,bytes:{bytes:new Uint8Array(100),sha256:hash,width:40,height:60,mime:'image/png',byteLength:100}});
}
