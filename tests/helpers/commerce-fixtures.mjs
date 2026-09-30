import {readFileSync} from 'node:fs';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const req=createRequire(new URL('../../package.json',import.meta.url));
const source=readFileSync(new URL('../../src/lib/shopify/commerce-finalization.ts',import.meta.url),'utf8').replace("'zod'",JSON.stringify(pathToFileURL(req.resolve('zod')).href));
const p=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const H=x=>p.fingerprint(x),cp=structuredClone;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const gid=(kind,n)=>`gid://shopify/${kind}/${n}`;
const time='2026-09-30T12:00:00.000Z';
function fixture(){
 const initialCommercial={price:'0.00',compareAtPrice:null,barcode:null,taxable:true,requiresShipping:true};
 const payload={intentId:id(1),galleryItemId:id(2),sourceFingerprint:H('source'),frozenPendingRevision:H('pending'),currency:'ILS',targetStatus:'ACTIVE',storeIntent:'publish_when_ready',
  commercial:{price:'699',compareAtPrice:null,barcode:'1234567890123',taxable:true,requiresShipping:true,inventoryPolicy:'DENY',tracked:true},
  stock:[{locationId:gid('Location',1),available:5,basis:'merchant_count',evidenceId:id(3)}],
  provenance:{authority:'authenticated_gallery_editor',actorId:id(4),requestId:id(5),savedAt:time}};
 const intent=p.buildMerchantIntent(payload);
 const identity={itemId:id(2),productGid:gid('Product',9001),variantGid:gid('ProductVariant',9002),inventoryItemGid:gid('InventoryItem',9003),sku:'SYNTHETIC-NEW-001',manufacturerSku:'SOURCE-001',brand:'Samsonite',handle:'new-בדיקה',
  customId:{namespace:'app--123--toptik_gallery',key:'source_item_id',value:`${p.SHOP}:gallery:${id(2)}`},sourceFingerprint:H('source')};
 const galleryCopy={title:'Synthetic local fixture',description:'Gallery text',descriptionHtml:'<p>Gallery text</p>',seoTitle:null,seoDescription:null};
 const snapshot={identity,variantCount:1,productStatus:'DRAFT',productUpdatedAt:time,variantUpdatedAt:time,inventoryUpdatedAt:time,publicationIds:[],variantOnlinePublished:true,
  commercial:{...initialCommercial,inventoryPolicy:'DENY',tracked:true},levels:[{locationId:gid('Location',1),active:true,quantities:{available:0,onHand:0,committed:0,reserved:0,damaged:0,safetyStock:0,qualityControl:0,incoming:0}}],levelsComplete:true,
  copyMediaFingerprint:H('copy-media'),decodedImagesVerifiedAt:time,galleryRowFingerprint:H('gallery-row'),galleryCopyVersion:time,galleryCopy,shopifyCopy:{...galleryCopy,description:'Shop text',descriptionHtml:'<p>Shop text</p>'},otherProductDataFingerprint:H('otherproduct'),otherInventoryDataFingerprint:H('otherinventory')};
 const proof={receipt:{policyVersion:'gallery-shopify-draft-v1',galleryItemId:id(2),sourceFingerprint:H('source'),customId:identity.customId,stage:'draft_ready',productGid:identity.productGid,variantGid:identity.variantGid,shopifyUpdatedAt:time,
  commercialFingerprint:createHash('sha256').update(JSON.stringify(initialCommercial)).digest('hex'),initialCommercial},receiptId:id(2),creationRevision:4,frozenPendingRevision:H('pending'),
  pendingStoreIntent:'publish_when_ready',sourceIdentity:{shopifySku:identity.sku,manufacturerSku:identity.manufacturerSku,brand:identity.brand},readbackCommerce:initialCommercial,readbackCopyMediaFingerprint:snapshot.copyMediaFingerprint,readbackGalleryRowFingerprint:snapshot.galleryRowFingerprint,readbackGalleryCopyVersion:time};
 const context={now:Date.parse(time),mode:'publish_verified_v1',environment:'production',shopDomain:p.SHOP,apiVersion:p.API_VERSION,shopCurrency:'ILS',scopes:['write_products','write_inventory','write_publications'],capturedAt:time,
  intentRevision:intent.revision,frozenPendingRevision:intent.frozenPendingRevision,creationRevision:4,leaseOwner:id(7),creationLeaseOwner:id(7),productLeaseOwner:id(7),creationLeaseExpiresAt:'2026-09-30T12:01:00.000Z',productLeaseExpiresAt:'2026-09-30T12:01:00.000Z',
  locations:[{id:gid('Location',1),active:true,fulfillsOnlineOrders:true,merchantManaged:true,inventoryWriteAllowed:true}],locationsComplete:true,catalogComplete:true,catalogCapturedAt:time,
  gallery:[{id:id(2),sku:identity.sku,active:false}],shopify:[{productGid:identity.productGid,variantGid:identity.variantGid,sku:identity.sku}],approved:[]};
 return {payload,intent,snapshot,proof,context};
}

export {p,H,cp,id,gid,time,fixture};
