import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {resolveImageLimits} from './helpers/existing-media-limits.mjs';
Error.stackTraceLimit=0;
// Real Gallery transport (error classification), real worker and real RPC port.
// Only the Supabase client is a fake that answers like PostgREST would.
const src=n=>readFileSync(`src/lib/shopify/${n}.ts`,'utf8'),mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(resolveImageLimits(s))).toString('base64');
const coreUrl=mod(src('media-sync-core'));
const galleryUrl=mod(src('media-gallery-transport').replace('import "server-only";','').replace('import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";','const createSupabaseServiceRoleClient=()=>{throw Error("SECRET_FACTORY");};').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`));
const gallery=await import(galleryUrl);
const workerBody=stripTypeScriptTypes(src('media-gallery-worker')).replace(/^import[\s\S]*?;\r?\n/gm,'');
const worker=await import(mod(`import {randomUUID} from 'node:crypto';import {mediaSnapshotFingerprint} from '${coreUrl}';
 import {buildGalleryMediaCasIntent,createGalleryMediaTransport,galleryCasRejection} from '${galleryUrl}';${workerBody}`));
const readUrl=mod(src('media-transport-read').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`));
const rpcApi=await import(mod(src('media-transport-rpc').replace('import "server-only";','').replace('import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";',
 'const createSupabaseServiceRoleClient=()=>{throw Error("SECRET_FACTORY");};').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`).replaceAll('from "./media-transport-read";',`from "${readUrl}";`)));
process.env.VERCEL_ENV='production';process.env.SHOPIFY_MEDIA_SYNC='enabled_v1';

const id={productId:'gid://shopify/Product/123',variantId:'gid://shopify/ProductVariant/456',itemId:'a0000000-0000-4000-8000-000000000001',exactGallerySku:'ABC',exactShopifySku:'ABC',productHandle:'abc'};
const stamp='2026-09-30T17:00:00Z',now=Date.parse(stamp),hash='a'.repeat(64),owner='20000000-0000-4000-8000-000000000001';
const ref={operationId:'10000000-0000-4000-8000-000000000001',step:7,phaseIndex:0};
const url='https://cdn.shopify.com/s/files/1/a.png';
const raw=rev=>({identity:id,item:{id:id.itemId,catalog_number:'ABC',title:'bag',cover_image_path:url,cover_image_alt:null,is_active:true},angles:[],version:2,revision:rev});
const refs=[{role:'cover',angleId:null,key:'a',evidenceId:'g-a'}];
const target={identity:id,side:'gallery',complete:true,revision:hash,assets:[{key:'a',contentId:hash,alt:'old',evidenceId:'g-a'}]};
const after={...structuredClone(target),revision:'b'.repeat(64),assets:[{key:'a',contentId:hash,alt:'new',evidenceId:'g-a'}]};

/** Database fake. `mode` decides how apply_toptik_gallery_media_cas answers. */
function fixture(mode){
 let clock=now;const calls=[],db={commit:null,attempt:null};
 const guard={sourceFingerprint:'c'.repeat(64),target,observedAt:stamp};
 const d={identity:id,enabled:true,desiredSemanticSha256:'d'.repeat(64),operation:{id:ref.operationId,product_gid:id.productId,status:'running'},
  step:{operation_id:ref.operationId,step_index:7,status:'started',body:{kind:'alt',target:'gallery',key:'a'}},
  transport:{chain:{operation_id:ref.operationId,step_index:7,status:'ready',next_phase:0,phases:['gallery_cas'],current_guard:guard},attempts:[],artifacts:[]},provenance:[]};
 const attempts=()=>db.attempt?[db.attempt]:[];
 const rpc={acquire:async()=>({owner,expiresAt:now+120000}),release:async()=>calls.push('release'),
  begin:async(r,o,a,intent,g)=>{calls.push('begin');if(db.attempt)return {mayExecute:false,status:db.attempt.status};
   db.attempt={operation_id:r.operationId,step_index:r.step,phase_index:0,phase:'gallery_cas',attempt_id:a,request_hash:hash,request:intent,before_guard:g,status:'started'};
   return {mayExecute:true,replayed:false,phase:'gallery_cas',attemptId:a,requestHash:hash,request:intent};},
  conflict:async()=>{calls.push('conflict');return {status:'conflict'};},
  read:async()=>({...structuredClone(d.transport),attempts:structuredClone(attempts())}),
  // Mirrors reject_toptik_gallery_media_cas: exact started attempt, no commit receipt.
  rejectGalleryCas:async(r,o,attemptId,reason)=>{calls.push(['reject',reason]);if(mode.rejectFails)throw Error('MEDIA_RPC_FAILED');
   if(db.commit||!db.attempt||db.attempt.status!=='started'||db.attempt.attempt_id!==attemptId)throw Error('MEDIA_GALLERY_REJECTION_NOT_ALLOWED');
   db.attempt.status='conflict';db.attempt.receipt={notApplied:true,code:'MEDIA_GALLERY_CAS_REJECTED',rejection:reason};return {status:'conflict',mayExecute:false,notApplied:true,rejection:reason};},
  accept:async()=>{calls.push('accept');db.attempt.status='verified';return {mayExecute:false,status:'verified'};}};
 const answer=v=>({abortSignal:()=>v});
 const client={rpc:(name,args)=>{calls.push(name);
  if(name==='apply_toptik_gallery_media_cas'){
   if(mode.commit){db.commit={attemptId:args.p_attempt_id,requestId:args.p_request_id,requestHash:args.p_request_hash};db.attempt.status='uncertain';}
   if(mode.hang)return answer(new Promise(()=>{}));
   if(mode.error)return answer(Promise.resolve({data:null,error:mode.error,status:mode.status??400}));
   return answer(Promise.resolve({data:{applied:true,replayed:false,raw:raw('b'.repeat(64)),refs,snapshot:after},error:null}));
  }
  if(name==='read_toptik_gallery_media_commit'){
   if(!db.commit)return answer(Promise.resolve({data:null,error:null}));
   return answer(Promise.resolve({data:{applied:true,readbackMatches:true,...db.commit,raw:raw('b'.repeat(64)),refs,snapshot:after,currentRaw:raw('b'.repeat(64))},error:null}));
  }
  throw Error('unexpected '+name);}};
 const f={calls,db,d,guard};
 f.deps={now:()=>clock,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},
  discover:async()=>{calls.push('discover');const x=structuredClone(d);x.transport.attempts=structuredClone(attempts());return x;},
  rpc:()=>rpc,gallery:i=>gallery.createGalleryMediaTransport(i,{client,now:()=>clock,maxRpcMs:40}),
  observer:()=>async()=>({...guard,target:db.commit?after:target})};
 f.run=()=>worker.runPersistedGalleryMediaPhase(ref,now+60000,f.deps);
 f.applies=()=>calls.filter(x=>x==='apply_toptik_gallery_media_cas').length;
 return f;
}
const pg=(code,message)=>({code,message,details:null,hint:null});

test('classifier: only a server-returned SQLSTATE that implies rollback is definitive',async()=>{
 const call=async error=>{const t=gallery.createGalleryMediaTransport(id,{client:{rpc:()=>({abortSignal:()=>Promise.resolve({data:null,error})})},now:()=>now});
  try{await t.read(owner,now+5000);}catch(e){return [e.message,gallery.galleryCasRejection(e)];}};
 assert.deepEqual(await call(pg('P0001','MEDIA_GALLERY_CAS_CHANGED')),['MEDIA_GALLERY_CAS_CHANGED','MEDIA_GALLERY_CAS_CHANGED']);
 assert.deepEqual(await call(pg('P0001','something else')),['MEDIA_GALLERY_RPC_FAILED','MEDIA_GALLERY_CAS_SQL_REJECTED']);
 assert.deepEqual(await call(pg('55P03','canceling statement due to lock timeout')),['MEDIA_GALLERY_RPC_FAILED','MEDIA_GALLERY_CAS_LOCK_TIMEOUT']);
 for(const unknown of [pg('','TypeError: fetch failed'),pg('','FetchError: The user aborted a request.'),pg('PGRST301','JWT expired'),pg('08006','connection failure'),{message:'<html>502 Bad Gateway</html>'},pg('constructor','x'),pg('toString','x')])
  assert.equal((await call(unknown))[1],null,JSON.stringify(unknown));
 // Our own client-side timeout and post-response validation are never definitive.
 const slow=gallery.createGalleryMediaTransport(id,{client:{rpc:()=>({abortSignal:()=>new Promise(()=>{})})},now:()=>now,maxRpcMs:20});
 await assert.rejects(slow.read(owner,now+5000),e=>e.message==='MEDIA_GALLERY_TIME_BUDGET'&&gallery.galleryCasRejection(e)===null);
});

test('definitive DB rejection before any write is recorded once as an exact durable conflict',async()=>{
 const f=fixture({error:pg('P0001','MEDIA_GALLERY_CAS_CHANGED')});
 assert.deepEqual(await f.run(),{status:'conflict',executed:true});
 assert.equal(f.applies(),1);assert.deepEqual(f.calls.find(Array.isArray),['reject','MEDIA_GALLERY_CAS_CHANGED']);
 assert.ok(!f.calls.includes('read_toptik_gallery_media_commit'));assert.equal(f.calls.at(-1),'release');
 assert.deepEqual(f.db.attempt.receipt,{notApplied:true,code:'MEDIA_GALLERY_CAS_REJECTED',rejection:'MEDIA_GALLERY_CAS_CHANGED'});
 f.calls.length=0;assert.deepEqual(await f.run(),{status:'conflict',executed:false});
 assert.equal(f.applies(),0);assert.ok(!f.calls.includes('begin'));
});

test('lock timeout and deadlock are definitive with their own exact reasons',async()=>{
 for(const [code,reason] of [['55P03','MEDIA_GALLERY_CAS_LOCK_TIMEOUT'],['40P01','MEDIA_GALLERY_CAS_DEADLOCK'],['57014','MEDIA_GALLERY_CAS_STATEMENT_CANCELED']]){
  const f=fixture({error:pg(code,'x')});assert.deepEqual(await f.run(),{status:'conflict',executed:true});assert.deepEqual(f.calls.find(Array.isArray),['reject',reason]);
 }
});

test('timeout after a successful write recovers the receipt and never rejects or reapplies',async()=>{
 const f=fixture({commit:true,hang:true});
 assert.deepEqual(await f.run(),{status:'verified',executed:true});
 assert.equal(f.applies(),1);assert.ok(!f.calls.some(Array.isArray));assert.ok(f.calls.includes('read_toptik_gallery_media_commit'));assert.ok(f.calls.includes('accept'));
 f.calls.length=0;assert.deepEqual(await f.run(),{status:'verified',executed:false});assert.equal(f.applies(),0);
});

test('network error after a successful write recovers the receipt',async()=>{
 const f=fixture({commit:true,error:pg('','TypeError: fetch failed'),status:0});
 assert.deepEqual(await f.run(),{status:'verified',executed:true});assert.equal(f.applies(),1);assert.ok(!f.calls.some(Array.isArray));
});

test('unknown outcome without a receipt stays recoverable pending, never rejected or reapplied',async()=>{
 for(const mode of [{hang:true},{error:pg('','TypeError: fetch failed'),status:0},{error:{message:'<html>504</html>'},status:504}]){
  const f=fixture(mode);assert.deepEqual(await f.run(),{status:'pending',executed:true});
  assert.equal(f.db.attempt.status,'started');assert.ok(!f.calls.some(Array.isArray));
  f.calls.length=0;assert.deepEqual(await f.run(),{status:'pending',executed:false});assert.equal(f.applies(),0);
 }
});

test('a rejection that cannot be recorded is surfaced, still reads the receipt and never reapplies',async()=>{
 const f=fixture({error:pg('P0001','MEDIA_GALLERY_ATTACH_INVALID'),rejectFails:true});
 await assert.rejects(f.run(),/MEDIA_GALLERY_CAS_REJECTION_UNRECORDED/);
 assert.equal(f.applies(),1);assert.ok(f.calls.includes('read_toptik_gallery_media_commit'));assert.equal(f.calls.at(-1),'release');
});

test('a server rejection claim contradicted by a commit receipt defers to the receipt',async()=>{
 // Defence in depth: SQL refuses the rejection once a commit exists; the receipt wins.
 const f=fixture({commit:true,error:pg('P0001','MEDIA_GALLERY_CAS_CHANGED')});
 assert.deepEqual(await f.run(),{status:'verified',executed:true});assert.equal(f.applies(),1);
});

test('concurrent change before the call keeps the existing not-sent hold, no apply',async()=>{
 const f=fixture({});let n=0;f.deps.observer=()=>async()=>({...f.guard,target:n++?{...target,revision:'e'.repeat(64)}:target});
 assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.ok(f.calls.includes('conflict'));assert.equal(f.applies(),0);
});

test('RPC port: rejection needs the exact consumed permit, a Gallery guard and returns the exact reason',async()=>{
 const sent=[];const guard={sourceFingerprint:'c'.repeat(64),target,observedAt:new Date().toISOString()};
 const client={rpc:(name,args)=>{sent.push([name,args]);const data=name==='begin_toptik_media_transport'?{mayExecute:true,replayed:false,phase:'gallery_cas',attemptId:args.p_attempt_id,requestHash:hash,request:args.p_request}:
  {status:'conflict',mayExecute:false,notApplied:true,rejection:args.p_rejection};return {abortSignal:()=>Promise.resolve({data,error:null})};}};
 const rpc=rpcApi.createMediaTransportRpc(id.productId,{client}),attempt='30000000-0000-4000-8000-000000000001',deadline=Date.now()+5000;
 await assert.rejects(rpc.rejectGalleryCas(ref,owner,attempt,'MEDIA_GALLERY_CAS_CHANGED',guard,deadline),/REJECTION_WITHOUT_PERMIT/);
 await rpc.begin(ref,owner,attempt,{mutationSha256:hash,expectedRevision:hash,desiredSemanticSha256:hash},guard,deadline);
 await assert.rejects(rpc.rejectGalleryCas(ref,owner,'30000000-0000-4000-8000-000000000002','MEDIA_GALLERY_CAS_CHANGED',guard,deadline),/REJECTION_WITHOUT_PERMIT/);
 await assert.rejects(rpc.rejectGalleryCas(ref,owner,attempt,'not a code',guard,deadline),/REJECTION_WITHOUT_PERMIT/);
 const r=await rpc.rejectGalleryCas(ref,owner,attempt,'MEDIA_GALLERY_CAS_CHANGED',guard,deadline);
 assert.equal(r.rejection,'MEDIA_GALLERY_CAS_CHANGED');
 const [name,args]=sent.at(-1);assert.equal(name,'reject_toptik_gallery_media_cas');
 assert.deepEqual(Object.keys(args).sort(),['p_attempt_id','p_guard','p_lease_owner','p_operation_id','p_phase_index','p_product_gid','p_rejection','p_request_id','p_step_index']);
 assert.equal(args.p_product_gid,id.productId);assert.equal(args.p_attempt_id,attempt);
 // The permit is consumed once.
 await assert.rejects(rpc.rejectGalleryCas(ref,owner,attempt,'MEDIA_GALLERY_CAS_CHANGED',guard,deadline),/REJECTION_WITHOUT_PERMIT/);
});
