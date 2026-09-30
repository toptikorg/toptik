import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const coreUrl=moduleUrl(readFileSync(new URL('../src/lib/shopify/typed-spec-core.ts',import.meta.url),'utf8')),core=await import(coreUrl);
const api=await import(moduleUrl(readFileSync(new URL('../src/lib/shopify/typed-spec-state-adapter.ts',import.meta.url),'utf8').replace('"./typed-spec-core"',JSON.stringify(coreUrl))));
const base=()=>({productGid:'gid://shopify/Product/1',leaseOwner:'22222222-2222-4222-8222-222222222222',requestId:'33333333-3333-4333-8333-333333333333',mode:'initialize',fieldKeys:[...core.SPEC_KEYS],expectedVersions:{},evidence:{evidenceId:'readback-1',raw:{unchanged:'מקור'}},baselines:{gallery:{fields:Object.fromEntries(core.SPEC_KEYS.map(k=>[k,core.absent()]))},shopify:{fields:Object.fromEntries(core.SPEC_KEYS.map(k=>[k,core.absent()]))}}});
test('state builder preserves complete independent19-field baselines and raw evidence',()=>{
 const input=base(),result=api.buildSpecStatePersistence(input);assert.equal(result.rpc,'persist_toptik_spec_state');assert.equal(result.args.p_changes.length,19);assert.deepEqual(result.args.p_evidence,input.evidence);
 assert.ok(result.args.p_changes.every(x=>Object.hasOwn(x,'expectedVersion')&&x.expectedVersion===null));
 assert.throws(()=>api.buildSpecStatePersistence({...input,fieldKeys:['material']}),/COMPLETE_BASELINE/);
 delete input.baselines.gallery.fields.material;assert.throws(()=>api.buildSpecStatePersistence(input),/BASELINE_REQUIRED/);
});
test('state builder requires own positive safe per-field CAS version and exact changed fields',()=>{
 const input={...base(),mode:'verified_readback',fieldKeys:['material'],expectedVersions:{material:4}};
 assert.equal(api.buildSpecStatePersistence(input).args.p_changes[0].expectedVersion,4);
 for(const expectedVersions of [{},{material:undefined},{material:0},{material:-1},{material:1.1},{material:9007199254740992},{material:4,net_weight:1},Object.create({material:4})])assert.throws(()=>api.buildSpecStatePersistence({...input,expectedVersions}),/VERSIONS/);
 assert.throws(()=>api.buildSpecStatePersistence({...input,evidence:{evidenceId:'proof',raw:{bad:undefined}}}),/NOT_JSON/);
});
