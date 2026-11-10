import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const strip=p=>stripTypeScriptTypes(readFileSync(p,'utf8'));
const wrap=async(p,names,exports)=>{const s=strip(p).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');return(await import(url(`export const make=deps=>{const {${names.join(',')}}=deps;${s};return{${exports.join(',')}}}`))).make;};
export const loadOwnedModule=wrap;
export const policy=await import(url(strip('src/lib/shopify/variant-source-policy.ts')));
export const group=(await wrap('src/lib/shopify/group-media-policy.ts',['createHash','parseTransportMedia','MEDIA_API_VERSION','MEDIA_PUBLICATION_ID'],
 ['assertGroupMediaBinding','assertGroupMediaReady','groupMediaFingerprint']))({createHash,parseTransportMedia:m=>m,MEDIA_API_VERSION:'2026-07',MEDIA_PUBLICATION_ID:'gid://shopify/Publication/79538258170'});
export const plan=(await wrap('src/lib/shopify/owned-media-plan.ts',['createHash',...Object.keys(group),...Object.keys(policy)],
 ['ownedMediaHash','stableOwnedMedia','ownedMediaBinding','assertOwnedMediaSource','assertOwnedMediaManifest','ownedMediaProjection','planOwnedMediaObservation','planOwnedMediaChange','resolveOwnedMediaPlan']))({createHash,...group,...policy});
export const owner='11111111-1111-4111-8111-111111111111';
export const requestId='22222222-2222-4222-8222-222222222222';
export const refresh=source=>({...source,fingerprint:group.groupMediaFingerprint(source)});
export function fixture(productGid=policy.FZT73_PRODUCT_GID){
 const binding=plan.ownedMediaBinding(productGid),fzt=productGid===policy.FZT73_PRODUCT_GID;
 const sql=readFileSync(`supabase/migrations/${fzt?'20261109130444_fzt73_owned_projection.sql':'20261109150500_md20_owned_projection.sql'}`,'utf8');
 let seq=fzt?10000:20000;
 const media=[],variants=[],mapped=[];
 for(const bound of binding.variants){
  const block=sql.match(new RegExp("when '"+bound.sku+"' then array\\[([\\s\\S]*?)\\]"))[1];
  const urls=[...block.matchAll(/'(https:[^']+)'/g)].map(m=>m[1]);
  const photos=urls.map(url=>({mediaId:`gid://shopify/MediaImage/${++seq}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',updatedAt:'2026-11-09T20:00:00Z',alt:'צילום '+bound.sku,
    image:{id:`gid://shopify/ImageSource/${seq}`,url,width:1200,height:1200}}));
  media.push(...photos);const ids=photos.map(m=>m.mediaId);
  variants.push({variantGid:bound.variantGid,sku:bound.sku,image:{id:photos[0].image.id,url:photos[0].image.url},mediaIds:[...ids]});
  mapped.push({...bound,orderedMediaIds:[...ids],coverMediaId:ids[0]});
 }
 const source=refresh({schemaVersion:1,binding,product:{productGid,handle:binding.handle,status:'ACTIVE',publishedOnPublication:true,updatedAt:'2026-11-09T20:00:00Z'},media,variants});
 const manifest={schemaVersion:1,productGid,handle:binding.handle,globalOrder:media.map(m=>m.mediaId),variants:mapped,ignoredMediaIds:[]};
 const command={requestId,itemId:binding.variants[0].itemId,expectedMapVersion:1,expectedSourceFingerprint:source.fingerprint,
  desiredImages:mapped[0].orderedMediaIds.map(id=>({mediaId:id,alt:media.find(m=>m.mediaId===id).alt}))};
 return{binding,source,manifest,command};
}
export const clone=v=>structuredClone(v);
