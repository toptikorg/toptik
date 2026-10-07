import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
const manifest = JSON.parse(read('src/lib/shopify/reviewed-media-manifest.json'));
const src = read('src/lib/shopify/reviewed-media-guard.ts').replace(/^import[^\n]*;\r?\n/gm,'');
const api = await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes('const manifest='+JSON.stringify(manifest)+';'+src)).toString('base64'));
const r=manifest.items.find(x=>x.sku==='P10FZT1127O');
const id={itemId:r.galleryId,productId:r.productId,variantId:r.variantId,exactGallerySku:r.sku,exactShopifySku:r.shopifySku,productHandle:'exact'};
const item=()=>({id:r.galleryId,catalogNumber:r.sku,shopifyLink:{variantId:r.variantId.split('/').at(-1)},coverImagePath:'https://cdn.shopify.com/legacy.jpg',angles:[],colors:null});
const payload=i=>({items:[i],settings:{}});
test('each reviewed tuple is exact and independent of filenames and alt',()=>{
 assert.equal(manifest.items.length,495);assert.equal(new Set(manifest.items.map(r=>r.sku+'\n'+r.imageUrl)).size,495);
 assert.ok(api.isReviewedMedia(id,r.imageUrl,r.decodedSha256));
 for(const identity of [{...id,exactGallerySku:'P10FZT11001'},{...id,exactShopifySku:'P10FZT11001'},{...id,variantId:'gid://shopify/ProductVariant/999'},{...id,productId:'gid://shopify/Product/999'},{...id,itemId:'other'}])
  assert.throws(()=>api.requireReviewedMedia(identity,r.imageUrl),/MEDIA_REVIEW_REQUIRED/);
 assert.throws(()=>api.requireReviewedMedia(id,r.imageUrl+'&filename=yellow'),/MEDIA_REVIEW_REQUIRED/);
});
test('unchanged legacy, metadata and removal preserve data; unreviewed new or replaced images hold',()=>{
 const before=item(),next=structuredClone(before);next.title='copy changed';next.seoTitle='SEO';
 api.assertReviewedCatalogMedia(payload(next),payload(before));
 next.angles.push({id:'new',imagePath:r.imageUrl});api.assertReviewedCatalogMedia(payload(next),payload(before));
 next.angles[0].imagePath='https://cdn.shopify.com/P10FZT1127O-yellow.jpg';
 assert.throws(()=>api.assertReviewedCatalogMedia(payload(next),payload(before)),/MEDIA_REVIEW_REQUIRED/);
 next.angles=[];next.coverImagePath=r.imageUrl;api.assertReviewedCatalogMedia(payload(next),payload(before));
 next.catalogNumber='P10FZT11001';assert.throws(()=>api.assertReviewedCatalogMedia(payload(next),payload(before)),/MEDIA_REVIEW_REQUIRED/);
});
test('known black Samsonite images never get approval even from old provenance, renamed query or approved registry',()=>{
 const bad=manifest.deniedUrls[0];
 assert.throws(()=>api.assertNotDeniedMedia(bad.split('?')[0]+'?v=new'),/REJECTED/);
 assert.throws(()=>api.assertNotDeniedMedia('https://cdn.shopify.com/yellow-renamed.jpg',manifest.deniedSha256[0]),/REJECTED/);
 assert.throws(()=>api.isReviewedMedia(id,bad,undefined,{...manifest,items:[{...r,imageUrl:bad}]}),/REJECTED/);
 const before=item();before.angles=[{id:'bad',imagePath:bad}];const fixed=item();
 api.assertReviewedCatalogMedia(payload(fixed),payload(before));
 assert.throws(()=>api.assertReviewedCatalogMedia(payload(before),payload(before)),/REJECTED/);
});
test('sibling color assignment cannot bypass via unchanged main SKU; swatch hex-only remains allowed',()=>{
 const c={catalogNumber:'BLACK',name:'black',colorCode:'001',imagePath:'black.jpg',angles:['black.jpg']};
 api.assertReviewedColorAssignments('YELLOW',[{...c,hex:'#111111'}],[c]);
 for(const x of [{...c,name:'yellow'},{...c,catalogNumber:'YELLOW'},{...c,imagePath:'yellow.jpg'}])
  assert.throws(()=>api.assertReviewedColorAssignments('YELLOW',[x],[c]),/MEDIA_REVIEW_REQUIRED/);
});
test('only exact server-verified same-product/key/content lineage can retain reviewed transformed source',()=>{
 const parent={product_gid:id.productId,evidence_id:'source',asset_key:'key',content_id:'semantic',proof:{url:r.imageUrl,decodedSha256:r.decodedSha256}};
 const child={...parent,evidence_id:'clone',proof:{url:'https://ekgpaoavsavrtbhlbwdg.supabase.co/owned.jpg',sourceEvidenceId:'source',operationId:'verified-server-operation'}};
 assert.ok(api.isReviewedMediaProof(id,child,[parent,child]));
 for(const changed of [{...parent,product_gid:'other'},{...parent,asset_key:'other'},{...parent,content_id:'other'}])
  assert.equal(api.isReviewedMediaProof(id,child,[changed,child]),false);
 assert.equal(api.isReviewedMediaProof(id,{...child,proof:{...child.proof,operationId:undefined}},[parent]),false);
 assert.equal(api.isReviewedMediaProof(id,child,[{...parent,evidence_id:'source',proof:{...child.proof,sourceEvidenceId:'clone'}},child]),false);
});
test('queued attach holds unreviewed media before any transport; metadata and removals continue',()=>{
 const p={product_gid:id.productId,evidence_id:'e',asset_key:'k',content_id:'c',proof:{url:r.imageUrl,decodedSha256:r.decodedSha256}};
 const d={identity:id,step:{body:{kind:'attach',target:'gallery',key:'k'},expected_pair:{gallery:{assets:[{key:'k',evidenceId:'e',contentId:'c'}]}}},provenance:[p]};
 api.assertReviewedMediaOperation(d);p.proof.url='https://cdn.shopify.com/unreviewed.jpg';
 assert.throws(()=>api.assertReviewedMediaOperation(d),/MEDIA_REVIEW_REQUIRED/);
 d.step.body.kind='alt';api.assertReviewedMediaOperation(d);
 p.proof.url=manifest.deniedUrls[0];assert.throws(()=>api.assertReviewedMediaOperation(d),/REJECTED/);
 d.step.body.kind='detach_reference';api.assertReviewedMediaOperation(d);
});
test('manufacturer imports require independently reviewed source URLs, never similar SKU/name',()=>{
 api.assertReviewedManufacturerImport(r.galleryId,r.sku,[r.imageUrl]);
 assert.throws(()=>api.assertReviewedManufacturerImport(r.galleryId,'P10FZT11001',[r.imageUrl]),/MEDIA_REVIEW_REQUIRED/);
 assert.throws(()=>api.assertReviewedManufacturerImport(r.galleryId,r.sku,['https://manufacturer.example/nearby.jpg']),/MEDIA_REVIEW_REQUIRED/);
});

test('a new manufacturer or product has no implicit image approval from a known category or filename',()=>{
 const next={...id,itemId:'new-item',productId:'gid://shopify/Product/999',variantId:'gid://shopify/ProductVariant/888',exactGallerySku:'NEW-BRAND-001-YELLOW',exactShopifySku:'NEW-BRAND-001-YELLOW'};
 for(const url of [r.imageUrl,'https://new-manufacturer.example/cabin-luggage/NEW-BRAND-001-YELLOW.jpg'])
  assert.throws(()=>api.requireReviewedMedia(next,url),/MEDIA_REVIEW_REQUIRED/);
 assert.throws(()=>api.assertReviewedManufacturerImport(next.itemId,next.exactGallerySku,[r.imageUrl]),/MEDIA_REVIEW_REQUIRED/);
});
