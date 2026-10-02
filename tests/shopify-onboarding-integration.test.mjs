import { variantPolicySource } from "./helpers/variant-source-module.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = stripTypeScriptTypes(readFileSync("src/lib/shopify/sync-worker.ts", "utf8"))
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
const encoded = Buffer.from(`
  export function makeWorker(deps) {
  ${variantPolicySource}
    const { readVerifiedCopyEligibility, ensurePublicShopifyOnboarding } = deps;
    function configuredShopifySyncMode(value) { return value === 'verified_catalog' ? value : 'disabled'; }
    function assertVerifiedCopyApproval(approval) { if (!approval?.enabled) throw new Error('SYNC_COPY_NOT_APPROVED'); }
    ${source}
    return { reconcileInboxEvent };
  }
`).toString("base64");
const { makeWorker } = await import(`data:text/javascript;base64,${encoded}`);

function fixture({ approval = null, admitted = true, admissionError = null, finalizeError = null } = {}) {
  const calls = [];
  const db = { from(table) { assert.equal(table, "shopify_webhook_events"); return {
    update(patch) { return { async eq(key, id) { calls.push({table,patch,key,id}); return {error:finalizeError}; } }; },
  }; } };
  const worker = makeWorker({
    async readVerifiedCopyEligibility() { return approval; },
    async ensurePublicShopifyOnboarding(database, input) {
      assert.equal(database, db); calls.push({admission: input});
      if (admissionError) throw new Error(admissionError);
      return admitted;
    },
  });
  return { db, calls, worker };
}

async function withMode(flag, body) {
  const before = {mode:process.env.SHOPIFY_SYNC_MODE, flag:process.env.SHOPIFY_SYNC_AUTOCREATE};
  process.env.SHOPIFY_SYNC_MODE = "verified_catalog";
  if (flag === undefined) delete process.env.SHOPIFY_SYNC_AUTOCREATE;
  else process.env.SHOPIFY_SYNC_AUTOCREATE = flag;
  try { await body(); } finally {
    for (const [key,value] of [["SHOPIFY_SYNC_MODE",before.mode],["SHOPIFY_SYNC_AUTOCREATE",before.flag]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const event = {id:"event-1",topic:"products/create",payload:{id:123}};

for (const admitted of [true,false]) test(`new Shopify event ${admitted ? "admitted" : "explicitly excluded"} is finalized without a second copy merge`, async () => {
  await withMode("published_shopify",async () => {
    const f = fixture({admitted});
    const result = await f.worker.reconcileInboxEvent(f.db,event,"gid://shopify/Product/123","lease-owner",45000);
    assert.equal(result,"processed");
    assert.deepEqual(f.calls[0],{admission:{eventId:event.id,productGid:"gid://shopify/Product/123",leaseOwner:"lease-owner",deadline:45000}});
    assert.equal(f.calls.length,2);
    assert.equal(f.calls[1].patch.status,"processed");
    assert.equal(f.calls[1].id,event.id);
  });
});

for (const flag of [undefined,"true","all"]) test(`admission stays off for flag ${String(flag)}`,async () => {
  await withMode(flag,async () => {
    const f=fixture();
    await assert.rejects(f.worker.reconcileInboxEvent(f.db,event,"gid://shopify/Product/123","owner",45000),/SYNC_COPY_NOT_APPROVED/);
    assert.equal(f.calls.length,0);
  });
});

test("deletion events and disabled existing approvals cannot become new admission",async () => {
  await withMode("published_shopify",async () => {
    for (const options of [{approval:null,topic:"products/delete"},{approval:{enabled:false},topic:"products/update"}]) {
      const f=fixture(options);
      await assert.rejects(f.worker.reconcileInboxEvent(f.db,{...event,topic:options.topic},"gid://shopify/Product/123","owner",45000),/SYNC_COPY_NOT_APPROVED/);
      assert.equal(f.calls.length,0);
    }
  });
});

test("failed admission is not acknowledged and ambiguous finalization remains retryable",async () => {
  await withMode("published_shopify",async () => {
    const f=fixture({admissionError:"SYNC_ONBOARDING_SOURCE_CHANGED"});
    await assert.rejects(f.worker.reconcileInboxEvent(f.db,event,"gid://shopify/Product/123","owner",45000),/SYNC_ONBOARDING_SOURCE_CHANGED/);
    assert.equal(f.calls.length,1);
    const uncertain=fixture({finalizeError:{message:"offline"}});
    await assert.rejects(uncertain.worker.reconcileInboxEvent(uncertain.db,event,"gid://shopify/Product/123","owner",45000),/SYNC_EVENT_FINALIZE_FAILED/);
  });
});
