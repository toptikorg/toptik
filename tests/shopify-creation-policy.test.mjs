import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl, descriptionHelpers } from "./helpers/description-module.mjs";
const url=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
const vendor=url(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8'));
const rules=url(readFileSync('src/lib/shopify/sync-rules.ts','utf8').replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
const source=readFileSync('src/lib/shopify/creation-policy.ts','utf8');
const p=await import(url(source.replace('"zod"',JSON.stringify(import.meta.resolve('zod')))
  .replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules))));
const now=Date.parse('2026-09-30T19:00:00Z'),ts=new Date(now).toISOString();
const id='00000000-0000-4000-8000-000000000051';
const image='https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/verified/exact.webp';
const namespace='app--12345--toptik_gallery';
function draft(){const html='<p dir="rtl">תיאור <strong>עשיר</strong> עם <a href="https://www.bricsmilano.com/">קישור</a></p><table><tr><td>מידה</td><td>55</td></tr></table>';return {
  galleryItemId:id,copyUpdatedAt:ts,shopifySku:'NEW-BRIC.078',manufacturerSku:'NEW-BRIC.078',identityMapping:null,brand:"Bric's",category:'carryon',
  copy:{title:'מזוודה מאומתת',description:descriptionHelpers.descriptionTextFromHtml(html),descriptionHtml:html,seoTitle:'כותרת מקורית',seoDescription:null},
  media:[{url:image,alt:'מזוודה בצבע ירוק'}],commerce:{sellingPrice:'1299.9',currency:'ILS',compareAtPrice:'1499',barcode:null,taxable:true,requiresShipping:true,inventory:{status:'unknown'},storeIntent:'draft'}};}
function context(d=draft()){return {mode:'draft_only',now,shopDomain:'toptikcoil.myshopify.com',shopCurrency:'ILS',expectedAppNamespace:namespace,
  definition:{namespace,key:'source_item_id',ownerType:'PRODUCT',type:'id',uniqueValuesEnabled:true},
  catalog:{complete:true,capturedAt:ts,gallery:[{id,catalogNumber:d.shopifySku,isActive:false}],shopify:[]},
  images:d.media.map(m=>({url:m.url,galleryItemId:id,exactSku:d.shopifySku,sha256:'a'.repeat(64),mime:'image/webp',width:600,height:900,byteLength:12000,verifiedAt:ts}))};}
function ready(d=draft(),c=context(d)){return p.readyGalleryCreationDraft(d,c);}
function snapshot(r=ready()){return {productGid:'gid://shopify/Product/999',variantGid:'gid://shopify/ProductVariant/888',variantCount:1,sku:'',status:'DRAFT',publishedAnywhere:false,
  customId:{...r.customId},sourceFingerprint:r.sourceFingerprint,updatedAt:ts,brand:r.draft.brand,commercial:{price:'0.00',compareAtPrice:null,barcode:null,taxable:false,requiresShipping:true},copy:{title:r.draft.copy.title,descriptionHtml:r.draft.copy.descriptionHtml??descriptionHelpers.plainDescriptionToHtml(r.draft.copy.description),seoTitle:r.draft.copy.seoTitle,seoDescription:r.draft.copy.seoDescription}};}
function receipt(r=ready(),stage='reserved'){return {policyVersion:p.GALLERY_CREATION_POLICY,galleryItemId:id,sourceFingerprint:r.sourceFingerprint,customId:{...r.customId},stage,productGid:null,variantGid:null,shopifyUpdatedAt:null,commercialFingerprint:null,initialCommercial:null};}

test('complete exact new draft preserves rich HTML, fixed DRAFT status and private commerce',()=>{
  const d=draft(),r=ready(d),v=p.buildGalleryDraftCreateVariables(r);
  assert.equal(r.readyForPublication,false);assert.deepEqual(r.outstanding,['inventory','publication_not_supported_v1']);
  assert.equal(v.product.status,'DRAFT');assert.equal(v.product.descriptionHtml,d.copy.descriptionHtml);assert.equal(v.product.vendor,"Bric's");
  assert.equal(v.product.metafields[0].type,'id');assert.equal(v.product.metafields[0].value,`toptikcoil.myshopify.com:gallery:${id}`);
  assert.equal(v.media[0].originalSource,image);assert.equal(v.media[0].mediaContentType,'IMAGE');
  assert.equal('variants' in v.product,false);assert.equal('published' in v.product,false);assert.equal('handle' in v.product,false);
  const variant=p.buildGalleryDraftVariantVariables(r,snapshot(r),ts,p.galleryDraftCommercialFingerprint(snapshot(r).commercial));
  assert.deepEqual(variant,{productId:'gid://shopify/Product/999',allowPartialUpdates:false,variants:[{id:'gid://shopify/ProductVariant/888',inventoryItem:{sku:d.shopifySku,requiresShipping:true},price:'1299.90',compareAtPrice:'1499.00',taxable:true}]});
  assert.equal(JSON.stringify(variant).includes('quantity'),false);assert.equal(JSON.stringify(variant).includes('tracked'),false);
});

test('unknown price/tax/stock remains a real unpublished draft, never invented numbers',()=>{
  const d=draft();d.commerce.sellingPrice=null;d.commerce.compareAtPrice=null;d.commerce.taxable=null;
  const r=ready(d),v=p.buildGalleryDraftVariantVariables(r,snapshot(r),ts,p.galleryDraftCommercialFingerprint(snapshot(r).commercial)).variants[0];
  assert.deepEqual(r.outstanding,['selling_price','tax_policy','inventory','publication_not_supported_v1']);
  for(const key of ['price','compareAtPrice','taxable','inventoryQuantities','inventoryPolicy']) assert.equal(key in v,false);
  assert.equal(p.buildGalleryDraftCreateVariables(r).product.status,'DRAFT');
});

test('plain text is escaped; raw rich text is never flattened or regenerated',()=>{
  const d=draft();d.copy.descriptionHtml=null;d.copy.description='<script>not markup</script> & תיאור';
  assert.equal(p.buildGalleryDraftCreateVariables(ready(d)).product.descriptionHtml,'<p>&lt;script&gt;not markup&lt;/script&gt; &amp; תיאור</p>');
  const changed=draft();changed.copy.description+=' mismatch';assert.throws(()=>ready(changed),/DESCRIPTION_PAIR_MISMATCH/);
  const unsafe=draft();unsafe.copy.descriptionHtml='<meta http-equiv="refresh" content="0;https://evil.test">';assert.throws(()=>ready(unsafe),/HTML_UNSAFE/);
});

test('all public brands allowed; other brands and held identifiers fail closed',()=>{
  for(const brand of ['Mandarina Duck',"Bric's",'Samsonite']){const d=draft();d.brand=brand;assert.equal(ready(d).draft.brand,brand);}
  for(const brand of ['Porsche Design','American Tourister','', 'brics']){const d=draft();d.brand=brand;assert.throws(()=>ready(d),/DRAFT_INVALID/);}
  for(const sku of ['P10OSV04-05J-TU','P10OSV0405J','p10zjt06.24u.tu','ORI05500909','ORI05500024']){const d=draft();d.shopifySku=sku;d.manufacturerSku=sku;assert.throws(()=>ready(d),/HELD_OR_INVALID_SKU/);}
});

test('manufacturer identity stays separate and needs explicit paired evidence',()=>{
  const d=draft();d.shopifySku='KJ114007';d.manufacturerSku='150700-9199';d.brand='Samsonite';
  assert.throws(()=>ready(d),/MANUFACTURER_MAPPING_REQUIRED/);
  d.identityMapping={shopifySku:d.shopifySku,manufacturerSku:d.manufacturerSku,sourceUrl:'https://www.samsonite.co.uk/product/150700-9199.html',evidenceSha256:'b'.repeat(64),verifiedAt:ts};
  const r=ready(d);assert.equal(r.draft.shopifySku,'KJ114007');assert.equal(r.draft.manufacturerSku,'150700-9199');
  assert.equal(p.buildGalleryDraftVariantVariables(r,snapshot(r),ts,p.galleryDraftCommercialFingerprint(snapshot(r).commercial)).variants[0].inventoryItem.sku,'KJ114007');
  d.identityMapping.manufacturerSku='OTHER';assert.throws(()=>ready(d),/MAPPING_REQUIRED/);
});

test('strict schemas reject supplier/stock/publication knobs and invalid money',()=>{
  for(const mutate of [d=>{d.commerce.supplierPrice='1';},d=>{d.commerce.inventory.quantity=10;},d=>{d.commerce.inventory.status='untracked';},d=>{d.commerce.storeIntent='active';},d=>{d.isActive=true;},d=>{d.commerce.requiresShipping=false;},d=>{d.shopifySku=' ABC ';},d=>{d.shopifySku='a💥';},d=>{d.commerce.sellingPrice='0';},d=>{d.commerce.sellingPrice='1e3';},d=>{d.commerce.sellingPrice='1.123';},d=>{d.commerce.sellingPrice=123;},d=>{d.commerce.compareAtPrice='100';}]){
    const d=draft();mutate(d);assert.throws(()=>ready(d),/SYNC_CREATION_(DRAFT_INVALID|COMPARE_PRICE_INVALID)/);
  }
  const d=draft();d.commerce.currency='EUR';assert.throws(()=>ready(d),/CURRENCY_MISMATCH/);
});

test('default off and custom ID must be exact app-owned PRODUCT id definition',()=>{
  for(const mode of [undefined,'','on','true','published_shopify']){const c=context();c.mode=mode;assert.throws(()=>ready(draft(),c),/NOT_ENABLED/);}
  for(const mutate of [c=>{c.shopDomain='other.myshopify.com';},c=>{c.expectedAppNamespace='custom';},c=>{c.definition.namespace='app--888--toptik_gallery';},c=>{c.definition.type='single_line_text_field';},c=>{c.definition.key='other';},c=>{c.definition.ownerType='PRODUCTVARIANT';},c=>{c.definition.uniqueValuesEnabled=false;}]){
    const c=context();mutate(c);assert.throws(()=>ready(draft(),c),/SHOP_CONFIG_INVALID|CUSTOM_ID_DEFINITION_INVALID/);
  }
});

test('full catalog proof includes draft/archived Shopify and inactive Gallery collisions',()=>{
  for(const status of ['ACTIVE','DRAFT','ARCHIVED']){const c=context();c.catalog.shopify=[{productGid:'gid://shopify/Product/1',variantGid:'gid://shopify/ProductVariant/2',sku:'new.bric-078',status}];assert.throws(()=>ready(draft(),c),/SHOPIFY_SKU_COLLISION/);}
  const c=context();c.catalog.gallery.push({id:'different',catalogNumber:'NEWBRIC078',isActive:false});assert.throws(()=>ready(draft(),c),/GALLERY_SKU_COLLISION/);
  for(const mutate of [c=>{c.catalog.complete=false;},c=>{c.catalog.capturedAt=new Date(now-300001).toISOString();},c=>{c.catalog.capturedAt=new Date(now+30001).toISOString();},c=>{c.catalog.gallery=[];},c=>{c.catalog.gallery[0].catalogNumber='DIFFERENT';},c=>{c.catalog.gallery.push({...c.catalog.gallery[0]});}]){
    const c=context();mutate(c);assert.throws(()=>ready(draft(),c),/CATALOG_PROOF_STALE|GALLERY_IDENTITY_CHANGED/);
  }
});

test('image readiness requires own project/CDN, exact ordered SKU and decoded evidence',()=>{
  for(const value of ['/hero-web-airport.png','https://else.supabase.co/storage/v1/object/public/carousel-media/a.webp','https://cdn.shopify.com.evil.test/s/files/a.jpg','https://cdn.shopify.com:443/s/files/a.jpg','https://cdn.shopify.com/s/files/a.jpg#x','https://cdn.shopify.com/s/files/%2e%2e/a.jpg','https://cdn.shopify.com/s/files/a\\b.jpg']) assert.equal(p.approvedCreationImageUrl(value),false,value);
  assert.equal(p.approvedCreationImageUrl('https://cdn.shopify.com/s/files/1/a.jpg?v=1'),true);
  for(const mutate of [c=>{c.images=[];},c=>{c.images[0].exactSku='WRONG';},c=>{c.images[0].galleryItemId='WRONG';},c=>{c.images[0].sha256='bad';},c=>{c.images[0].mime='image/svg+xml';},c=>{c.images[0].width=16001;},c=>{c.images[0].width=4001;c.images[0].height=4000;},c=>{c.images[0].byteLength=8388609;},c=>{c.images[0].verifiedAt=new Date(now-300001).toISOString();}]){
    const c=context();mutate(c);assert.throws(()=>ready(draft(),c),/MEDIA_PROOF_/);
  }
  const d=draft();d.media.push({...d.media[0]});assert.throws(()=>ready(d),/MEDIA_INVALID/);
});

test('fingerprint covers copy, identities, image order and commerce; no unknown fields discarded',()=>{
  const d=draft(),first=p.galleryCreationFingerprint(d);
  for(const mutate of [d=>{d.copy.seoTitle='Changed';},d=>{d.commerce.sellingPrice='1399';},d=>{d.manufacturerSku=null;},d=>{d.media[0].alt='Other';},d=>{d.copyUpdatedAt=new Date(now+1).toISOString();}]){const changed=structuredClone(d);mutate(changed);assert.notEqual(p.galleryCreationFingerprint(changed),first);}
  const changed=ready();changed.draft.copy.title='Changed after approval';assert.throws(()=>p.buildGalleryDraftCreateVariables(changed),/READY_PROOF_CHANGED/);
  assert.throws(()=>p.galleryCreationFingerprint({...d,unapproved:'field'}),/DRAFT_INVALID/);
  const r=ready();r.imageEvidence[0].sha256='b'.repeat(64);assert.throws(()=>p.buildGalleryDraftCreateVariables(r),/READY_PROOF_CHANGED/);
  const c=context();c.images[0].verifiedAt=new Date(now-1000).toISOString();assert.equal(ready(d,c).sourceFingerprint,ready(d).sourceFingerprint);
});

test('fresh reserved operation creates once; uncertain/started absence never retries create',()=>{
  const r=ready();assert.equal(p.planGalleryCreationRecovery(r,receipt(r),{complete:true,found:null}).kind,'create_draft');
  assert.equal(p.planGalleryCreationRecovery(r,receipt(r),{complete:false,found:null}).kind,'lookup_custom_id');
  for(const stage of ['create_started','variant_started','uncertain','draft_ready'])assert.equal(p.planGalleryCreationRecovery(r,receipt(r,stage),{complete:true,found:null}).kind,'lookup_custom_id');
  assert.equal(p.planGalleryCreationRecovery(r,receipt(r,'review'),{complete:true,found:null}).kind,'stop');
});

test('lost create response recovers exact custom ID without replaying any mutation',()=>{
  const r=ready(),s=snapshot(r);
  for(const stage of ['reserved','create_started','uncertain','variant_started','draft_ready']) assert.equal(p.planGalleryCreationRecovery(r,receipt(r,stage),{complete:true,found:s}).kind,'verify_draft');
  const rec={...receipt(r,'draft_found'),productGid:s.productGid,variantGid:s.variantGid,shopifyUpdatedAt:ts,commercialFingerprint:p.galleryDraftCommercialFingerprint(s.commercial),initialCommercial:s.commercial};
  assert.equal(p.planGalleryCreationRecovery(r,rec,{complete:true,found:s}).kind,'configure_variant');
  const newer={...s,updatedAt:new Date(now+1000).toISOString()};assert.throws(()=>p.planGalleryCreationRecovery(r,rec,{complete:true,found:newer}),/DRAFT_VERSION_CHANGED/);
  assert.throws(()=>p.planGalleryCreationRecovery(r,receipt(r,'draft_found'),{complete:true,found:s}),/RECEIPT_IDENTITY_MISSING/);
});

test('recovery rejects foreign/changed product, extra variants, public state or merchant copy change',()=>{
  const r=ready();
  for(const mutate of [s=>{s.customId.value='other';},s=>{s.customId.namespace='custom';},s=>{s.sourceFingerprint='b'.repeat(64);},s=>{s.variantCount=2;},s=>{s.sku='OTHER';},s=>{s.status='ACTIVE';},s=>{s.publishedAnywhere=true;},s=>{s.productGid='bad';},s=>{s.copy.title='Merchant edit';},s=>{s.copy.descriptionHtml='<p>Merchant edit</p>';},s=>{s.brand='Samsonite';}]){
    const s=snapshot(r);mutate(s);assert.throws(()=>p.planGalleryCreationRecovery(r,receipt(r,'uncertain'),{complete:true,found:s}),/OWNED_DRAFT_/);
  }
  const rec=receipt(r,'draft_found');rec.productGid='gid://shopify/Product/123';assert.throws(()=>p.planGalleryCreationRecovery(r,rec,{complete:true,found:snapshot(r)}),/RECEIPT_IDENTITY_CONFLICT/);
  for(const mutate of [r=>{r.sourceFingerprint='b'.repeat(64);},r=>{r.galleryItemId='other';},r=>{r.stage='publish';}]){const rec=receipt(r);mutate(rec);assert.throws(()=>p.planGalleryCreationRecovery(r,rec,{complete:true,found:null}),/RECEIPT_CHANGED|STAGE_INVALID/);}
});

test('state machine has no publication/delete/rewind transitions',()=>{
  assert.equal(p.transitionGalleryCreationStage('reserved','create_started'),'create_started');
  assert.equal(p.transitionGalleryCreationStage('create_started','uncertain'),'uncertain');
  assert.throws(()=>p.transitionGalleryCreationStage('uncertain','draft_found'),/STAGE_TRANSITION_INVALID/);
  assert.equal(p.transitionGalleryCreationStage('variant_started','draft_ready'),'draft_ready');
  for(const [a,b] of [['reserved','draft_ready'],['uncertain','reserved'],['draft_ready','create_started'],['draft_ready','published'],['review','reserved'],['toString','review']])assert.throws(()=>p.transitionGalleryCreationStage(a,b),/STAGE_TRANSITION_INVALID/);
});

test('restart revalidates fresh proof and exempts only the exact owned draft, not other SKU collisions',()=>{
  const d=draft(),r=ready(d),s=snapshot(r);s.sku=d.shopifySku;
  const c=context(d);c.catalog.shopify=[{productGid:s.productGid,variantGid:s.variantGid,sku:s.sku,status:'DRAFT'}];
  c.recovery={receipt:receipt(r,'create_started'),snapshot:s};
  assert.equal(ready(d,c).sourceFingerprint,r.sourceFingerprint);
  for(const mutate of [c=>{c.catalog.shopify.push({productGid:'gid://shopify/Product/333',variantGid:'gid://shopify/ProductVariant/444',sku:d.shopifySku,status:'ARCHIVED'});},c=>{c.catalog.shopify[0].variantGid='gid://shopify/ProductVariant/444';},c=>{c.catalog.shopify[0].status='ACTIVE';},c=>{c.recovery.receipt.stage='reserved';},c=>{c.recovery.snapshot.copy.title='Externally changed';},c=>{c.catalog.complete=false;}]){
    const changed=structuredClone(c);mutate(changed);assert.throws(()=>ready(d,changed),/SHOPIFY_SKU_COLLISION|RECOVERY_|OWNED_DRAFT_|CATALOG_PROOF_STALE/);
  }
});

test('module has no network, secret, database, publication or productSet execution',()=>{
  assert.doesNotMatch(source,/\bfetch\s*\(|createSupabase|process\.env|publishablePublish\s*\(|productSet\s*\(|productDelete\s*\(/);
  assert.equal(p.galleryCreationDraftSchema.safeParse({...draft(),price:'1'}).success,false);
});


test('initial variant configure detects merchant commerce edits even with unchanged product version',()=>{
 const r=ready(),s=snapshot(r),hash=p.galleryDraftCommercialFingerprint(s.commercial);
 for(const patch of [{price:'19.00'},{taxable:true},{barcode:'external'},{compareAtPrice:'50'},{requiresShipping:false}]){
  const changed=structuredClone(s);Object.assign(changed.commercial,patch);
  assert.throws(()=>p.buildGalleryDraftVariantVariables(r,changed,ts,hash),/DRAFT_COMMERCE_CHANGED/);
 }
 assert.throws(()=>p.buildGalleryDraftVariantVariables(r,s,ts,''),/DRAFT_COMMERCE_CHANGED/);
});

test('Shopify pretty-printed list whitespace preserves exact owned draft identity',()=>{
 const d=draft();d.copy.descriptionHtml='<ul><li>ראשון</li><li>שני</li></ul>';d.copy.description=descriptionHelpers.descriptionTextFromHtml(d.copy.descriptionHtml);
 const r=ready(d),s=snapshot(r);s.copy.descriptionHtml='<ul>\n  <li>ראשון</li>\n  <li>שני</li>\n</ul>';
 assert.doesNotThrow(()=>p.assertOwnedGalleryDraft(r,s));
});

test('draft-ready requires frozen image byte identity, exact ordered media and complete commerce readback',()=>{
 const r=ready(),s=snapshot(r),initial=structuredClone(s.commercial);
 s.sku=r.draft.shopifySku;s.commercial={...initial,price:'1299.90',compareAtPrice:'1499.00',taxable:true};
 const images=[{productGid:s.productGid,mediaGid:'gid://shopify/MediaImage/5',status:'READY',url:'https://cdn.shopify.com/s/files/1/exact.webp',alt:r.draft.media[0].alt,...r.imageEvidence[0]}];
 images[0].url='https://cdn.shopify.com/s/files/1/exact.webp';
 assert.doesNotThrow(()=>p.assertCreatedDraftReadback(r,s,images,now,initial));
 for(const patch of [{sha256:'b'.repeat(64)},{status:'PROCESSING'},{mediaGid:'bad'},{alt:'wrong'},{byteLength:1},{verifiedAt:new Date(now-300001).toISOString()}]){
  assert.throws(()=>p.assertCreatedDraftReadback(r,s,[{...images[0],...patch}],now,initial),/DRAFT_READBACK_MEDIA_MISMATCH/);
 }
 s.commercial.barcode='merchantEdit';assert.throws(()=>p.assertCreatedDraftReadback(r,s,images,now,initial),/DRAFT_READBACK_COMMERCE_MISMATCH/);
});
