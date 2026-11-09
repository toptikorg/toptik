import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const url = s => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const policy = await import(url(readFileSync('src/lib/shopify/variant-source-policy.ts', 'utf8')));
const worker = stripTypeScriptTypes(readFileSync('src/lib/shopify/fzt73-source-worker.ts', 'utf8')).replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const { make } = await import(url(`export function make(deps){const {configuredShopifyDomain,shopifyAdminGraphql,visibleCopyFromProduct,assertSafeDescriptionHtml,verifyOnboardingImage,FZT73_PRODUCT_GID,FZT73_PRODUCT_HANDLE,FZT73_VARIANTS,exactFzt73Media,exactVariantSeo,process}=deps; ${worker};return reconcileFzt73Variants;}`));
const owner = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const p = {id:policy.FZT73_PRODUCT_GID,handle:policy.FZT73_PRODUCT_HANDLE,title:'פאוץ׳ FZT73',descriptionHtml:'<p>עור</p>',status:'ACTIVE',updatedAt:'2026-10-13T00:00:00Z',vendor:'mandarinaduck',productType:'bag',publishedOnPublication:true,seo:{title:'פאוץ׳ FZT73',description:'פאוץ׳ עור.'},
    variants:{nodes:policy.FZT73_VARIANTS.map(v=>({id:'gid://shopify/ProductVariant/'+v.variantId,sku:v.sku,selectedOptions:[{name:'צבע',value:v.color}]})),pageInfo:{hasNextPage:false}},
    media:{nodes:policy.FZT73_MEDIA.map(m=>({id:m.id,alt:'',status:'READY',mediaContentType:'IMAGE',image:{url:m.url,altText:null,width:1000,height:1500}})),pageInfo:{hasNextPage:false}}};
  const tables={carousel_items:[{id:'other',catalog_number:'OTHER',display_order:403,editor_revision:3}],carousel_item_angles:[],shopify_gallery_bindings:[]};
  for (const [n,v] of policy.FZT73_VARIANTS.entries()) {
    const media=policy.exactFzt73Media(p.media.nodes,v.sku);
    const seo=policy.exactVariantSeo({title:p.title,seoTitle:p.seo.title,seoDescription:p.seo.description},v.sku);
    tables.carousel_items.push({id:v.itemId,catalog_number:v.sku,display_order:n+1,editor_revision:1,copy_updated_at:'2026-10-13T00:00:00Z',is_active:true,
      title:p.title+` בצבע ${v.color}`,description:'עור',description_html:p.descriptionHtml,seo_title:seo.seoTitle,seo_description:seo.seoDescription,
      cover_image_path:media[0].image.url,cover_image_alt:media[0].alt});
    tables.shopify_gallery_bindings.push({carousel_item_id:v.itemId,catalog_key:v.sku,product_gid:p.id,variant_gid:'gid://shopify/ProductVariant/'+v.variantId});
    tables.carousel_item_angles.push(...media.map((m,i)=>({id:v.sku+'-'+i,item_id:v.itemId,angle_key:String(i+1),angle_order:i+1,image_path:m.image.url,image_alt:m.alt})));
  }
  const calls=[],verified=[];
  const db={from(table){let filters=[],slice,action='read',body;const q={select(){return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},eq(){return q},single(){return q},order(){return q},range(a,b){slice=[a,b+1];return q},update(v){action='update';body=v;return q},then(resolve){calls.push({table,action,body});let data=structuredClone(tables[table]??[]);if(Array.isArray(data)){data=data.filter(r=>filters.every(f=>f(r)));if(slice)data=data.slice(...slice);}return Promise.resolve({data,error:null}).then(resolve)}};return q},
    async rpc(name,args){calls.push({name,args});if(name!=='apply_fzt73_owned_batch') throw Error('unexpected RPC');for(const entry of args.p_entries){const row=tables.carousel_items.find(r=>r.id===entry.itemId);const {angles,...copy}=structuredClone(entry.projection);Object.assign(row,copy);tables.carousel_item_angles=tables.carousel_item_angles.filter(a=>a.item_id!==row.id).concat(angles.map((a,i)=>({...a,item_id:row.id,id:row.id+'-'+i})));}return {data:{items:args.p_entries.map(e=>({itemId:e.itemId,result:{status:'updated'}}))},error:null};}};
  const deps={...policy,configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',process:{env:{SHOPIFY_ONLINE_STORE_PUBLICATION_ID:'gid://shopify/Publication/79538258170'}},
    shopifyAdminGraphql:async()=>({product:structuredClone(p)}),visibleCopyFromProduct:s=>({title:s.title,description:'עור',descriptionHtml:s.descriptionHtml,seoTitle:s.seoTitle,seoDescription:s.seoDescription}),assertSafeDescriptionHtml:()=>{},verifyOnboardingImage:async m=>verified.push(m.id)};
  return {p,tables,calls,verified,db,deps,run:()=>make(deps)(db,Date.now()+45000,owner)};
}
test('uses the same owned lease for each exact color without settling outbox',async()=>{
  const f=fixture();await f.run();const saves=f.calls.filter(c=>c.name);
  assert.equal(saves.length,1);for(const c of saves){assert.equal(c.name,'apply_fzt73_owned_batch');assert.equal(c.args.p_entries.length,4);assert.equal(c.args.p_owner,owner);assert.equal(c.args.p_product_gid,policy.FZT73_PRODUCT_GID);}
  assert.ok(!f.calls.some(c=>c.table==='shopify_gallery_content_outbox'&&c.action==='update'));
});
test('never creates missing colors or reactivates an editorial hide',async()=>{
  const f=fixture(), removed=policy.FZT73_VARIANTS[0], hidden=policy.FZT73_VARIANTS[1];
  f.tables.carousel_items=f.tables.carousel_items.filter(r=>r.id!==removed.itemId);
  f.tables.carousel_item_angles=f.tables.carousel_item_angles.filter(a=>a.item_id!==removed.itemId);
  f.tables.carousel_items.find(r=>r.id===hidden.itemId).is_active=false;
  const hiddenAngles=structuredClone(f.tables.carousel_item_angles.filter(a=>a.item_id===hidden.itemId));await f.run();
  assert.ok(!f.tables.carousel_items.some(r=>r.id===removed.itemId));assert.equal(f.tables.carousel_items.find(r=>r.id===hidden.itemId).is_active,false);
  assert.deepEqual(f.tables.carousel_item_angles.filter(a=>a.item_id===hidden.itemId),hiddenAngles);
  assert.deepEqual(f.calls.find(c=>c.name).args.p_entries.map(e=>e.itemId),policy.FZT73_VARIANTS.slice(2).map(v=>v.itemId));
});
for(const mode of ['DRAFT','ARCHIVED','UNLISTED','unpublished','deleted'])test(mode+' never recreates or rewrites gallery items',async()=>{
  const f=fixture(), before=structuredClone(f.tables);if(mode==='unpublished')f.p.publishedOnPublication=false;else if(mode==='deleted')f.deps.shopifyAdminGraphql=async()=>({product:null});else f.p.status=mode;
  await f.run();assert.deepEqual(f.tables,before);assert.ok(!f.calls.some(c=>c.name));
});
for(const change of [
 f=>f.p.variants.nodes[0].sku='WRONG', f=>f.p.variants.nodes[0].selectedOptions[0].value='אדום',
 f=>f.p.media.nodes[0].image.url=f.p.media.nodes[4].image.url,
 f=>f.p.media.nodes.push({...f.p.media.nodes[0],id:'unknown'}), f=>f.p.media.pageInfo.hasNextPage=true,
 f=>f.tables.carousel_items.push({id:'collision',catalog_number:'P10FZT73-001-TU',display_order:9}),
 f=>f.tables.shopify_gallery_bindings[0].variant_gid='wrong',
 f=>{f.p.title='חדש';f.deps.verifyOnboardingImage=async()=>{f.p.title='changed source';};},
 f=>{f.p.title='חדש';f.deps.verifyOnboardingImage=async()=>{throw Error('DECODE_FAILED');};},
 f=>f.deps.shopifyAdminGraphql=async()=>{throw Error('NETWORK');},
])test('rejects unsafe source, binding, collision or changed source '+change.toString(),async()=>{
  const f=fixture();change(f);await assert.rejects(f.run());assert.ok(!f.calls.some(c=>c.name));
});
test('source changes request owned projections and read back exact color media',async()=>{
  const f=fixture();f.p.title='כותרת מעודכנת';await f.run();assert.equal(f.calls.filter(c=>c.name).length,1);assert.equal(f.verified.length,15);
  for(const v of policy.FZT73_VARIANTS){const row=f.tables.carousel_items.find(r=>r.id===v.itemId);assert.ok(row.title.endsWith(v.color));
    assert.ok(f.tables.carousel_item_angles.filter(a=>a.item_id===v.itemId).every(a=>policy.FZT73_MEDIA.some(m=>m.sku===v.sku&&m.url===a.image_path)));}
});
test('missing baseline or failed readback stops without acknowledging outbox',async()=>{
  for(const result of [{error:{message:'SYNC_FZT73_BASELINE_REQUIRED'}},{data:{items:policy.FZT73_VARIANTS.map(v=>({itemId:v.itemId,result:{status:'updated'}}))},error:null}]){
    const f=fixture();f.p.title='changed';f.db.rpc=async()=>result;await assert.rejects(f.run(),/BASELINE_REQUIRED|READBACK_MISMATCH/);
    assert.ok(!f.calls.some(c=>c.table==='shopify_gallery_content_outbox'&&c.action==='update'));
  }
});
test('a Shopify edit during color writes is never acknowledged as a finished sync',async()=>{
  const f=fixture();let reads=0;f.deps.shopifyAdminGraphql=async()=>{if(++reads===3)f.p.title='נוסף בזמן השמירה';return {product:structuredClone(f.p)};};
  await assert.rejects(f.run(),/SYNC_COPY_CONCURRENT_UPDATE/);
  assert.ok(!f.calls.some(c=>c.table==='shopify_gallery_content_outbox'&&c.action==='update'));
});
test('a timestamp-only source refresh does not block reconciliation',async()=>{
  const f=fixture();let reads=0;f.deps.shopifyAdminGraphql=async()=>{if(++reads>1)f.p.updatedAt='2026-10-13T00:05:00Z';return {product:structuredClone(f.p)};};
  await f.run();assert.equal(f.calls.filter(c=>c.name==='apply_fzt73_owned_batch').length,1);
});
test('reviewed static destinations select all four exact variants',()=>{
  const pages=JSON.parse(readFileSync('src/lib/carousel/store-product-pages.json','utf8'));
  for(const v of policy.FZT73_VARIANTS){assert.equal(pages[v.sku].variant,v.variantId);assert.equal(decodeURIComponent(pages[v.sku].handle),policy.FZT73_PRODUCT_HANDLE);}
});
test('SQL per-color image allowlist exactly matches the reviewed source policy',()=>{
  const sql=readFileSync('supabase/migrations/20261109130444_fzt73_owned_projection.sql','utf8');
  for(const v of policy.FZT73_VARIANTS){const expected=policy.FZT73_MEDIA.filter(m=>m.sku===v.sku).map(m=>m.url);
    const section=sql.split(`when '${v.sku}' then array[`)[1]?.split(']')[0];assert.ok(section,`missing SQL mapping for ${v.sku}`);
    const urls=Array.from(section.matchAll(/'(https:\/\/[^']+)'/g),m=>m[1]);assert.deepEqual(urls,expected);}
});
