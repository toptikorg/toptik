import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const policy=await import(url(readFileSync('src/lib/shopify/variant-source-policy.ts','utf8')));
const worker=stripTypeScriptTypes(readFileSync('src/lib/shopify/fzt73-source-worker.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const {make}=await import(url(`export function make(deps){const {randomUUID,configuredShopifyDomain,shopifyAdminGraphql,visibleCopyFromProduct,assertSafeDescriptionHtml,verifyOnboardingImage,upsertExactGalleryBindings,FZT73_PRODUCT_GID,FZT73_PRODUCT_HANDLE,FZT73_VARIANTS,exactFzt73Media,exactVariantSeo,process}=deps; ${worker};return reconcileFzt73Variants;}`));
function fixture(){
 const p={id:policy.FZT73_PRODUCT_GID,handle:policy.FZT73_PRODUCT_HANDLE,title:'פאוץ׳ FZT73',descriptionHtml:'<p>עור</p>',status:'ACTIVE',updatedAt:'2026-10-13T00:00:00Z',vendor:'mandarinaduck',productType:'bag',publishedOnPublication:true,seo:{title:'פאוץ׳ FZT73',description:'פאוץ׳ עור.'},
 variants:{nodes:policy.FZT73_VARIANTS.map(v=>({id:'gid://shopify/ProductVariant/'+v.variantId,sku:v.sku,selectedOptions:[{name:'צבע',value:v.color}]})),pageInfo:{hasNextPage:false}},
 media:{nodes:policy.FZT73_MEDIA.map(m=>({id:m.id,alt:'',status:'READY',mediaContentType:'IMAGE',image:{url:m.url,altText:null,width:1000,height:1500}})),pageInfo:{hasNextPage:false}}};
 const tables={carousel_items:[{id:'other',catalog_number:'OTHER',display_order:403,editor_revision:3}],carousel_item_angles:[],carousel_settings:{autoplay_ms:3000,transition_mode:'curtain-fade',editor_revision:1}};
 const calls=[],verified=[];
 const db={from(table){let filters=[],slice,action='read',body;const q={select(){return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},eq(){return q},single(){return q},order(){return q},range(a,b){slice=[a,b+1];return q},update(v){action='update';body=v;return q},then(resolve){calls.push({table,action,body});let data=structuredClone(tables[table]??[]);if(Array.isArray(data)){data=data.filter(r=>filters.every(f=>f(r)));if(slice)data=data.slice(...slice);}return Promise.resolve({data,error:null}).then(resolve)}};return q},
 async rpc(name,args){calls.push({name,args});for(const row of args.p_items){const old=tables.carousel_items.find(r=>r.id===row.id);if(old)Object.assign(old,row);else tables.carousel_items.push({...row,editor_revision:1,copy_updated_at:'created'});}const ids=args.p_items.map(r=>r.id);tables.carousel_item_angles=tables.carousel_item_angles.filter(r=>!ids.includes(r.item_id)).concat(structuredClone(args.p_angles));return{error:null}}};
 const deps={...policy,randomUUID,configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',process:{env:{SHOPIFY_ONLINE_STORE_PUBLICATION_ID:'gid://shopify/Publication/79538258170',SHOPIFY_SYNC_AUTOCREATE:'published_shopify'}},shopifyAdminGraphql:async()=>({product:structuredClone(p)}),visibleCopyFromProduct:s=>({title:s.title,description:'עור',descriptionHtml:s.descriptionHtml,seoTitle:s.seoTitle,seoDescription:s.seoDescription}),assertSafeDescriptionHtml:()=>{},verifyOnboardingImage:async m=>verified.push(m.id),upsertExactGalleryBindings:async(_db,input)=>calls.push({linkSync:input})};
 return{p,tables,calls,verified,db,deps,run:()=>make(deps)(db,Date.now()+45000)};
}
test('creates four exact colors and fifteen decoded images atomically without touching unrelated rows',async()=>{
 const f=fixture(),other=structuredClone(f.tables.carousel_items[0]);await f.run();
 assert.deepEqual(f.tables.carousel_items[0],other);assert.equal(f.verified.length,15);assert.equal(f.tables.carousel_item_angles.length,15);
 const write=f.calls.find(c=>c.name);assert.equal(write.args.p_items.length,4);assert.ok(Object.values(write.args.p_expected_versions).every(v=>v===null));
 assert.equal(f.calls.find(c=>c.linkSync).linkSync.bindings.length,4);
 for(const v of policy.FZT73_VARIANTS){const row=f.tables.carousel_items.find(r=>r.id===v.itemId);assert.equal(row.catalog_number,v.sku);assert.ok(row.title.endsWith(v.color));assert.ok(row.cover_image_alt.includes(v.color));assert.ok(f.tables.carousel_item_angles.filter(a=>a.item_id===v.itemId).every(a=>policy.FZT73_MEDIA.some(m=>m.sku===v.sku&&m.url===a.image_path)));}
});
test('replay preserves revisions and angle identities with no RPC or repeated image download',async()=>{
 const f=fixture();await f.run();const before=structuredClone(f.tables);f.calls.length=0;f.verified.length=0;await f.run();assert.deepEqual(f.tables,before);assert.equal(f.verified.length,0);assert.ok(!f.calls.some(c=>c.name));
});
for(const mode of ['DRAFT','ARCHIVED','unpublished','deleted'])test(mode+' hides all four and preserves files, then republishing restores them',async()=>{
 const f=fixture();await f.run();const images=structuredClone(f.tables.carousel_item_angles);
 if(mode==='unpublished')f.p.publishedOnPublication=false;else if(mode==='deleted')f.deps.shopifyAdminGraphql=async()=>({product:null});else f.p.status=mode;
 await f.run();assert.ok(f.tables.carousel_items.filter(r=>r.id!=='other').every(r=>!r.is_active));assert.deepEqual(f.tables.carousel_item_angles,images);
 f.p.status='ACTIVE';f.p.publishedOnPublication=true;f.deps.shopifyAdminGraphql=async()=>({product:structuredClone(f.p)});await f.run();assert.ok(f.tables.carousel_items.filter(r=>r.id!=='other').every(r=>r.is_active));
});
test('deleted before intake creates nothing',async()=>{const f=fixture();f.deps.shopifyAdminGraphql=async()=>({product:null});await f.run();assert.equal(f.tables.carousel_items.length,1);assert.ok(!f.calls.some(c=>c.name));});
for(const change of [
 f=>f.p.variants.nodes[0].sku='WRONG',
 f=>f.p.variants.nodes[0].selectedOptions[0].value='אדום',
 f=>f.p.media.nodes[0].image.url=f.p.media.nodes[4].image.url,
 f=>f.p.media.nodes.push({...f.p.media.nodes[0],id:'unknown'}),
 f=>f.p.media.pageInfo.hasNextPage=true,
 f=>f.tables.carousel_items.push({id:'collision',catalog_number:'P10FZT73-001-TU',display_order:9}),
 f=>f.deps.verifyOnboardingImage=async()=>{f.p.updatedAt='changed';},
 f=>f.deps.verifyOnboardingImage=async()=>{throw Error('DECODE_FAILED');},
 f=>f.deps.shopifyAdminGraphql=async()=>{throw Error('NETWORK');},
])test('reject unsafe identity, partial source, collision, concurrent change or failed read '+change.toString(),async()=>{
 const f=fixture();change(f);await assert.rejects(f.run());assert.ok(!f.calls.some(c=>c.name));
});
test('new source content is synchronized on the next run and repetition is a no-op',async()=>{
 const f=fixture();await f.run();f.p.title='כותרת מעודכנת';f.p.updatedAt='2026-10-13T01:00:00Z';f.calls.length=0;await f.run();assert.equal(f.calls.filter(c=>c.name).length,1);
 assert.ok(f.tables.carousel_items.filter(r=>r.id!=='other').every(r=>r.title.startsWith('כותרת מעודכנת')));f.calls.length=0;await f.run();assert.ok(!f.calls.some(c=>c.name));
});
test('reviewed static destinations select all four exact variants',()=>{
 const pages=JSON.parse(readFileSync('src/lib/carousel/store-product-pages.json','utf8'));
 for(const v of policy.FZT73_VARIANTS){assert.equal(pages[v.sku].variant,v.variantId);assert.equal(decodeURIComponent(pages[v.sku].handle),policy.FZT73_PRODUCT_HANDLE);}
});
test('failed atomic save or readback never finalizes outbox',async()=>{
 for(const response of [{error:{}},{error:null}]){const f=fixture();f.db.rpc=async()=>response;await assert.rejects(f.run(),/SAVE_FAILED|READBACK_MISMATCH/);assert.ok(!f.calls.some(c=>c.action==='update'));}
});

