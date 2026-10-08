import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolveImageLimits(text))).toString('base64')}`;
const source = name => readFileSync(new URL(`../src/lib/shopify/${name}.ts`, import.meta.url), 'utf8');
const coreUrl = moduleUrl(source('media-sync-core'));
const readUrl = moduleUrl(source('media-transport-read').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`));
const read = await import(readUrl);
const requestsUrl = moduleUrl(source('media-transport-requests').replaceAll('from "./media-transport-read";', `from "${readUrl}";`));
const api = await import(requestsUrl);
const journalUrl = moduleUrl(source('media-transport-journal-intent').replaceAll('from "./media-transport-read";', `from "${readUrl}";`));
const journal = await import(journalUrl);
const worker = await import(moduleUrl(source('media-transport-worker').replaceAll('from "./media-transport-read";', `from "${readUrl}";`)
  .replaceAll('from "./media-transport-requests";', `from "${requestsUrl}";`).replaceAll('from "./media-transport-journal-intent";', `from "${journalUrl}";`)));
const identity = { productId:'gid://shopify/Product/7550812619002',variantId:'gid://shopify/ProductVariant/42465754808570',
  itemId:'6f887176-e70a-44ba-b252-238f994b66ad',exactGallerySku:'P10SZV24-05J-TU',exactShopifySku:'P10SZV2405J',productHandle:'logoduck-i-טרולי' };
const time = '2026-09-30T17:00:00Z';
const connection = nodes => ({ nodes, pageInfo:{ hasNextPage:false } });
const image = n => ({id:`gid://shopify/MediaImage/${n}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',alt:'מזוודה',updatedAt:time,
  image:{id:`gid://shopify/ImageSource/${n}`,url:`https://cdn.shopify.com/s/files/1/0645/image-${n}.jpg?v=123`,width:1000,height:1000}});
const response = () => ({data:{product:{id:identity.productId,handle:identity.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt:time,
  mediaCount:{count:2,precision:'EXACT'},media:connection([image(1),image(2)]),variants:connection([{id:identity.variantId,sku:identity.exactShopifySku,
    image:{id:'gid://shopify/ProductImage/999',url:image(1).image.url},media:connection([{id:image(1).id}])}])}}});
const parse = r => read.parseMediaTransportResponse(r,identity);
const fixture = () => {
  const snapshot = parse(response());
  const context = {identity,operationId:'10000000-0000-4000-8000-000000000001',step:0,sourceFingerprint:'a'.repeat(64),targetRevision:snapshot.revision};
  const staged = {identity,contentSha256:'b'.repeat(64),mime:'image/jpeg',byteLength:1000,width:1000,height:1000,
    url:api.stagedMediaUrl(identity,'b'.repeat(64),'image/jpeg'),receiptId:'upload-proof'};
  const filename = api.ownedMediaFilename(context,staged.contentSha256,staged.mime);
  const newMedia = image(3);newMedia.image.url=`https://cdn.shopify.com/s/files/1/0645/${filename}?v=123`;
  const owned = {identity,operationId:context.operationId,step:context.step,sourceFingerprint:context.sourceFingerprint,filename,
    sourceSha256:staged.contentSha256,mime:staged.mime,alt:'מזוודה',media:read.parseTransportMedia(newMedia),
    decodedSha256:'c'.repeat(64),decodedByteLength:987,receiptId:'import-proof'};
  return {snapshot,context,staged,owned,newMedia};
};

test('raw reader retains old/new and pending/failed images rather than treating them as removals',()=>{
  for(const status of ['UPLOADED','PROCESSING','FAILED']) {
    const r=response();r.data.product.media.nodes[1]={...image(2),status,fileStatus:status,image:null};
    const out=parse(r);assert.equal(out.media.length,2);assert.equal(out.media[1].status,status);read.assertMediaTransportRead(out);
  }
});
test('raw reader preserves distinct ImageSource and ProductImage namespaces',()=>{
  const out=parse(response());assert.equal(out.media[0].image.id,'gid://shopify/ImageSource/1');assert.equal(out.variantImage.id,'gid://shopify/ProductImage/999');
});
for(const [name,edit,error] of [
  ['pagination',p=>p.media.pageInfo.hasNextPage=true,/INCOMPLETE/],
  ['count',p=>p.mediaCount.count=3,/INCOMPLETE/],
  ['unknown media status',p=>p.media.nodes[1].status='PENDING',/ASSET_INVALID/],
  ['missing image field',p=>delete p.media.nodes[1].image,/RESPONSE_INVALID/],
  ['READY null',p=>p.media.nodes[1].image=null,/IMAGE_INVALID/],
  ['video',p=>p.media.nodes[1].mediaContentType='VIDEO',/UNSUPPORTED/],
  ['duplicate platform ID',p=>p.media.nodes[1]=p.media.nodes[0],/DUPLICATE_ID/],
  ['wrong exact SKU',p=>p.variants.nodes[0].sku+='-TU',/VARIANT_CHANGED/],
  ['second variant',p=>p.variants.nodes.push(p.variants.nodes[0]),/VARIANT_CHANGED/],
  ['foreign image',p=>p.media.nodes[1].image.url='https://evil.example/a.jpg',/IMAGE_INVALID/],
  ['pixel limit',p=>p.media.nodes[1].image.width=16001,/IMAGE_INVALID/],
  ['orphan variant ID',p=>p.variants.nodes[0].media.nodes[0].id='gid://shopify/MediaImage/999',/VARIANT_INVALID/],
  ['orphan variant image',p=>p.variants.nodes[0].image.url=image(2).image.url,/VARIANT_INVALID/],
  ['nonpublic product',p=>p.publishedOnPublication=false,/IDENTITY_CHANGED/],
]) test(`raw read rejects ${name}`,()=>{const r=response();edit(r.data.product);assert.throws(()=>parse(r),error);});
test('raw revision covers image status, association, alt, content and order',()=>{
  const before=parse(response()).revision;
  for(const edit of [p=>p.media.nodes[1].status='PROCESSING',p=>p.media.nodes[1].alt='חדש',p=>p.media.nodes.reverse(),p=>p.variants.nodes[0].image=null]) {
    const r=response();edit(r.data.product);assert.notEqual(parse(r).revision,before);
  }
});
test('stored raw read is validated and rejects both tampering and wrong expected revision',()=>{
  const r=parse(response());read.assertMediaTransportRead(r);assert.throws(()=>read.assertMediaTransportRead(r,'b'.repeat(64)),/READ_CHANGED/);
  r.media[0].alt='tampered';assert.throws(()=>read.assertMediaTransportRead(r),/READ_CHANGED/);
});
test('create uses immutable item/bytes stage and deterministic filename with collision rejection',()=>{
  const {context,staged}=fixture(),r=api.buildOwnedMediaCreate(context,staged,'מזוודה');
  assert.equal(r.apiVersion,'2026-07');assert.equal(r.variables.files[0].duplicateResolutionMode,'RAISE_ERROR');
  assert.equal(r.variables.files[0].originalSource,staged.url);assert.equal(r.variables.files[0].contentType,'IMAGE');
  assert.deepEqual(r,api.buildOwnedMediaCreate(context,staged,'מזוודה'));assert.equal(r.mutationSha256.length,64);
  assert.notEqual(r.mutationSha256,api.buildOwnedMediaCreate(context,staged,'תיק').mutationSha256);
});
test('existing 25MP originals pass raw read and staged transport with unchanged byte and edge caps',()=>{
  const r=response();r.data.product.media.nodes[0].image.width=5000;r.data.product.media.nodes[0].image.height=5000;
  assert.equal(parse(r).media[0].image.width,5000);
  r.data.product.media.nodes[0].image.height=5001;assert.throws(()=>parse(r),/IMAGE_INVALID/);
  const f=fixture();f.staged.width=5000;f.staged.height=5000;
  assert.equal(api.buildOwnedMediaCreate(f.context,f.staged,'').variables.files[0].originalSource,f.staged.url);
  for(const change of [s=>s.height=5001,s=>{s.width=16001;s.height=1;},s=>s.byteLength=8388609]){
    const staged=structuredClone(f.staged);change(staged);assert.throws(()=>api.buildOwnedMediaCreate(f.context,staged,''),/STAGED_SOURCE/);
  }
});
for(const [name,edit,error] of [
  ['mutable supplier URL',s=>s.url='https://bricstore.com/product.jpg',/STAGED_SOURCE/],
  ['different item path',s=>s.url=s.url.replace(identity.itemId,'other'),/STAGED_SOURCE/],
  ['missing proof',s=>s.receiptId='',/STAGED_SOURCE/],
  ['unsupported SVG',s=>s.mime='image/svg+xml',/MIME/],
  ['pixel bomb',s=>s.height=16001,/STAGED_SOURCE/],
  ['wrong identity',s=>s.identity={...identity,exactShopifySku:'other'},/IDENTITY_MISMATCH/],
  ['zero bytes',s=>s.byteLength=0,/STAGED_SOURCE/],
]) test(`create rejects ${name}`,()=>{const f=fixture();edit(f.staged);assert.throws(()=>api.buildOwnedMediaCreate(f.context,f.staged,''),error);});
test('associate only adds exact product reference; never global source or alt mutations',()=>{
  const f=fixture(),r=api.buildOwnedMediaAssociate(f.context,f.snapshot,f.owned);
  assert.deepEqual(r.variables,{files:[{id:f.owned.media.mediaId,referencesToAdd:[identity.productId]}]});
  assert.doesNotMatch(r.query,/fileDelete|productDelete/);assert.equal(r.phase,'associate');
});
for(const [name,edit] of [
  ['other operation',o=>o.operationId='10000000-0000-4000-8000-000000000002'],
  ['other source version',o=>o.sourceFingerprint='d'.repeat(64)],['other file',o=>o.filename='foreign.jpg'],
  ['other source bytes',o=>o.sourceSha256='d'.repeat(64)],['missing decode',o=>o.decodedSha256=''],
  ['missing receipt',o=>o.receiptId=''],['wrong alt',o=>o.media.alt='unexpected'],
]) test(`association rejects ${name}`,()=>{const f=fixture();edit(f.owned);assert.throws(()=>api.buildOwnedMediaAssociate(f.context,f.snapshot,f.owned),/OWNERSHIP_REQUIRED/);});
test('already associated and stale raw state never produce another mutation',()=>{
  const f=fixture();f.context.targetRevision='d'.repeat(64);assert.throws(()=>api.buildOwnedMediaAssociate(f.context,f.snapshot,f.owned),/READ_CHANGED/);
  const r=response();r.data.product.media.nodes.push(f.newMedia);r.data.product.mediaCount.count=3;const state=parse(r);
  assert.throws(()=>api.buildOwnedMediaAssociate({...f.context,targetRevision:state.revision},state,f.owned),/ALREADY_ASSOCIATED/);
});
test('variant switch targets only exact variant mediaId and preserves all commercial fields',()=>{
  const f=fixture(),r=response();r.data.product.media.nodes.push(f.newMedia);r.data.product.mediaCount.count=3;const state=parse(r);
  const request=api.buildMediaVariantReassign({...f.context,targetRevision:state.revision},state,image(1).id,f.owned);
  assert.deepEqual(request.variables,{productId:identity.productId,variants:[{id:identity.variantId,mediaId:f.owned.media.mediaId}]});
  assert.match(request.query,/allowPartialUpdates: false/);
});
test('ambiguous multiple variant media never collapse to one',()=>{
  const f=fixture(),r=response();r.data.product.media.nodes.push(f.newMedia);r.data.product.mediaCount.count=3;r.data.product.variants.nodes[0].media.nodes.push({id:image(2).id});const state=parse(r);
  assert.throws(()=>api.buildMediaVariantReassign({...f.context,targetRevision:state.revision},state,image(1).id,f.owned),/REASSIGN_CONFLICT/);
});
test('detach protects variant reference and last decoded-ready image',()=>{
  const f=fixture();assert.throws(()=>api.buildMediaReferenceDetach(f.context,f.snapshot,image(1).id,'detach_old'),/VARIANT_IMAGE_PROTECTED/);
  const r=response();r.data.product.media.nodes=[image(2)];r.data.product.mediaCount.count=1;r.data.product.variants.nodes[0].media.nodes=[];r.data.product.variants.nodes[0].image=null;const state=parse(r);
  assert.throws(()=>api.buildMediaReferenceDetach({...f.context,targetRevision:state.revision},state,image(2).id,'detach_reference'),/LAST_IMAGE/);
});
test('detach removes one product association, leaves shared file alive',()=>{
  const f=fixture(),r=api.buildMediaReferenceDetach(f.context,f.snapshot,image(2).id,'detach_reference');
  assert.deepEqual(r.variables,{files:[{id:image(2).id,referencesToRemove:[identity.productId]}]});assert.doesNotMatch(r.query,/fileDelete/);
});
test('reorder emits sequential minimal moves and retains exact membership',()=>{
  const f=fixture(),r=api.buildMediaReorder(f.context,f.snapshot,[image(2).id,image(1).id]);
  assert.deepEqual(r.variables.moves,[{id:image(2).id,newPosition:'0'}]);
  assert.throws(()=>api.buildMediaReorder(f.context,f.snapshot,[image(1).id,image(2).id]),/NOOP/);
  assert.throws(()=>api.buildMediaReorder(f.context,f.snapshot,[image(2).id]),/MEMBERSHIP_CHANGED/);
  assert.throws(()=>api.buildMediaReorder(f.context,f.snapshot,[image(2).id,image(2).id]),/MEMBERSHIP_CHANGED/);
});
test('lost create response yields read-only exact filename lookup; no-result is not re-create permission',()=>{
  const f=fixture(),r=api.buildOwnedMediaRecoveryRead(f.context,f.staged.contentSha256,f.staged.mime);
  assert.match(r.query,/query TopTikRecoverOwnedMedia/);assert.doesNotMatch(r.query,/mutation/);
  assert.equal(r.variables.query,`filename:"${f.owned.filename}"`);
  assert.equal(api.parseOwnedMediaRecovery({data:{files:connection([])}},r.filename),null);
  assert.equal(api.parseOwnedMediaRecovery({data:{files:connection([f.newMedia])}},r.filename).mediaId,f.newMedia.id);
  assert.throws(()=>api.parseOwnedMediaRecovery({data:{files:connection([f.newMedia,f.newMedia])}},r.filename),/AMBIGUOUS/);
  assert.throws(()=>api.parseOwnedMediaRecovery({data:{files:connection([image(1)])}},r.filename),/FILENAME_MISMATCH/);
});
test('mutation acknowledgement is distinguished from READY/decode/readback',()=>{
  const f=fixture(),request=api.buildOwnedMediaCreate(f.context,f.staged,''),pending={...f.newMedia,status:'PROCESSING',fileStatus:'PROCESSING',image:null};
  const ack=api.parseMediaTransportAcknowledgement({data:{fileCreate:{files:[pending],userErrors:[]}}},request);
  assert.equal(ack.media.status,'PROCESSING');assert.equal(ack.complete,undefined);
});
for(const errors of [null,{},[{message:'sensitive diagnostic'}]]) test(`invalid GraphQL errors ${JSON.stringify(errors)} are masked`,()=>{
  const f=fixture(),r=api.buildOwnedMediaCreate(f.context,f.staged,'');
  assert.throws(()=>api.parseMediaTransportAcknowledgement({errors,data:{fileCreate:{files:[f.newMedia],userErrors:[]}}},r),/^Error: MEDIA_TRANSPORT_GRAPHQL_ERROR$/);
});
test('malformed acknowledgements and mismatched asset do not advance completion',()=>{
  const f=fixture(),r=api.buildOwnedMediaAssociate(f.context,f.snapshot,f.owned);
  for(const body of [{data:{fileUpdate:{files:[image(9)],userErrors:[]}}},{data:{fileUpdate:{files:[f.newMedia]}}},
    {data:{fileUpdate:{files:[],userErrors:[]}}},{data:{fileUpdate:{files:[f.newMedia],userErrors:[{message:'secret'}]}}}]) {
    assert.throws(()=>api.parseMediaTransportAcknowledgement(body,r),/MEDIA_TRANSPORT_/);
  }
  r.variables.files[0].id=image(9).id;assert.throws(()=>api.parseMediaTransportAcknowledgement({},r),/REQUEST_CHANGED/);
});
test('reorder returns job only until full product order readback',()=>{
  const f=fixture(),r=api.buildMediaReorder(f.context,f.snapshot,[image(2).id,image(1).id]);
  const ack=api.parseMediaTransportAcknowledgement({data:{productReorderMedia:{job:{id:'gid://shopify/Job/abc-123'},mediaUserErrors:[]}}},r);
  assert.deepEqual(ack,{jobId:'gid://shopify/Job/abc-123'});
});

test('journal bridge maps complete request to exact SQL phase schema',()=>{
  const f=fixture(),create=api.buildOwnedMediaCreate(f.context,f.staged,'');
  assert.deepEqual(Object.keys(journal.buildMediaJournalIntent(create,f.snapshot,'evidence-1')).sort(),
    ['duplicateResolutionMode','filename','mutationSha256','sourceEvidenceId','stagedSourceUrl']);
  const associate=api.buildOwnedMediaAssociate(f.context,f.snapshot,f.owned);
  assert.deepEqual(journal.buildMediaJournalIntent(associate,f.snapshot),{mutationSha256:associate.mutationSha256,productGid:identity.productId,mediaGid:f.newMedia.id});
  const reorder=api.buildMediaReorder(f.context,f.snapshot,[image(2).id,image(1).id]);
  assert.deepEqual(journal.buildMediaJournalIntent(reorder,f.snapshot).mediaGids,[image(2).id,image(1).id]);
  const detach=api.buildMediaReferenceDetach(f.context,f.snapshot,image(2).id,'detach_reference');assert.equal(journal.mediaJournalPhase(detach),'detach_old');
});
test('journal bridge handles JSONB object-key order and rejects changed request',()=>{
  const f=fixture(),associate=api.buildOwnedMediaAssociate(f.context,f.snapshot,f.owned);
  const unordered=structuredClone(f.snapshot);unordered.identity=Object.fromEntries(Object.entries(unordered.identity).reverse());
  assert.doesNotThrow(()=>journal.buildMediaJournalIntent(associate,unordered));
  associate.variables.files[0].referencesToAdd.push('gid://shopify/Product/999');
  assert.throws(()=>journal.buildMediaJournalIntent(associate,f.snapshot),/INTENT_INVALID/);
});

function workerFixture() {
  const f=fixture(),request=api.buildOwnedMediaAssociate(f.context,f.snapshot,f.owned),log=[];
  const job={request,before:f.snapshot,enabled:true,scopes:['write_products','write_themes']};
  const reference={operationId:f.context.operationId,step:0,phaseIndex:1},now=Date.parse(time),deadline=now+20000;
  const guard=()=>({sourceFingerprint:f.context.sourceFingerprint,target:structuredClone(f.snapshot),observedAt:time});
  const deps={ now:()=>now,
    load:async()=>{log.push('load');return job;},
    acquire:async()=>{log.push('acquire');return {owner:'20000000-0000-4000-8000-000000000001',expiresAt:deadline+10000};},
    release:async()=>{log.push('release');},
    observe:async()=>{log.push('observe');return guard();},
    begin:async(_ref,_lease,attemptId,intent)=>{log.push('begin');return {mayExecute:true,phase:'associate',attemptId,requestHash:'d'.repeat(64),request:intent,replayed:false};},
    execute:async()=>{log.push('execute');return {data:{fileUpdate:{files:[f.newMedia],userErrors:[]}}};},
    uncertain:async(_ref,_lease,receipt)=>{log.push(`uncertain:${receipt.outcome}`);},
    conflict:async()=>{log.push('conflict');},
    recover:async()=>{log.push('recover');return {status:'verified'};},
  };
  return {...f,job,reference,log,deps,deadline,guard,run:()=>worker.runMediaTransportPhase(reference,deadline,deps)};
}
test('worker claims product lease, journals before call, rechecks and verifies via private recovery',async()=>{
  const f=workerFixture();assert.deepEqual(await f.run(),{status:'verified',executed:true});
  assert.deepEqual(f.log,['load','acquire','observe','begin','observe','execute','uncertain:accepted','recover','release']);
});
test('disabled path does not acquire lease or touch Shopify',async()=>{
  const f=workerFixture();f.job.enabled=false;assert.deepEqual(await f.run(),{status:'disabled',executed:false});assert.deepEqual(f.log,['load']);
});
test('write_products cannot authorize fileUpdate or grant new scopes',async()=>{
  const f=workerFixture();f.job.scopes=['write_products'];assert.deepEqual(await f.run(),{status:'scope_missing',executed:false});assert.deepEqual(f.log,['load']);
});
test('busy shared product lease prevents writes and private begin',async()=>{
  const f=workerFixture();f.deps.acquire=async()=>null;assert.deepEqual(await f.run(),{status:'lease_busy',executed:false});assert.deepEqual(f.log,['load']);
});
test('SQL-returned JSONB key order is accepted without changing scope',async()=>{
  const f=workerFixture(),begin=f.deps.begin;f.deps.begin=async(...args)=>{const p=await begin(...args);p.request=Object.fromEntries(Object.entries(p.request).reverse());return p;};
  assert.equal((await f.run()).status,'verified');
});
test('lost begin response never permits network mutation',async()=>{
  const f=workerFixture();f.deps.begin=async()=>{throw Error('lost SQL reply');};await assert.rejects(f.run(),/lost SQL reply/);
  assert.ok(!f.log.includes('execute'));assert.equal(f.log.at(-1),'release');
});
test('lost Shopify reply consumes one attempt; next invocation recovers without re-execution',async()=>{
  const f=workerFixture();f.deps.execute=async()=>{f.log.push('execute');throw Error('network token=secret');};
  assert.deepEqual(await f.run(),{status:'pending',executed:true});assert.ok(f.log.includes('uncertain:unknown'));
  f.deps.begin=async()=>({mayExecute:false,status:'uncertain',replayed:true});
  assert.deepEqual(await f.run(),{status:'verified',executed:false});assert.equal(f.log.filter(x=>x==='execute').length,1);
});
test('malformed success is uncertain and does not become completion',async()=>{
  const f=workerFixture();f.deps.execute=async()=>({data:{fileUpdate:{files:[f.newMedia],userErrors:null}}});
  assert.deepEqual(await f.run(),{status:'pending',executed:true});assert.ok(!f.log.includes('recover'));assert.ok(f.log.includes('uncertain:unknown'));
});
test('source/target drift after permit stops the outbound call',async()=>{
  for(const drift of ['source','target']) {
    const f=workerFixture();let observations=0;f.deps.observe=async()=>{
      const g=f.guard();if(++observations===2) {
        if(drift==='source')g.sourceFingerprint='e'.repeat(64);
        else {const r=response();r.data.product.media.nodes[1].alt='merchant edit';g.target=parse(r);}
      }return g;
    };
    assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.ok(!f.log.includes('execute'));assert.ok(f.log.includes('conflict'));
  }
});
test('stale observations and false permits cannot execute',async()=>{
  const f=workerFixture();f.deps.observe=async()=>({...f.guard(),observedAt:'2026-09-30T16:00:00Z'});await assert.rejects(f.run(),/OBSERVATION_INVALID/);assert.ok(!f.log.includes('execute'));
  for(const edit of [p=>p.replayed=true,p=>p.attemptId='other',p=>p.phase='reorder',p=>p.requestHash='',p=>p.request={...p.request,mediaGid:image(999).id}]) {
    const f=workerFixture(),begin=f.deps.begin;f.deps.begin=async(...args)=>{const p=await begin(...args);edit(p);return p;};
    await assert.rejects(f.run(),/PERMIT_INVALID/);assert.ok(!f.log.includes('execute'));
  }
});
test('already verified/private conflict phases do not call Shopify again',async()=>{
  for(const status of ['verified','conflict']){const f=workerFixture();f.deps.begin=async()=>({mayExecute:false,status});
    assert.deepEqual(await f.run(),{status,executed:false});assert.ok(!f.log.includes('execute'));assert.ok(!f.log.includes('recover'));}
});
test('Shopify acknowledgement with pending proof is not complete',async()=>{
  const f=workerFixture();f.deps.recover=async()=>({status:'pending'});assert.deepEqual(await f.run(),{status:'pending',executed:true});
});
test('per-invocation deadline is capped and prevents calls when exhausted',async()=>{
  const f=workerFixture();f.deps.now=()=>f.deadline;await assert.rejects(f.run(),/TIME_BUDGET/);assert.deepEqual(f.log,[]);
});
test('already-correct terminal order is journal-verified without any Shopify mutation',async()=>{
  const f=workerFixture();f.job.request=api.buildMediaReorder(f.context,f.snapshot,f.snapshot.media.map(m=>m.mediaId),true);
  assert.deepEqual(journal.buildMediaJournalIntent(f.job.request,f.snapshot).mediaGids,f.snapshot.media.map(m=>m.mediaId));
  f.deps.begin=async()=>({mayExecute:false,status:'verified',verifiedNoop:true});
  assert.deepEqual(await f.run(),{status:'verified',executed:false});assert.ok(!f.log.includes('execute'));
});
test('even a bad permit cannot send empty reorder moves',async()=>{
  const f=workerFixture();f.job.request=api.buildMediaReorder(f.context,f.snapshot,f.snapshot.media.map(m=>m.mediaId),true);
  const begin=f.deps.begin;f.deps.begin=async(...args)=>({...await begin(...args),phase:'reorder'});
  await assert.rejects(f.run(),/NOOP_EXECUTION_FORBIDDEN/);assert.ok(!f.log.includes('execute'));
});
test('a short lease cannot authorize a request beyond its expiry',async()=>{
  const f=workerFixture();f.deps.acquire=async()=>({owner:'20000000-0000-4000-8000-000000000001',expiresAt:f.deadline});
  await assert.rejects(f.run(),/LEASE_TOO_SHORT/);assert.ok(!f.log.includes('begin'));assert.equal(f.log.at(-1),'release');
});
test('all ports receive absolute deadlines with a real persistence and cleanup reserve',async()=>{
  const f=workerFixture(),seen={};
  for(const name of ['load','acquire','observe','begin','execute','uncertain','recover','release']) {
    const original=f.deps[name];f.deps[name]=async(...args)=>{seen[name]=args.at(-1);return original(...args);};
  }
  assert.equal((await f.run()).status,'verified');
  for(const name of ['load','acquire','observe','begin','uncertain','recover'])assert.equal(seen[name],f.deadline-1000,name);
  assert.equal(seen.execute,f.deadline-5000);assert.equal(seen.release,f.deadline);
});
test('cleanup failure cannot override SQL-verified outcome',async()=>{
  const f=workerFixture();f.deps.release=async()=>{throw Error('cleanup network failure');};
  assert.deepEqual(await f.run(),{status:'verified',executed:true});
});
test('a stuck read port is bounded even if its adapter ignores deadline',async()=>{
  const f=workerFixture();f.deps.now=Date.now;f.deps.load=async()=>new Promise(()=>{});
  await assert.rejects(worker.runMediaTransportPhase(f.reference,Date.now()+1030,f.deps),/TIME_BUDGET/);
  assert.ok(!f.log.includes('acquire'));assert.ok(!f.log.includes('execute'));
});

// Shopify bumps product.updatedAt asynchronously after an association. Only that
// timestamp (and its derived revision) may be refreshed, and only before begin.
function timestampDrift(f,edit=()=>{}){const r=response();r.data.product.updatedAt='2026-09-30T17:00:07Z';edit(r.data.product);
  return {sourceFingerprint:f.context.sourceFingerprint,target:parse(r),observedAt:time};}
function refreshFixture(status='refreshed'){const f=workerFixture();f.refreshCalls=[];
  f.deps.refresh=async(...args)=>{f.log.push('refresh');f.refreshCalls.push(args);return {status,refreshed:status==='refreshed'};};return f;}
test('product updatedAt-only drift refreshes the chain guard before begin and waits',async()=>{
  const f=refreshFixture(),drifted=timestampDrift(f);assert.notEqual(drifted.target.revision,f.snapshot.revision);
  f.deps.observe=async()=>{f.log.push('observe');return structuredClone(drifted);};
  assert.deepEqual(await f.run(),{status:'pending',executed:false});
  assert.deepEqual(f.log,['load','acquire','observe','refresh','release']);
  const [ref,lease,guard,deadline]=f.refreshCalls[0];assert.deepEqual(ref,f.reference);assert.equal(lease,'20000000-0000-4000-8000-000000000001');
  assert.deepEqual(guard,drifted);assert.equal(deadline,f.deadline-1000);
});
test('SQL refusal of a refresh (attempt exists) falls through to begin and private recovery',async()=>{
  const f=refreshFixture('attempt_exists'),drifted=timestampDrift(f);f.deps.observe=async()=>{f.log.push('observe');return structuredClone(drifted);};
  f.deps.begin=async()=>{f.log.push('begin');return {mayExecute:false,status:'uncertain',replayed:true};};
  assert.deepEqual(await f.run(),{status:'verified',executed:false});
  assert.deepEqual(f.log,['load','acquire','observe','refresh','begin','recover','release']);
});
test('an already-refreshed chain (stale loaded job, SQL unchanged) waits instead of beginning',async()=>{
  const f=refreshFixture('unchanged'),drifted=timestampDrift(f);f.deps.observe=async()=>{f.log.push('observe');return structuredClone(drifted);};
  assert.deepEqual(await f.run(),{status:'pending',executed:false});
  assert.deepEqual(f.log,['load','acquire','observe','refresh','release']);
});
test('identical guard never refreshes',async()=>{
  const f=refreshFixture();assert.deepEqual(await f.run(),{status:'verified',executed:true});assert.ok(!f.log.includes('refresh'));
});
for(const [name,make] of [
  ['media alt',f=>timestampDrift(f,p=>p.media.nodes[1].alt='merchant edit')],
  ['media updatedAt',f=>timestampDrift(f,p=>p.media.nodes[1].updatedAt='2026-09-30T17:00:05Z')],
  ['media order',f=>timestampDrift(f,p=>p.media.nodes.reverse())],
  ['added media',f=>timestampDrift(f,p=>{p.media.nodes.push(image(4));p.mediaCount.count=3;})],
  ['variant image',f=>timestampDrift(f,p=>p.variants.nodes[0].image=null)],
  ['media without timestamp drift',f=>{const r=response();r.data.product.media.nodes[1].alt='merchant edit';return {sourceFingerprint:f.context.sourceFingerprint,target:parse(r),observedAt:time};}],
  ['source fingerprint',f=>({...timestampDrift(f),sourceFingerprint:'e'.repeat(64)})],
]) test(`real ${name} change never refreshes; begin keeps the SQL conflict path`,async()=>{
  const f=refreshFixture(),changed=make(f);f.deps.observe=async()=>{f.log.push('observe');return structuredClone(changed);};
  f.deps.begin=async()=>{f.log.push('begin');return {mayExecute:false,status:'conflict'};};
  assert.deepEqual(await f.run(),{status:'conflict',executed:false});
  assert.ok(!f.log.includes('refresh'));assert.ok(f.log.includes('begin'));assert.ok(!f.log.includes('execute'));
});
test('a forward product updatedAt bump between begin and the call does not hold an associate',async()=>{
  const f=refreshFixture();let observations=0;const drifted=timestampDrift(f);
  f.deps.observe=async()=>{f.log.push('observe');return ++observations===1?f.guard():structuredClone(drifted);};
  assert.deepEqual(await f.run(),{status:'verified',executed:true});
  assert.deepEqual(f.log,['load','acquire','observe','begin','observe','execute','uncertain:accepted','recover','release']);
});
for(const [phase,build,ack] of [
  ['detach_old',f=>api.buildMediaReferenceDetach(f.context,f.snapshot,image(2).id,'detach_old'),()=>({fileUpdate:{files:[image(2)],userErrors:[]}})],
  ['detach_reference',f=>api.buildMediaReferenceDetach(f.context,f.snapshot,image(2).id,'detach_reference'),()=>({fileUpdate:{files:[image(2)],userErrors:[]}})],
  ['reorder',f=>api.buildMediaReorder(f.context,f.snapshot,[image(2).id,image(1).id]),()=>({productReorderMedia:{job:{id:'gid://shopify/Job/123'},mediaUserErrors:[]}})],
]) test(`a forward product updatedAt bump between begin and the call does not hold ${phase}`,async()=>{
  const f=refreshFixture();let observations=0;const drifted=timestampDrift(f);f.job.request=build(f);
  f.deps.begin=async(_ref,_lease,attemptId,intent)=>{f.log.push('begin');return {mayExecute:true,phase:journal.mediaJournalPhase(f.job.request),attemptId,requestHash:'d'.repeat(64),request:intent,replayed:false};};
  f.deps.execute=async()=>{f.log.push('execute');return {data:ack()};};
  f.deps.observe=async()=>{f.log.push('observe');return ++observations===1?f.guard():structuredClone(drifted);};
  assert.deepEqual(await f.run(),{status:'verified',executed:true});
  assert.deepEqual(f.log,['load','acquire','observe','begin','observe','execute','uncertain:accepted','recover','release']);
});
for(const [name,make] of [
  ['media alt',f=>timestampDrift(f,p=>p.media.nodes[1].alt='merchant edit')],
  ['media updatedAt',f=>timestampDrift(f,p=>p.media.nodes[1].updatedAt='2026-09-30T17:00:05Z')],
  ['backward product timestamp',f=>{const r=response();r.data.product.updatedAt='2026-09-29T00:00:00Z';return {sourceFingerprint:f.context.sourceFingerprint,target:parse(r),observedAt:time};}],
  ['source fingerprint',f=>({...timestampDrift(f),sourceFingerprint:'e'.repeat(64)})],
]) test(`real ${name} change between begin and the call still holds before sending`,async()=>{
  const f=refreshFixture();let observations=0;const changed=make(f);
  f.deps.observe=async()=>{f.log.push('observe');return ++observations===1?f.guard():structuredClone(changed);};
  assert.deepEqual(await f.run(),{status:'conflict',executed:false});
  assert.ok(!f.log.includes('refresh'));assert.ok(f.log.includes('conflict'));assert.ok(!f.log.includes('execute'));
});
test('create_owned stays strict: a post-begin timestamp bump holds before sending',async()=>{
  const f=refreshFixture();let observations=0;const drifted=timestampDrift(f);
  f.job.request=api.buildOwnedMediaCreate(f.context,f.staged,'');f.job.sourceEvidenceId='evidence-1';f.job.scopes=['write_files'];
  f.deps.begin=async(_ref,_lease,attemptId,intent)=>{f.log.push('begin');return {mayExecute:true,phase:'create_owned',attemptId,requestHash:'d'.repeat(64),request:intent,replayed:false};};
  f.deps.observe=async()=>{f.log.push('observe');return ++observations===1?f.guard():structuredClone(drifted);};
  assert.deepEqual(await f.run(),{status:'conflict',executed:false});
  assert.ok(f.log.includes('begin'));assert.ok(f.log.includes('conflict'));assert.ok(!f.log.includes('execute'));
});
test('a backward product timestamp never refreshes; begin keeps the SQL conflict path',async()=>{
  const f=refreshFixture();const r=response();r.data.product.updatedAt='2026-09-29T00:00:00Z';
  const back={sourceFingerprint:f.context.sourceFingerprint,target:parse(r),observedAt:time};
  f.deps.observe=async()=>{f.log.push('observe');return structuredClone(back);};
  f.deps.begin=async()=>{f.log.push('begin');return {mayExecute:false,status:'conflict'};};
  assert.deepEqual(await f.run(),{status:'conflict',executed:false});
  assert.ok(!f.log.includes('refresh'));assert.ok(f.log.includes('begin'));
});
test('onlyForwardProductTimestampDrift accepts only a forward product timestamp',()=>{
  const f=fixture(),before=f.snapshot,fwd=timestampDrift(f).target;
  assert.equal(read.onlyForwardProductTimestampDrift(fwd,before),true);
  assert.equal(read.onlyForwardProductTimestampDrift(before,structuredClone(before)),false);
  assert.equal(read.onlyForwardProductTimestampDrift(before,fwd),false);
  assert.equal(read.onlyForwardProductTimestampDrift(timestampDrift(f,p=>p.media.nodes[0].alt='x').target,before),false);
  assert.deepEqual([...read.PRODUCT_TIMESTAMP_TOLERANT_PHASES].sort(),['associate','detach_old','detach_reference','reorder','variant_reassign']);
  assert.ok(Object.isFrozen(read.PRODUCT_TIMESTAMP_TOLERANT_PHASES));
});
