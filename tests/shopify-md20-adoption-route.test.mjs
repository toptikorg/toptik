import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {z} from 'zod';
const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const policy=await import(url(readFileSync('src/lib/shopify/variant-source-policy.ts','utf8')));
const route=stripTypeScriptTypes(readFileSync('src/app/api/admin/shopify/md20/adoption/route.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const {make}=await import(url(`export function make(deps){const {randomUUID,NextResponse,z,requireAdminToken,createSupabaseServiceRoleClient,md20SourceProjection,readMd20Snapshot,sameMd20Source,MD20_PRODUCT_GID,MD20_VARIANTS,exactVariantMedia,verifyOnboardingImage}=deps;${route};return POST;}`));
const id=policy.MD20_VARIANTS[0].itemId,sku=policy.MD20_VARIANTS[0].sku,variant='gid://shopify/ProductVariant/'+policy.MD20_VARIANTS[0].variantId;
const approval='11111111-1111-4111-8111-111111111111',outboxId='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64);
const approvalEvidence={approvedBy:'Tal',approvedAt:'2026-11-09T12:30:00Z',reviewReference:'local-test-only'};
function fixture(){
  const source={status:'ACTIVE',publishedOnPublication:true,title:'source',media:[]},p={title:'source',description:'text',description_html:'<p>text</p>',seo_title:null,seo_description:null,cover_image_path:'image',cover_image_alt:'alt',angles:[{angle_key:'1',angle_order:1,image_path:'image',image_alt:'alt'}]};
  const tables={carousel_items:[{id,catalog_number:sku,is_active:true,copy_updated_at:'2026-11-09T12:00:00Z',editor_revision:1,...p,title:'old'}],
    carousel_item_angles:p.angles.map(a=>({...a,item_id:id})),shopify_gallery_bindings:[{carousel_item_id:id,catalog_key:sku,product_gid:policy.MD20_PRODUCT_GID,variant_gid:variant,is_published:true}]};
  const calls=[],state={source,prior:null,busy:false,snapshots:0,afterCommitDrift:false,denied:false};
  const db={from(name){const q={select(){return q},in(k,values){return Promise.resolve({data:structuredClone((tables[name]??[]).filter(r=>values.includes(r[k]))),error:null})}};return q},
    async rpc(name,args){calls.push({name,args});if(name==='acquire_shopify_reconciliation_lease')return {data:!state.busy,error:null};
      if(name==='release_shopify_reconciliation_lease')return {data:true,error:null};
      if(name==='read_md20_unresolved_outbox')return {data:[{id:outboxId,contentHash:hash,createdAt:'2026-11-09T11:00:00Z',status:'review',payload:{},decision:null}],error:null};
      if(name==='fingerprint_md20_adoption_manifest')return {data:hash,error:null};if(name==='read_md20_adoption_receipt')return {data:state.prior,error:null};
      if(name==='resolve_md20_source_adoption'){state.prior={status:'adopted'};return {data:state.prior,error:null};}throw Error(name)}};
  const deps={...policy,z,randomUUID:()=>approval,NextResponse:{json:(body,options={})=>({body,status:options.status??200})},
    requireAdminToken:()=>state.denied?{body:{error:'unauthorized'},status:401}:null,createSupabaseServiceRoleClient:()=>db,
    md20SourceProjection:s=>({...p,title:s.title}),readMd20Snapshot:async()=>{state.snapshots++;return {...state.source,title:state.afterCommitDrift&&state.prior?'changed':state.source.title}},
    sameMd20Source:(a,b)=>JSON.stringify(a)===JSON.stringify(b),exactVariantMedia:()=>[],verifyOnboardingImage:async()=>{}};
  return {state,calls,deps,request:body=>({text:async()=>JSON.stringify(body)}),post:body=>make(deps)({text:async()=>JSON.stringify(body)})};
}
test('requires administrator before reading or mutating anything',async()=>{const f=fixture();f.state.denied=true;const r=await f.post({action:'prepare',itemIds:[id]});assert.equal(r.status,401);assert.equal(f.calls.length,0);});
test('manifest exposes unsent edit and requires explicit discarded decision',async()=>{
  const f=fixture(),r=await f.post({action:'prepare',itemIds:[id]});assert.equal(r.status,200);assert.equal(r.body.approved,false);assert.equal(r.body.ready,false);
  assert.equal(r.body.manifest.entries[0].before.title,'old');assert.equal(r.body.manifest.entries[0].projection.title,'source');assert.equal(r.body.manifest.entries[0].outbox[0].decision,null);
  const rejected=await f.post({action:'adopt',approvalId:approval,approvalEvidence,manifestHash:hash,manifest:r.body.manifest});assert.equal(rejected.status,400);assert.ok(!f.calls.some(c=>c.name==='resolve_md20_source_adoption'));
});
test('prepare rejects duplicate colors and unknown requested outbox IDs',async()=>{
  const f=fixture();const a=await f.post({action:'prepare',itemIds:[id,id]});assert.equal(a.body.error,'SYNC_MD20_IDENTITY_INVALID');
  const b=await f.post({action:'prepare',itemIds:[id],discardOutboxIds:[approval]});assert.equal(b.body.error,'SYNC_MD20_OUTBOX_CHANGED');
  assert.ok(!f.calls.some(c=>c.name==='resolve_md20_source_adoption'));
});
test('explicitly selected outbox is sent to atomic RPC only after source revalidation',async()=>{
  const f=fixture(),r=await f.post({action:'prepare',itemIds:[id],discardOutboxIds:[outboxId]});assert.equal(r.body.ready,true);
  const noEvidence=await f.post({action:'adopt',approvalId:approval,manifestHash:hash,manifest:r.body.manifest});assert.equal(noEvidence.status,400);
  const a=await f.post({action:'adopt',approvalId:approval,approvalEvidence,manifestHash:hash,manifest:r.body.manifest});assert.equal(a.status,200);assert.equal(a.body.receipt.status,'adopted');
  const call=f.calls.find(c=>c.name==='resolve_md20_source_adoption');assert.equal(call.args.p_manifest.entries[0].outbox[0].decision,'discarded');assert.equal(f.state.snapshots,5);
  assert.deepEqual(call.args.p_approval_evidence,approvalEvidence);
});
test('changed source and busy lease do not execute adoption',async()=>{
  const f=fixture(),r=await f.post({action:'prepare',itemIds:[id],discardOutboxIds:[outboxId]});f.state.source.title='changed';
  const a=await f.post({action:'adopt',approvalId:approval,approvalEvidence,manifestHash:hash,manifest:r.body.manifest});assert.equal(a.status,409);assert.equal(a.body.error,'SYNC_MD20_SOURCE_CHANGED');
  assert.ok(!f.calls.some(c=>c.name==='resolve_md20_source_adoption'));
  f.state.busy=true;const b=await f.post({action:'prepare',itemIds:[id]});assert.equal(b.body.error,'SYNC_RECONCILIATION_BUSY');
});
test('post-commit drift returns receipt and review rather than claiming full sync',async()=>{
  const f=fixture(),r=await f.post({action:'prepare',itemIds:[id],discardOutboxIds:[outboxId]});f.state.afterCommitDrift=true;
  const a=await f.post({action:'adopt',approvalId:approval,approvalEvidence,manifestHash:hash,manifest:r.body.manifest});assert.equal(a.status,409);
  assert.equal(a.body.error,'SYNC_MD20_SOURCE_CHANGED_AFTER_COMMIT');assert.equal(a.body.receipt.status,'adopted');
  const repeated=await f.post({action:'adopt',approvalId:approval,approvalEvidence,manifestHash:hash,manifest:r.body.manifest});assert.equal(repeated.body.replayed,true);
});
