import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
Error.stackTraceLimit=0;
const src=n=>readFileSync(`src/lib/shopify/${n}.ts`,'utf8'),mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const coreUrl=mod(src('media-sync-core'));
const galleryBody=stripTypeScriptTypes(src('media-gallery-transport')).replace(/^import[\s\S]*?;\r?\n/gm,'');
const galleryUrl=mod(`import {createHash} from 'node:crypto';import {mediaSnapshotFingerprint} from '${coreUrl}';${galleryBody}`),gallery=await import(galleryUrl);
const body=stripTypeScriptTypes(src('media-gallery-worker')).replace(/^import[\s\S]*?;\r?\n/gm,'');
const api=await import(mod(`import {randomUUID} from 'node:crypto';import {mediaSnapshotFingerprint} from '${coreUrl}';import {galleryCasRejection} from '${galleryUrl}';
 const buildGalleryMediaCasIntent=${gallery.buildGalleryMediaCasIntent.toString()};
 import {createHash} from 'node:crypto'; const HASH_FOR_BUILD=/^[a-f0-9]{64}$/;
 ${body.replace('const HASH =','const HASH =')}`));
// The builder closes over HASH/fail, defined in the real worker; both apply the same guards.
const id={productId:'gid://shopify/Product/123',variantId:'gid://shopify/ProductVariant/456',itemId:'a0000000-0000-4000-8000-000000000001',exactGallerySku:'ABC',exactShopifySku:'ABC',productHandle:'abc'};
const stamp='2026-09-30T17:00:00Z',now=Date.parse(stamp),hash='a'.repeat(64),owner='20000000-0000-4000-8000-000000000001';
const ref={operationId:'10000000-0000-4000-8000-000000000001',step:7,phaseIndex:0};
function fixture(){
 let clock=now,committed=null;const calls=[],target={identity:id,side:'gallery',complete:true,revision:hash,assets:[{key:'a',contentId:hash,alt:'old',evidenceId:'g-a'}]};
 const after=structuredClone(target);after.revision='b'.repeat(64);after.assets[0].alt='new';
 const guard={sourceFingerprint:'c'.repeat(64),target,observedAt:stamp};
 const d={identity:id,enabled:true,desiredSemanticSha256:'d'.repeat(64),operation:{id:ref.operationId,product_gid:id.productId,status:'running'},
  step:{operation_id:ref.operationId,step_index:7,status:'started',body:{kind:'alt',target:'gallery',key:'a'}},
  transport:{chain:{operation_id:ref.operationId,step_index:7,status:'ready',next_phase:0,phases:['gallery_cas'],current_guard:guard},attempts:[],artifacts:[]},provenance:[]};
 const rpc={acquire:async()=>({owner,expiresAt:now+120000}),release:async()=>calls.push('release'),
  begin:async(r,o,a,intent,g)=>{calls.push('begin');const old=d.transport.attempts[0];if(old)return {mayExecute:false,status:old.status};
   d.transport.attempts.push({operation_id:r.operationId,step_index:r.step,phase_index:0,phase:'gallery_cas',attempt_id:a,request_hash:hash,request:intent,before_guard:g,status:'started'});
   return {mayExecute:true,replayed:false,phase:'gallery_cas',attemptId:a,requestHash:hash,request:intent};},
  conflict:async()=>{calls.push('conflict');return {status:'conflict'};},read:async()=>structuredClone(d.transport),
  accept:async(...args)=>{calls.push(['accept',...args]);d.transport.attempts[0].status='verified';return {mayExecute:false,status:'verified'};}};
 const port={apply:async(r,o,a,q,h)=>{calls.push('apply');committed={attemptId:a,requestId:q,requestHash:h,readbackMatches:true,snapshot:after};d.transport.attempts[0].status='uncertain';return {applied:true};},
  recover:async()=>{calls.push('recover');return committed;}};
 const f={calls,d,rpc,port,guard,after,tick:n=>clock+=n,observe:async()=>({...guard,target:committed?after:target}),get commit(){return committed;}};
 f.deps={now:()=>clock,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},discover:async()=>{calls.push('discover');return structuredClone(d);},
  rpc:()=>rpc,gallery:()=>port,observer:()=>async()=>f.observe()};
 f.run=()=>api.runPersistedGalleryMediaPhase(ref,now+60000,f.deps);return f;
}
test('one exact Gallery CAS followed by durable receipt and SQL acceptance',async()=>{const f=fixture();assert.deepEqual(await f.run(),{status:'verified',executed:true});assert.equal(f.calls.filter(x=>x==='apply').length,1);assert.equal(f.calls.at(-1),'release');const a=f.calls.find(Array.isArray);assert.equal(a[0],'accept');assert.equal(a[6],null);assert.deepEqual(a[5].target,f.after);});
test('lost apply response recovers actual transaction without re-applying',async()=>{const f=fixture(),apply=f.port.apply;f.port.apply=async(...a)=>{await apply(...a);throw Error('lost');};assert.deepEqual(await f.run(),{status:'verified',executed:true});assert.equal(f.calls.filter(x=>x==='apply').length,1);});
test('lost begin response leaves no permission to retry apply',async()=>{const f=fixture(),begin=f.rpc.begin;f.rpc.begin=async(...a)=>{await begin(...a);throw Error('lost begin');};await assert.rejects(f.run(),/lost begin/);f.rpc.begin=begin;f.calls.length=0;assert.deepEqual(await f.run(),{status:'pending',executed:false});assert.ok(!f.calls.includes('apply'));});
test('uncertain apply without commit stays pending and never retries',async()=>{const f=fixture();f.port.apply=async()=>{f.calls.push('apply');throw Error('lost');};assert.deepEqual(await f.run(),{status:'pending',executed:true});f.calls.length=0;assert.deepEqual(await f.run(),{status:'pending',executed:false});assert.ok(!f.calls.includes('apply'));});
test('source drift before send holds without CAS',async()=>{const f=fixture();let n=0;f.observe=async()=>({...f.guard,sourceFingerprint:++n===2?'e'.repeat(64):f.guard.sourceFingerprint});assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.ok(f.calls.includes('conflict'));assert.ok(!f.calls.includes('apply'));});
test('post-commit target drift is not accepted or overwritten',async()=>{const f=fixture(),apply=f.port.apply;f.port.apply=async(...a)=>{const r=await apply(...a);f.commit.readbackMatches=false;return r;};assert.deepEqual(await f.run(),{status:'conflict',executed:true});assert.ok(!f.calls.some(Array.isArray));});
test('wrong receipt identity blocks acceptance',async()=>{const f=fixture(),apply=f.port.apply;f.port.apply=async(...a)=>{const r=await apply(...a);f.commit.requestHash='f'.repeat(64);return r;};await assert.rejects(f.run(),/RECOVERY_INVALID/);assert.ok(!f.calls.some(Array.isArray));});
test('disabled/preview performs no IO',async()=>{for(const environment of [{},{VERCEL_ENV:'preview',SHOPIFY_MEDIA_SYNC:'enabled_v1'}]){const f=fixture();f.deps.environment=environment;assert.deepEqual(await f.run(),{status:'disabled',executed:false});assert.deepEqual(f.calls,[]);}});
test('busy lease cannot touch either side',async()=>{const f=fixture();f.rpc.acquire=async()=>null;assert.deepEqual(await f.run(),{status:'lease_busy',executed:false});assert.deepEqual(f.calls,['discover']);});
test('out-of-order phase fails before acquiring',async()=>{const f=fixture();f.d.transport.chain.next_phase=1;await assert.rejects(f.run(),/OUT_OF_ORDER/);assert.deepEqual(f.calls,['discover']);});
test('expired budget never discovers',async()=>{const f=fixture();f.tick(60001);await assert.rejects(f.run(),/TIME_BUDGET/);assert.deepEqual(f.calls,[]);});
test('immutable attempt request cannot be rebuilt differently',async()=>{const f=fixture();f.port.apply=async()=>{throw Error('lost');};await f.run();f.d.desiredSemanticSha256='f'.repeat(64);f.calls.length=0;await assert.rejects(f.run(),/IMMUTABLE_REQUEST_CHANGED/);assert.deepEqual(f.calls,['discover']);});
