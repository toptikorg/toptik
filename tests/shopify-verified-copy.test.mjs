import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { z } from "zod";
import { descriptionModuleUrl, descriptionHelpers } from "./helpers/description-module.mjs";

const url = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
const vendor = url(readFileSync("src/lib/catalog-source/vendor-detect.ts", "utf8"));
const rulesUrl = url(readFileSync("src/lib/shopify/sync-rules.ts", "utf8").replace('"@/lib/catalog-source/vendor-detect"', JSON.stringify(vendor)));
const rules = await import(rulesUrl);
const policyUrl = url(readFileSync("src/lib/shopify/sync-policy.ts", "utf8").replace('"./description-document"', JSON.stringify(descriptionModuleUrl)));
const eligibilityUrl = url(readFileSync("src/lib/shopify/copy-eligibility.ts", "utf8"));
const { readVerifiedCopyEligibility } = await import(eligibilityUrl);
const workerSource = stripTypeScriptTypes(readFileSync("src/lib/shopify/sync-worker.ts", "utf8")).replace(/^import[\s\S]*?;\r?\n/gm, "");
const workerModule = await import(url(`
  import { createHash, randomUUID } from 'node:crypto';
  import { assertVerifiedCopyApproval, assertVerifiedCopyIdentity, configuredShopifySyncMode, configuredSyncCanarySku,
    isSafeShopifyProductHandle, isSyncCanarySku, matchExactSkus, normalizeSyncSku, numericVariantId, shopifyProductGid, staleBindingKeys } from '${rulesUrl}';
  import { readVerifiedCopyEligibility } from '${eligibilityUrl}';
  import { isSyncReviewCode, mergeVisibleProductCopy, visibleCopiesEquivalent } from '${policyUrl}';
  export function createWorker(provider) {
    const {fetchProductSnapshot, visibleCopyFromProduct, writeShopifyVisibleCopy} = provider;
    ${workerSource.replace(/^export /gm, "")}
    return {reconcileInboxEvent,reconcileOutboxRow,mergeAndPersist,processShopifySyncQueues,processQueue};
  }
`));
const itemId = "00000000-0000-4000-8000-000000000001";
const gallerySku = "P10SZV24-05J-TU", storeSku = "P10SZV2405J";
const stamp = "2026-09-30T12:00:00.000Z";
const copy = (title, body) => ({ title, description: body, descriptionHtml: `<p>${body}</p>`, seoTitle: "SEO", seoDescription: "SEO description" });

function fixture(options = {}) {
  const approval = { product_gid: "gid://shopify/Product/123", variant_gid: "gid://shopify/ProductVariant/456",
    carousel_item_id: itemId, catalog_key: "P10SZV2405J", exact_gallery_sku: gallerySku, exact_shopify_sku: storeSku,
    approved_product_handle: "logoduck-i-טרולי", enabled: true, approval_id: "reviewed-78-v1",
    approved_source_updated_at: stamp, alias_evidence: { type: "explicit_reviewed_pair", source: "exact admin evidence" },
    allowed_fields: ["title", "description", "seoTitle", "seoDescription"], ...options.approval };
  const binding = { catalog_key: approval.catalog_key, carousel_item_id: itemId, product_gid: approval.product_gid,
    variant_gid: approval.variant_gid, product_handle: approval.approved_product_handle, is_published: true, source_updated_at: stamp };
  const galleryBase = copy("Gallery original", "Gallery body"), shopBase = copy("Shop original", "Shop body");
  const gallery = { id: itemId, catalog_number: gallerySku, title: galleryBase.title, description: galleryBase.description,
    description_html: galleryBase.descriptionHtml, seo_title: "SEO", seo_description: "SEO description", copy_updated_at: stamp,
    ...options.gallery };
  let product = { id: binding.product_gid, variants: [{id:binding.variant_gid,sku:storeSku}], handle: binding.product_handle,
    status: "ACTIVE", publishedOnPublication: true, updatedAt: stamp, copy: { ...shopBase }, ...options.product };
  const state = options.noBaseline ? null : { last_synced_payload: { ...shopBase }, gallery_baseline_payload: { ...galleryBase }, shopify_baseline_payload: { ...shopBase } };
  const calls = [], writes = []; let reads = 0;
  const db = {
    from(table) {
      const filters = {}; let patch;
      const result = () => {
        if (table === "shopify_gallery_copy_eligibility") return options.unapproved ? [] : [{ ...approval }];
        if (table === "shopify_gallery_bindings") return [binding];
        if (table === "carousel_items") return { ...gallery };
        if (table === "shopify_gallery_sync_state") {
          if (patch) { calls.push({ table, patch }); return { catalog_key: binding.catalog_key }; }
          return state;
        }
        if (["shopify_webhook_events", "shopify_gallery_content_outbox"].includes(table)) {
          assert.ok(patch); calls.push({table,patch}); return null;
        }
        if (table === "shopify_gallery_sync_conflicts") return null;
        assert.fail(`unexpected table ${table}`);
      };
      const query = { select() {return query;}, eq(key,value) {filters[key]=value;return query;}, limit() {return query;},
        update(value) {patch=value;return query;},
        async upsert(value) { assert.equal(table,"shopify_gallery_sync_conflicts"); calls.push({table,patch:value}); return {error:null}; },
        async maybeSingle() {const data=result(); return {data:Array.isArray(data)?data[0]??null:data,error:null};},
        then(resolve) {return Promise.resolve({data:result(),error:null}).then(resolve);},
      }; return query;
    },
    async rpc(name,args) {
      calls.push({name,args});
      if(name==="assert_shopify_verified_copy_write"){
        assert.equal(args.p_lease_owner,"lease-owner");
        return {data:!options.leaseDenied,error:null};
      }
      assert.equal(name,"apply_shopify_verified_copy");
      assert.equal(args.p_lease_owner,"lease-owner");
      Object.assign(gallery,{title:args.p_copy.title,description:args.p_copy.description,description_html:args.p_copy.descriptionHtml,
        seo_title:args.p_copy.seoTitle,seo_description:args.p_copy.seoDescription,copy_updated_at:"2026-09-30T12:02:00.000Z"});
      return {data:{copyUpdatedAt:gallery.copy_updated_at},error:null};
    },
  };
  const worker = workerModule.createWorker({
    async fetchProductSnapshot() { reads++; if(options.onRead) options.onRead(reads,product,approval,gallery,binding); return structuredClone(product); },
    visibleCopyFromProduct: value=>value.copy,
    async writeShopifyVisibleCopy(id,desired,expected) {writes.push({id,desired,expected}); product={...product,copy:structuredClone(desired)};},
  });
  return {db,worker,approval,binding,gallery,product:()=>structuredClone(product),calls,writes,reads:()=>reads};
}
async function verified(action) {
  const old=process.env.SHOPIFY_SYNC_MODE;
  process.env.SHOPIFY_SYNC_MODE="verified_catalog";
  try {return await action();} finally {if(old===undefined)delete process.env.SHOPIFY_SYNC_MODE;else process.env.SHOPIFY_SYNC_MODE=old;}
}

test("rollout mode is explicit and malformed settings never enable catalog sync", async () => {
  assert.equal(rules.configuredShopifySyncMode(undefined),"canary");
  assert.equal(rules.configuredShopifySyncMode("verified_catalog"),"verified_catalog");
  for(const bad of ["all","true","verified_catalog,canary"," VERIFIED_CATALOG "]) assert.equal(rules.configuredShopifySyncMode(bad),"disabled");
  const oldMode=process.env.SHOPIFY_SYNC_MODE, oldSku=process.env.SHOPIFY_SYNC_CANARY_SKU;
  delete process.env.SHOPIFY_SYNC_MODE; delete process.env.SHOPIFY_SYNC_CANARY_SKU;
  try {await assert.rejects(()=>fixture().worker.processShopifySyncQueues({rpc(){assert.fail("no queue claim");}}),/CANARY_NOT_CONFIGURED/);}
  finally {if(oldMode!==undefined)process.env.SHOPIFY_SYNC_MODE=oldMode;if(oldSku!==undefined)process.env.SHOPIFY_SYNC_CANARY_SKU=oldSku;}
});

test("explicit reviewed aliases pass; fuzzy equivalents and absent provenance do not", () => {
  const f=fixture();
  assert.doesNotThrow(()=>rules.assertVerifiedCopyIdentity(f.approval,f.binding,f.gallery,f.product()));
  assert.throws(()=>rules.assertVerifiedCopyIdentity({...f.approval,alias_evidence:{}},f.binding,f.gallery,f.product()),/NOT_APPROVED/);
  for(const sku of [gallerySku,"P10SZV24-05J","p10szv2405j"]){const p=f.product();p.variants[0].sku=sku;
    assert.throws(()=>rules.assertVerifiedCopyIdentity(f.approval,f.binding,f.gallery,p),/IDENTITY_CONFLICT/);}
  assert.throws(()=>rules.assertVerifiedCopyIdentity(f.approval,f.binding,{...f.gallery,catalog_number:storeSku},f.product()),/IDENTITY_CONFLICT/);
});

test("unapproved, disabled and deleted products never fetch or create catalog/baseline data", async () => verified(async()=>{
  for(const options of [{unapproved:true},{approval:{enabled:false}},{approval:{allowed_fields:["price"]}}]){
    const f=fixture(options);
    await assert.rejects(()=>f.worker.reconcileInboxEvent(f.db,{id:"e",topic:"products/create"},f.binding.product_gid,"lease-owner"),/NOT_APPROVED/);
    assert.equal(f.reads(),0);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  }
  const f=fixture();
  await assert.rejects(()=>f.worker.reconcileInboxEvent(f.db,{id:"e",topic:"products/delete"},f.binding.product_gid,"lease-owner"),/DELETE_DISABLED/);
  assert.equal(f.reads(),0);assert.equal(f.calls.length,0);
}));

test("verified preexisting independent baselines do not overwrite either original copy",async()=>verified(async()=>{
  const f=fixture();
  await f.worker.reconcileInboxEvent(f.db,{id:"e",topic:"products/update"},f.binding.product_gid,"lease-owner");
  assert.equal(f.writes.length,0);assert.equal(f.calls.filter(c=>c.name).length,0);
  assert.equal(f.gallery.title,"Gallery original");assert.equal(f.product().copy.title,"Shop original");
  assert.ok(f.calls.some(c=>c.table==="shopify_gallery_sync_state"));
  const missing=fixture({noBaseline:true});
  await assert.rejects(()=>missing.worker.reconcileInboxEvent(missing.db,{id:"e",topic:"products/update"},missing.binding.product_gid,"lease-owner"),/BASELINE_REQUIRED/);
  assert.equal(missing.writes.length,0);assert.equal(missing.calls.length,0);
}));

test("approved Gallery edit writes only copy and preserves independent rich descriptions",async()=>verified(async()=>{
  const f=fixture({gallery:{seo_title:"Edited Gallery SEO"}});
  await f.worker.reconcileOutboxRow(f.db,{id:"o",catalog_key:f.approval.catalog_key,payload:copy("irrelevant stale queue","old")},f.binding,"lease-owner");
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].desired.seoTitle,"Edited Gallery SEO");
  assert.equal(f.writes[0].desired.descriptionHtml,"<p>Shop body</p>");
  assert.equal(f.gallery.description_html,"<p>Gallery body</p>");
  assert.equal(f.calls.filter(c=>c.name==="apply_shopify_verified_copy").length,0,"no Gallery write for Shopify-only change");
  assert.equal(f.calls.filter(c=>c.name==="assert_shopify_verified_copy_write").length,1,"lease owner checked before Shopify mutation");
}));

test("approved Shopify edit uses lease-owned approval+CAS SQL without echo outbox",async()=>verified(async()=>{
  const f=fixture({product:{copy:{...copy("Shop original","Changed Shopify body"),seoTitle:"SEO"}}});
  await f.worker.reconcileInboxEvent(f.db,{id:"e",topic:"products/update"},f.binding.product_gid,"lease-owner");
  assert.equal(f.writes.length,0);
  const applied=f.calls.find(c=>c.name==="apply_shopify_verified_copy");assert.ok(applied);
  assert.equal(applied.args.p_exact_sku,gallerySku);assert.equal(applied.args.p_exact_shopify_sku,storeSku);
  assert.equal(f.gallery.description_html,"<p>Changed Shopify body</p>");
  assert.ok(f.calls.every(c=>c.table!=="shopify_gallery_content_outbox"));
}));

test("late exact SKU, variant, product, Gallery identity or approval changes stop Shopify writes",async()=>verified(async()=>{
  for(const change of [
    (p)=>{p.variants[0].sku=gallerySku;},
    (p)=>{p.variants[0].id="gid://shopify/ProductVariant/999";},
    (p)=>{p.id="gid://shopify/Product/999";},
    (p)=>{p.variants.push({...p.variants[0]});},
    (_p,a)=>{a.enabled=false;},
    (_p,_a,g)=>{g.catalog_number=storeSku;},
    (_p,_a,_g,b)=>{b.product_handle="unexpected";},
  ]){
    const f=fixture({gallery:{seo_title:"Edited SEO"},onRead:(n,...args)=>{if(n===2)change(...args);}});
    await assert.rejects(()=>f.worker.reconcileOutboxRow(f.db,{id:"o",catalog_key:f.approval.catalog_key,payload:copy("old","old")},f.binding,"lease-owner"),/IDENTITY_CONFLICT|NOT_APPROVED/);
    assert.equal(f.writes.length,0);assert.equal(f.calls.filter(c=>c.name).length,0);
  }
}));

test("lost product lease blocks external Shopify mutation",async()=>verified(async()=>{
  const f=fixture({gallery:{seo_title:"Edited SEO"},leaseDenied:true});
  await assert.rejects(()=>f.worker.reconcileOutboxRow(f.db,{id:"o",catalog_key:f.approval.catalog_key,payload:copy("old","old")},f.binding,"lease-owner"),/NOT_APPROVED/);
  assert.equal(f.writes.length,0);
}));

const patchSource=readFileSync("src/app/api/admin/shopify/copy/route.ts","utf8");
const patchBody=patchSource.slice(patchSource.indexOf("const patchSchema")).replace(/^export /gm,"");
const {makePatch}=await import(url(`export function makePatch(deps){
  const {z,requireAdminToken,createSupabaseServiceRoleClient,fetchProductSnapshot,scheduleShopifySync,
    assertSafeDescriptionHtml,descriptionTextFromHtml,plainDescriptionToHtml,configuredShopifySyncMode,
    configuredSyncCanarySku,normalizeSyncSku,readVerifiedCopyEligibility,assertVerifiedCopyApproval,assertVerifiedCopyIdentity}=deps;
  const NextResponse={json:(body,options)=>Response.json(body,options)};
  const hasSupabaseAdminEnv=()=>true,isShopifySyncConfigured=()=>true;
  ${patchBody}
  return PATCH;
}`));

test("narrow verified PATCH accepts only explicitly paired alias and calls verified RPC",async()=>verified(async()=>{
  const f=fixture();let scheduled=0;const calls=[];
  f.db.rpc=async(name,args)=>{calls.push({name,args});return {data:{changed:true,copyUpdatedAt:stamp},error:null};};
  const patch=makePatch({z,...rules,...descriptionHelpers,readVerifiedCopyEligibility,requireAdminToken:()=>null,
    createSupabaseServiceRoleClient:()=>f.db,fetchProductSnapshot:async()=>f.product(),scheduleShopifySync:()=>{scheduled++;}});
  const response=await patch(new Request("https://example.test/copy",{method:"PATCH",body:JSON.stringify({itemId,productId:f.binding.product_gid,sku:gallerySku,copyUpdatedAt:stamp,patch:{seoTitle:"New SEO"}})}));
  assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].name,"patch_shopify_verified_copy");
  assert.equal(calls[0].args.p_exact_shopify_sku,storeSku);assert.equal(calls[0].args.p_exact_sku,gallerySku);assert.equal(scheduled,1);
}));

test("verified drain claims one row per queue and does not claim after time reserve",async()=>verified(async()=>{
  const calls=[];const db={async rpc(name,args){calls.push({name,args});return {data:[],error:null};}};
  const worker=fixture().worker;
  await worker.processShopifySyncQueues(db,Date.now()+45_000);
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.args.p_limit===1));
  await worker.processShopifySyncQueues(db,Date.now()+5_000);
  assert.equal(calls.length,2,"leave unclaimed rows available for another invocation");
}));
