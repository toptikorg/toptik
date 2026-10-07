import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('../src/app/api/admin/shopify/media/repair-observation/route.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '')).replace(/^export /gm, '');
const { make } = await import('data:text/javascript;base64,' + Buffer.from(`export function make(deps) { const {NextResponse,requireGalleryAdmin,createMediaTransportRpc,discoverMediaTransportOperation,createMediaRuntimeObserver,assertReviewedPersistedMedia}=deps;${code};return GET;}`).toString('base64'));
const operation = 'ee204cbb-9a82-4b44-ad89-d6e12a1ff15b';
function fixture() {
 const calls=[], d={enabled:true,identity:{productId:'gid://shopify/Product/15407482470650'},step:{body:{target:'gallery'}},
 transport:{attempts:[{phase_index:0,status:'uncertain',phase:'gallery_upload',attempt_id:'attempt',request_hash:'hash',request:{sourceEvidenceId:'evidence',storagePath:'path'}}]},
 provenance:[{evidence_id:'evidence',proof:{decodedSha256:'sha'}}]};
 const guard={observedAt:new Date().toISOString(),sourceFingerprint:'actual',target:{actual:true}};
 const f={calls,d,guard,denied:null,busy:false,reviewError:false,observeError:false};
 const deps={NextResponse:{json:(value,options)=>({value,...options})},requireGalleryAdmin:async()=>{calls.push('auth');return f.denied;},
 discoverMediaTransportOperation:async()=>{calls.push('discover');return structuredClone(d);},
 createMediaTransportRpc:()=>({acquire:async()=>{calls.push('acquire');return f.busy?null:{owner:'owner'};},release:async()=>{calls.push('release');}}),
 assertReviewedPersistedMedia:async()=>{calls.push('review');if(f.reviewError)throw new Error('MEDIA_REVIEW_REQUIRED');},
 createMediaRuntimeObserver:()=>async()=>{calls.push('observe');if(f.observeError)throw new Error('secret error must not escape');return guard;}};
 const run=make(deps); f.run=(query=`operationId=${operation}&step=0`)=>run({nextUrl:new URL('https://admin.toptik.co.il/api/admin/shopify/media/repair-observation?'+query)});return f;
}
test('requires administrator before any discovery or lease',async()=>{const f=fixture();f.denied={status:403};assert.equal(await f.run(),f.denied);assert.deepEqual(f.calls,['auth']);});
for(const query of ['',`operationId=${operation}&step=-1`,`operationId=${operation}&step=0&url=https://evil.test`,`operationId=${operation}&operationId=${operation}&step=0`])
test('invalid input rejected: '+query,async()=>{const f=fixture();assert.equal((await f.run(query)).status,409);assert.deepEqual(f.calls,['auth']);});
test('fresh observation returned without permission or lease token',async()=>{const f=fixture();const r=await f.run();assert.deepEqual(r.value.guard,f.guard);assert.equal(r.value.approved,false);assert.equal(r.value.mayExecute,false);assert.equal(r.value.owner,undefined);assert.equal(r.headers['Cache-Control'],'no-store');assert.deepEqual(f.calls,['auth','discover','acquire','discover','review','observe','release']);});
test('busy lease never reads under another worker',async()=>{const f=fixture();f.busy=true;assert.equal((await f.run()).value.error,'MEDIA_REPAIR_OBSERVATION_LEASE_BUSY');assert.ok(!f.calls.includes('observe'));});
test('review denial releases lease and prevents observation',async()=>{const f=fixture();f.reviewError=true;assert.equal((await f.run()).value.error,'MEDIA_REVIEW_REQUIRED');assert.equal(f.calls.at(-1),'release');assert.ok(!f.calls.includes('observe'));});
test('unexpected observation error masked and lease released',async()=>{const f=fixture();f.observeError=true;const r=await f.run();assert.equal(r.value.error,'MEDIA_REPAIR_OBSERVATION_FAILED');assert.equal(f.calls.at(-1),'release');});
test('verified attempt cannot be admitted',async()=>{const f=fixture();f.d.transport.attempts[0].status='verified';assert.equal((await f.run()).value.error,'MEDIA_REPAIR_OBSERVATION_NOT_PENDING');assert.ok(!f.calls.includes('observe'));});
test('disabled product cannot be observed for repair',async()=>{const f=fixture();f.d.enabled=false;assert.equal((await f.run()).value.error,'MEDIA_REPAIR_OBSERVATION_DISABLED');assert.equal(f.calls.at(-1),'release');});
test('route contains no admission or storage mutation port',()=>{assert.doesNotMatch(source,/authorize_storage_repair|claimStorageRepair|uploadImmutableMedia|\.insert\(|\.update\(/);});
