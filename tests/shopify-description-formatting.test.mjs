import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { descriptionModuleUrl, descriptionHelpers as h } from './helpers/description-module.mjs';

// All inputs are synthetic and all side effects are mocked. The actual worker,
// policy, identity guards, patch builder and HTML parser run from this checkout.
const asModule = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const readProduction = file => readFileSync(`src/lib/shopify/${file}`, 'utf8');
const vendorUrl = asModule(readFileSync('src/lib/catalog-source/vendor-detect.ts', 'utf8'));
const rulesUrl = asModule(readProduction('sync-rules.ts').replace('"@/lib/catalog-source/vendor-detect"', JSON.stringify(vendorUrl)));
const eligibilityUrl = asModule(readProduction('copy-eligibility.ts'));
const workerSource = stripTypeScriptTypes(readProduction('sync-worker.ts')).replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const policyUrl = asModule(readProduction('sync-policy.ts').replace('"./description-document"', JSON.stringify(descriptionModuleUrl)));
const policy = await import(policyUrl);
const admin = await import(asModule(readProduction('admin-api.ts')
  .replace(/^import "server-only";\s*/m, '')
  .replace(/^import \{ createShopifyClientCredentialsProvider \} from "\.\/client-credentials";\s*/m,
    'const createShopifyClientCredentialsProvider = () => { throw new Error("UNEXPECTED_AUTHENTICATION"); };\n')
  .replace('"./description-document"', JSON.stringify(descriptionModuleUrl))));
const worker = await import(asModule(`
  import {createHash,randomUUID} from 'node:crypto';
  import {assertVerifiedCopyApproval,assertVerifiedCopyIdentity,configuredShopifySyncMode,configuredSyncCanarySku,
    isSafeShopifyProductHandle,isSyncCanarySku,matchExactSkus,normalizeSyncSku,numericVariantId,shopifyProductGid,staleBindingKeys} from '${rulesUrl}';
  import {readVerifiedCopyEligibility} from '${eligibilityUrl}';
  import {isSyncReviewCode,mergeVisibleProductCopy,visibleCopiesEquivalent} from '${policyUrl}';
  export function createWorker(provider) {
    const {fetchProductSnapshot,visibleCopyFromProduct,writeShopifyVisibleCopy}=provider;
    ${workerSource}
    return {mergeAndPersist};
  }
`));
const fixed = { h, policy, admin, worker };
const compact = '<p>Bag.</p>\n<ul><li>Height 55 cm.</li><li>Weight 2.4 kg.</li></ul>';
const pretty = '<p>Bag.</p>\n<ul>\n<li>Height 55 cm.</li>\n<li>Weight 2.4 kg.</li>\n</ul>';
const copy = (html, document = h) => ({title:'Bag',description:document.descriptionTextFromHtml(html),descriptionHtml:html,seoTitle:'SEO',seoDescription:'Snippet'});

function fixture(api, { simultaneousSeo = false, alreadyCommitted = false, returnedHtml = pretty } = {}) {
  const productId='gid://shopify/Product/123',variantId='gid://shopify/ProductVariant/456';
  const itemId='00000000-0000-4000-8000-000000000001',sku='NEW001',stamp='2026-09-30T10:00:00.000Z';
  const baseline=copy('<p>Old rich copy.</p>',api.h),changed=copy(compact,api.h);
  const approval={product_gid:productId,variant_gid:variantId,carousel_item_id:itemId,catalog_key:sku,
    exact_gallery_sku:sku,exact_shopify_sku:sku,approved_product_handle:'bag',enabled:true,approval_id:'reviewed-v1',
    approved_source_updated_at:stamp,alias_evidence:{type:'exact'},allowed_fields:['title','description','seoTitle','seoDescription']};
  const binding={catalog_key:sku,carousel_item_id:itemId,product_gid:productId,variant_gid:variantId,product_handle:'bag',is_published:true,source_updated_at:stamp};
  const gallery={id:itemId,catalog_number:sku,title:changed.title,description:changed.description,description_html:changed.descriptionHtml,
    seo_title:changed.seoTitle,seo_description:changed.seoDescription,copy_updated_at:'2026-09-30T10:01:00.000Z'};
  const state={last_synced_payload:structuredClone(baseline),gallery_baseline_payload:structuredClone(baseline),shopify_baseline_payload:structuredClone(baseline)};
  let product={id:productId,handle:'bag',status:'ACTIVE',publishedOnPublication:true,variants:[{id:variantId,sku}],updatedAt:stamp,
    ...(alreadyCommitted?copy(pretty,api.h):baseline)};
  if(simultaneousSeo)product.seoDescription='Shopify SEO edit';
  const writes=[],galleryWrites=[],stateWrites=[];
  const db={from(table){let patch;const query={select(){return query;},eq(){return query;},limit(){return query;},update(value){patch=value;return query;},
    async upsert(){assert.equal(table,'shopify_gallery_sync_conflicts');return {error:null};},
    async maybeSingle(){return {data:result(),error:null};},then(resolve){return Promise.resolve({data:result(),error:null}).then(resolve);}};
    const result=()=>{
      if(table==='shopify_gallery_copy_eligibility')return [structuredClone(approval)];
      if(table==='shopify_gallery_bindings')return [structuredClone(binding)];
      if(table==='carousel_items')return structuredClone(gallery);
      assert.equal(table,'shopify_gallery_sync_state');
      if(patch){Object.assign(state,structuredClone(patch));stateWrites.push(structuredClone(patch));return {catalog_key:sku};}
      return structuredClone(state);
    };return query;},async rpc(name,args){
      assert.equal(args.p_lease_owner,'owner');assert.equal(args.p_expected_version,gallery.copy_updated_at);
      if(name==='assert_shopify_verified_copy_write')return {data:true,error:null};
      assert.equal(name,'apply_shopify_verified_copy');galleryWrites.push(structuredClone(args.p_copy));
      Object.assign(gallery,{title:args.p_copy.title,description:args.p_copy.description,description_html:args.p_copy.descriptionHtml,
        seo_title:args.p_copy.seoTitle,seo_description:args.p_copy.seoDescription,copy_updated_at:'2026-09-30T10:03:00.000Z'});
      return {data:{copyUpdatedAt:gallery.copy_updated_at},error:null};
    }};
  const worker=api.worker.createWorker({
    async fetchProductSnapshot(){return structuredClone(product);},
    visibleCopyFromProduct:api.admin.visibleCopyFromProduct,
    async writeShopifyVisibleCopy(id,desired,current){
      const patch=api.admin.buildShopifyVisibleCopyInput(id,desired,current);writes.push(patch);
      product={...product,...structuredClone(desired),descriptionHtml:returnedHtml,description:api.h.descriptionTextFromHtml(returnedHtml),updatedAt:'2026-09-30T10:02:00.000Z'};
    },
  });
  return {gallery,state,writes,galleryWrites,stateWrites,product:()=>structuredClone(product),
    run:()=>worker.mergeAndPersist(db,binding,structuredClone(product),structuredClone(gallery),{approval,leaseOwner:'owner'})};
}

test('candidate accepts only list formatting and retains raw per-side pairs without a second write',async()=>{
  const f=fixture(fixed);await f.run();
  assert.equal(f.writes.length,1);assert.equal(f.galleryWrites.length,0);assert.equal(f.stateWrites.length,1);
  assert.equal(f.state.shopify_baseline_payload.descriptionHtml,pretty);
  assert.equal(f.state.gallery_baseline_payload.descriptionHtml,compact);
  assert.equal(f.state.gallery_baseline_payload.description,fixed.h.descriptionTextFromHtml(compact));
  assert.equal(f.state.shopify_baseline_payload.description,fixed.h.descriptionTextFromHtml(pretty));
  await f.run();assert.equal(f.writes.length,1);assert.equal(f.galleryWrites.length,0);
});

test('candidate survives immediate pre-Gallery check for disjoint simultaneous edits',async()=>{
  const f=fixture(fixed,{simultaneousSeo:true});await f.run();
  assert.equal(f.writes.length,1);assert.equal(f.galleryWrites.length,1);
  assert.equal(f.gallery.seo_description,'Shopify SEO edit');
  assert.equal(f.gallery.description_html,compact);assert.equal(f.product().descriptionHtml,pretty);
});

test('retry after an uncertain accepted write creates no repeated mutation or false conflict',async()=>{
  const f=fixture(fixed,{alreadyCommitted:true});await f.run();
  assert.equal(f.writes.length,0);assert.equal(f.galleryWrites.length,0);assert.equal(f.stateWrites.length,1);
});

test('Shopify patch builder emits no body for equivalent pairs but retains exact mutation pair validation',()=>{
  const target={id:'gid://shopify/Product/1',...copy(pretty)};
  assert.deepEqual(fixed.admin.buildShopifyVisibleCopyInput(target.id,copy(compact),target),{id:target.id});
  assert.throws(()=>fixed.admin.buildShopifyVisibleCopyInput(target.id,{...copy(compact),description:'Different'},target),/PAIR_MISMATCH/);
  const malicious=copy('<script>bad()</script>');
  assert.throws(()=>fixed.admin.buildShopifyVisibleCopyInput(target.id,malicious,target),/UNSAFE/);
});

test('formatting-only source refresh does not win over an independently changed opposing description',()=>{
  const baseline=copy(compact),formatted=copy(pretty),changed=copy('<p>Genuine Gallery change</p>');
  const merged=fixed.policy.mergeVisibleProductCopy(changed,formatted,baseline,'2026-09-30T10:01:00Z','2026-09-30T10:02:00Z',baseline,baseline);
  assert.equal(merged.shopifyCopy.descriptionHtml,changed.descriptionHtml);assert.deepEqual(merged.conflicts,[]);
});

test('current exact extractor output is unchanged; malformed or legacy text is not normalized away',()=>{
  assert.equal(fixed.h.descriptionTextFromHtml(compact),'Bag.\n\nHeight 55 cm.\nWeight 2.4 kg.');
  assert.equal(fixed.h.descriptionTextFromHtml(pretty),'Bag.\n\nHeight 55 cm.\n\nWeight 2.4 kg.');
  assert.notEqual(copy(compact).description,copy(pretty).description);
  assert.equal(fixed.policy.visibleCopiesEquivalent(copy(compact),copy(pretty)),true);
  assert.equal(fixed.policy.visibleCopiesEquivalent({...copy(compact),description:'Unpaired'},copy(pretty)),false);
  assert.equal(fixed.policy.visibleCopiesEquivalent({description:'A B',title:'T',seoTitle:null,seoDescription:null},
    {description:'AB',title:'T',seoTitle:null,seoDescription:null}),false);
});

for(const [label,left,right] of [
  ['inline word separator','<p><b>A</b> <i>B</i></p>','<p><b>A</b><i>B</i></p>'],
  ['ordinary text spacing','<p>A B</p>','<p>AB</p>'],
  ['pre contents','<pre>A\n B</pre>','<pre>A B</pre>'],
  ['code contents','<code>A  B</code>','<code>A B</code>'],
  ['paragraph boundary','<p>A</p><p>B</p>','<p>AB</p>'],
  ['paragraph order','<p>A</p><p>B</p>','<p>B</p><p>A</p>'],
  ['list order','<ul><li>A</li><li>B</li></ul>','<ul><li>B</li><li>A</li></ul>'],
  ['list count','<ul><li>A</li></ul>','<ul><li>A</li><li></li></ul>'],
  ['list type','<ul><li>A</li></ul>','<ol><li>A</li></ol>'],
  ['attribute target','<ul><li><a href="/a">A</a></li></ul>','<ul><li><a href="/b">A</a></li></ul>'],
  ['non-ASCII list spacing','<ul><li>A</li></ul>','<ul>\u00a0<li>A</li></ul>'],
  ['list item interior spaces','<ul><li>A</li></ul>','<ul><li> A</li></ul>'],
  ['whitespace CSS','<ul style="white-space: pre"><li>A</li></ul>','<ul style="white-space: pre">\n<li>A</li>\n</ul>'],
  ['external CSS hook','<div class="preserve"><ul><li>A</li></ul></div>','<div class="preserve"><ul>\n<li>A</li>\n</ul></div>'],
])test(`comparison preserves ${label}`,()=>assert.equal(fixed.policy.visibleCopiesEquivalent(copy(left),copy(right)),false));

test('real content drift in Shopify response still fails readback without saving baselines',async()=>{
  const f=fixture(fixed,{returnedHtml:pretty.replace('2.4','2.5')});
  await assert.rejects(f.run(),/SYNC_COPY_READBACK_MISMATCH/);
  assert.equal(f.stateWrites.length,0);
});

test('ordered-list formatting and attribute serialization preserve exact list semantics',()=>{
  assert.equal(fixed.policy.visibleCopiesEquivalent(copy('<ol start="3"><li>A &amp; B</li><li>C</li></ol>'),
    copy("<ol start='3'>\n<li>A &#38; B</li>\n<li>C</li>\n</ol>")),true);
});
