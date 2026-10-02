import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';

const url = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`;
const policy = await import(url(readFileSync('src/lib/shopify/variant-source-policy.ts','utf8')));
const source = stripTypeScriptTypes(readFileSync('src/lib/shopify/variant-source-worker.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const { make } = await import(url(`export function make(deps) { const {randomUUID,shopifyAdminGraphql,visibleCopyFromProduct,assertSafeDescriptionHtml,verifyOnboardingImage,MD20_PRODUCT_GID,MD20_VARIANTS,MD20_LEGACY_UNASSIGNED_MEDIA,exactVariantMedia,process}=deps; ${source}; return reconcileApprovedVariants; }`));

function fixture() {
  const p = { id: policy.MD20_PRODUCT_GID, handle: 'md20', title: 'MD20', descriptionHtml: '<p>Source</p>',
    seo: {title:'MD20',description:'Source'},status:'ACTIVE',updatedAt:'2026-10-03T00:00:00Z',vendor:'Mandarina Duck',productType:'Bag',publishedOnPublication:true,
    variants: { nodes: policy.MD20_VARIANTS.map(v=>({id:`gid://shopify/ProductVariant/${v.variantId}`,sku:v.sku})),pageInfo:{hasNextPage:false}},
    media: {nodes:policy.MD20_VARIANTS.flatMap(v=>[1,2].map(i=>({id:`${v.sku}-${i}`,alt:`Bag | ${v.sku} | ${i}`,status:'READY',mediaContentType:'IMAGE',image:{url:`https://cdn.shopify.com/${v.sku}-${i}.jpg`,altText:null,width:100,height:100}}))),pageInfo:{hasNextPage:false}} };
  const tables = {
    carousel_items: policy.MD20_VARIANTS.map(v=>({id:v.itemId,catalog_number:v.sku,title:'Old',copy_updated_at:'old',editor_revision:1,cover_image_path:'old',cover_image_alt:null,is_active:true})),
    carousel_item_angles:[],carousel_settings:{autoplay_ms:3000,transition_mode:'curtain-fade',editor_revision:1},shopify_gallery_public_links:[],shopify_gallery_content_outbox:[],
  };
  const calls=[]; const verified=[];
  const db={from(table){let body,action='read';const q={select(){return q},in(){return q},eq(){return q},single(){return q},update(value){body=value;action='update';return q},upsert(value){body=value;action='upsert';return q},then(resolve){calls.push({table,action,body});return Promise.resolve({data:structuredClone(tables[table]),error:null}).then(resolve)}};return q},
    async rpc(name,args){calls.push({name,args}); for(const row of args.p_items) Object.assign(tables.carousel_items.find(x=>x.id===row.id),row); tables.carousel_item_angles=structuredClone(args.p_angles);return {data:args.p_items.map(x=>({id:x.id})),error:null}}};
  const deps={...policy,randomUUID,process:{env:{SHOPIFY_ONLINE_STORE_PUBLICATION_ID:'gid://shopify/Publication/79538258170'}},
    shopifyAdminGraphql:async()=>({product:structuredClone(p)}),visibleCopyFromProduct:s=>({title:s.title,description:'Source',descriptionHtml:s.descriptionHtml,seoTitle:s.seoTitle,seoDescription:s.seoDescription}),
    assertSafeDescriptionHtml:()=>{},verifyOnboardingImage:async media=>{verified.push(media.id)}};
  return {p,tables,calls,verified,db,deps,run:()=>make(deps)(db,Date.now()+45000)};
}
test('three exact identities are inbound only; unrelated items are not classified',()=>{
  assert.equal(policy.MD20_VARIANTS.length,3);
  assert.equal(policy.isShopifyOwnedVariant(policy.MD20_VARIANTS[0].itemId),true);
  assert.equal(policy.isShopifyOwnedVariant(randomUUID()),false);
});
test('projects all three colors atomically, decodes every exact image, then settles outbox without Shopify writes',async()=>{
  const f=fixture();await f.run();assert.equal(f.verified.length,6);
  const commit=f.calls.find(c=>c.name);assert.equal(commit.name,'save_gallery_catalog_atomic');assert.equal(commit.args.p_items.length,3);
  for(const v of policy.MD20_VARIANTS){const row=f.tables.carousel_items.find(r=>r.id===v.itemId);assert.ok(row.cover_image_path.includes(v.sku));assert.equal(row.title,'MD20');assert.ok(f.tables.carousel_item_angles.filter(a=>a.item_id===v.itemId).every(a=>a.image_path.includes(v.sku)));}
  assert.equal(f.calls.at(-1).table,'shopify_gallery_content_outbox');assert.equal(f.calls.at(-1).body.status,'synced');
});
test('duplicate or missing angle assignment fails before a write',async()=>{
  const f=fixture();f.p.media.nodes[1].alt=f.p.media.nodes[0].alt;
  await assert.rejects(f.run(),/SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED/);assert.ok(!f.calls.some(c=>c.name||c.action!=='read'));
});
test('unknown media cannot be shared across colors',async()=>{
  const f=fixture();f.p.media.nodes.push({...f.p.media.nodes[0],id:'unknown',alt:'Unassigned'});
  await assert.rejects(f.run(),/SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED/);assert.ok(!f.calls.some(c=>c.name));
});
test('known old unassigned images are excluded without blocking the exact assigned colors',async()=>{
  const f=fixture();f.p.media.nodes.push({...f.p.media.nodes[0],id:[...policy.MD20_LEGACY_UNASSIGNED_MEDIA][0],alt:''});
  await f.run();assert.equal(f.verified.length,6);assert.equal(f.tables.carousel_item_angles.length,6);
});
test('identity mismatch and truncation fail closed',async()=>{
  const f=fixture();f.p.variants.nodes[0].id='gid://shopify/ProductVariant/1';
  await assert.rejects(f.run(),/IDENTITY_CONFLICT/);assert.equal(f.calls.length,0);
  const g=fixture();g.p.media.pageInfo.hasNextPage=true;await assert.rejects(g.run(),/MEDIA_LIMIT/);
});
test('source changes during image verification prevent stale commits',async()=>{
  const f=fixture();f.deps.verifyOnboardingImage=async()=>{f.p.updatedAt='2026-10-03T00:01:00Z'};
  await assert.rejects(f.run(),/SYNC_COPY_CONCURRENT_UPDATE/);assert.ok(!f.calls.some(c=>c.name));
});
test('decode failure does not publish a partial projection',async()=>{
  const f=fixture();f.deps.verifyOnboardingImage=async()=>{throw new Error('IMAGE_FAILED')};
  await assert.rejects(f.run(),/IMAGE_FAILED/);assert.ok(!f.calls.some(c=>c.name));
});
test('unpublished product hides existing colors without deleting source images',async()=>{
  const f=fixture();f.p.publishedOnPublication=false;await f.run();assert.equal(f.verified.length,0);assert.ok(f.tables.carousel_items.every(x=>!x.is_active));
});
test('readback mismatch never finalizes outbox',async()=>{
  const f=fixture();f.db.rpc=async()=>({data:[],error:null});await assert.rejects(f.run(),/READBACK_MISMATCH/);
  assert.ok(!f.calls.some(c=>c.table==='shopify_gallery_content_outbox'));
});
