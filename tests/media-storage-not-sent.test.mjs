import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStorageNotSent } from './helpers/media-storage-not-sent-fixture.mjs';
Error.stackTraceLimit=0;
const {fixture,id,sha,stagedUrl,bytes,other}=await loadStorageNotSent();
const holds=f=>f.calls.filter(c=>c[0]==='hold').map(c=>c[1]);
const uncertain=f=>f.calls.filter(c=>c[0]==='uncertain').map(c=>c[1]);

test('1a deterministic unsafe storage DNS is detected before the one-shot permit is consumed',async()=>{
 const f=fixture({addresses:[{address:'10.0.0.5',family:4}]});
 try{await assert.rejects(f.run(),/MEDIA_STORAGE_DNS_UNSAFE/);assert.ok(!f.calls.includes('begin'));assert.equal(f.s.posts,0);}finally{f.restore();}
});
test('1b source bytes that do not decode to the exact staged image fail before the permit',async()=>{
 const f=fixture({readSource:async()=>new Uint8Array(other)});
 try{await assert.rejects(f.run(),/MEDIA_STORAGE_BYTES_CHANGED/);assert.ok(!f.calls.includes('begin'));assert.equal(f.s.posts,0);}finally{f.restore();}
});
test('1c failure after the permit but provably before fetch is recorded as not-sent, never as an unknown upload',async()=>{
 const f=fixture({dnsFailsAfterBegin:true});
 try{assert.deepEqual(await f.run(),{status:'conflict',executed:false});
  assert.equal(f.s.posts,0);assert.deepEqual(holds(f),['MEDIA_TRANSPORT_NOT_SENT_PRECONDITION']);assert.deepEqual(uncertain(f),[]);
  assert.deepEqual(f.discovery.transport.attempts[0].receipt,{notSent:true,code:'MEDIA_TRANSPORT_NOT_SENT_PRECONDITION'});}finally{f.restore();}
});
test('1d observation failure after the permit is recorded as not-sent with the pre-permit guard',async()=>{
 const f=fixture({observeFailsAfterBegin:true});
 try{assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.equal(f.s.posts,0);
  assert.deepEqual(holds(f),['MEDIA_TRANSPORT_NOT_SENT_PRECONDITION']);assert.deepEqual(uncertain(f),[]);}finally{f.restore();}
});
test('2 upload succeeded but response was lost: unknown, then exact GET readback accepts; no second POST',async()=>{
 const f=fixture({post:s=>{s.object=new Uint8Array(bytes);throw Error('socket hang up');}});
 try{assert.deepEqual(await f.run(),{status:'verified',executed:true});assert.equal(f.s.posts,1);assert.deepEqual(holds(f),[]);assert.deepEqual(uncertain(f),['unknown']);
  const a=f.calls.find(c=>c[0]==='accept')[1];assert.equal(a.decodedSha256,sha);assert.equal(a.storagePath,`sync-media/${id.itemId}/${sha}.png`);assert.equal(a.url,stagedUrl);
  f.calls.length=0;assert.deepEqual(await f.run(),{status:'verified',executed:false});assert.equal(f.s.posts,1);}finally{f.restore();}
});
test('3a server rejection with no object: never treated as not-sent, never re-posted, and stays visibly diagnosable',async()=>{
 const f=fixture({post:()=>new Response('{"error":"Bad Request"}',{status:400})});
 try{const first=await f.run();assert.equal(first.status,'pending');assert.equal(first.diagnostic,'MEDIA_STORAGE_OBJECT_NOT_READABLE_AFTER_UPLOAD');
  assert.deepEqual(holds(f),[]);assert.deepEqual(uncertain(f),['unknown']);assert.equal(f.s.posts,1);
  assert.ok(f.calls.some(c=>c[0]==='diagnostic'&&c[1]==='MEDIA_STORAGE_UPLOAD_UNCONFIRMED'&&c[2]==='upload'));
  for(let n=0;n<2;n++){f.calls.length=0;const again=await f.run();assert.equal(again.status,'pending');assert.equal(again.diagnostic,'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED');assert.equal(f.s.posts,1);assert.ok(f.calls.includes('repair-read'));}
 }finally{f.restore();}
});
test('3b timeout during POST is unknown even if no object appears: no hold, no re-POST, visible diagnostic',async()=>{
 const f=fixture({post:()=>{const e=new Error('The operation was aborted due to timeout');e.name='TimeoutError';throw e;}});
 try{const out=await f.run();assert.equal(out.status,'pending');assert.equal(out.diagnostic,'MEDIA_STORAGE_OBJECT_NOT_READABLE_AFTER_UPLOAD');assert.deepEqual(holds(f),[]);assert.equal(f.s.posts,1);}finally{f.restore();}
});
test('3c existing exact object (409) is recovered by GET, never overwritten or re-posted',async()=>{
 const f=fixture({existing:new Uint8Array(bytes),post:()=>new Response('{"error":"Duplicate"}',{status:409})});
 try{assert.deepEqual(await f.run(),{status:'verified',executed:true});assert.deepEqual(f.calls.filter(c=>c[0]==='POST'),[['POST','false']]);assert.equal(f.s.posts,1);}finally{f.restore();}
});
test('3d existing different bytes at the exact path are never accepted or overwritten',async()=>{
 const f=fixture({existing:new Uint8Array(other),post:()=>new Response('{"error":"Duplicate"}',{status:409})});
 try{await assert.rejects(f.run(),/MEDIA_STORAGE_BYTES_CHANGED/);assert.ok(!f.calls.some(c=>c[0]==='accept'));assert.equal(f.s.posts,1);
  f.calls.length=0;await assert.rejects(f.run(),/MEDIA_STORAGE_BYTES_CHANGED/);assert.equal(f.s.posts,1);}finally{f.restore();}
});
test('5 repeated runs after a recorded not-sent hold never upload',async()=>{
 const f=fixture({dnsFailsAfterBegin:true});
 try{await f.run();f.calls.length=0;assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.ok(!f.calls.includes('begin'));assert.equal(f.s.posts,0);}finally{f.restore();}
});
test('1e budget expiring exactly before fetch is provably unsent: recorded not-sent, never an unknown upload',async()=>{
 const f=fixture({budgetEndsBeforeFetch:true});
 try{assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.equal(f.s.posts,0);
  assert.deepEqual(holds(f),['MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET']);assert.deepEqual(uncertain(f),[]);}finally{f.restore();}
});
test('4a source download failure happens before the permit and is visible',async()=>{
 for(const [error,code] of [[Error('MEDIA_SOURCE_READ_FAILED'),/MEDIA_SOURCE_READ_FAILED/],[Error('MEDIA_SOURCE_BYTES_CHANGED'),/MEDIA_SOURCE_BYTES_CHANGED/]]){
  const f=fixture({readSource:async()=>{throw error;}});
  try{await assert.rejects(f.run(),code);assert.ok(!f.calls.includes('begin'));assert.equal(f.s.posts,0);assert.equal(f.calls.at(-1),'release');}finally{f.restore();}
 }
});
test('4b readback of a corrupt object after upload is never accepted, never re-posted, and stays visible',async()=>{
 const f=fixture({post:s=>{s.object=new Uint8Array([137,80,78,71,0,0,0,0]);return new Response('{}',{status:200});}});
 try{await assert.rejects(f.run(),/MEDIA_STORAGE_(DECODE_FAILED|BYTES_CHANGED|FORMAT_INVALID)/);assert.ok(!f.calls.some(c=>c[0]==='accept'));assert.deepEqual(uncertain(f),['accepted']);
  f.calls.length=0;await assert.rejects(f.run(),/MEDIA_STORAGE_(DECODE_FAILED|BYTES_CHANGED|FORMAT_INVALID)/);assert.equal(f.s.posts,1);assert.ok(!f.calls.includes('repair-read'));}finally{f.restore();}
});
test('4c readback network failure after an accepted upload waits with a reason, then recovers by GET only',async()=>{
 const f=fixture();let fail=true;const real=globalThis.fetch;
 globalThis.fetch=async(u,i={})=>i.method!=='POST'&&fail?Promise.reject(Error('ECONNRESET')):real(u,i);
 try{const first=await f.run();assert.equal(first.status,'pending');assert.equal(first.diagnostic,'MEDIA_STORAGE_OBJECT_NOT_READABLE_AFTER_UPLOAD');
  fail=false;f.calls.length=0;assert.deepEqual(await f.run(),{status:'verified',executed:false});assert.equal(f.s.posts,1);}finally{globalThis.fetch=real;f.restore();}
});
test('6 another variant/color identity is rejected before lease, source read or permit',async()=>{
 const f=fixture({identityOverride:{...id,variantId:'gid://shopify/ProductVariant/999',exactShopifySku:'ABC-RED'}});
 try{await assert.rejects(f.run(),/MEDIA_STORAGE_IDENTITY_CHANGED/);assert.deepEqual(f.calls,[]);assert.equal(f.s.posts,0);}finally{f.restore();}
});
test('every path keeps the lease contract and only touches transport journal ports',async()=>{
 const allowed=new Set(['begin','release','uncertain','hold','accept','repair-read','diagnostic','POST']);
 for(const options of [{},{dnsFailsAfterBegin:true},{post:()=>new Response('',{status:400})},{post:s=>{s.object=new Uint8Array(bytes);throw Error('lost');}}]){
  const f=fixture(options);try{await f.run().catch(()=>{});assert.equal(f.calls.at(-1),'release');
   assert.deepEqual(f.calls.map(c=>Array.isArray(c)?c[0]:c).filter(k=>!allowed.has(k)),[]);}finally{f.restore();}
 }
});
