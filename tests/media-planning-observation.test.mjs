import test from 'node:test';import assert from 'node:assert/strict';
import{mod,stripped,galleryUrl,readyUrl,ready,core,fixture,id,owner,now,url}from'./helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
const api=await import(mod(`import{createHash}from'node:crypto';import{galleryRawToSnapshot}from'${galleryUrl}';import{mediaReadToSnapshot}from'${readyUrl}';const assertNotDeniedMedia=()=>{};const requireReviewedMedia=()=>{};const isReviewedMediaProof=()=>false;const reviewedMediaRegistry=()=>({});const loadReviewedMedia=async()=>[];${stripped('media-planning-observation')}`));
function f(){const v=fixture(),calls=[];const deps={now:()=>now,capture:async(i,u,d)=>{calls.push(['decode',i,u,d]);return v.bytes;},shopify:async()=>v.read,gallery:()=>({read:async()=>v.raw})};return {...v,calls,deps,run:()=>api.captureMediaPlanningPair(v.context,owner,now+30000,deps)};}

test('capture prefetch deduplicates exact URLs and has at most three active decoders',async()=>{
 const x=f(),started=[],releases=[];let active=0,max=0;
 const run=api.captureMediaMetadataSources(['a','b','a','c','d','e'],async u=>{started.push(u);active++;max=Math.max(max,active);await new Promise(r=>releases.push(r));active--;return x.bytes;},()=>{});
 assert.deepEqual(started,['a','b','c']);releases.splice(0).forEach(r=>r());await new Promise(r=>setImmediate(r));assert.deepEqual(started,['a','b','c','d','e']);
 releases.splice(0).forEach(r=>r());const out=await run;
 assert.equal(max,3);assert.equal(active,0);assert.equal(out.size,5);assert.ok([...out.values()].every(v=>!Object.hasOwn(v,'bytes')));
});
test('capture prefetch joins every started read on failure and never schedules the remaining URLs',async()=>{
 const x=f(),started=[],pending=new Map(),error=Error('MEDIA_SOURCE_DOWNLOAD_FAILED');let settled=false;
 const run=api.captureMediaMetadataSources(['a','b','c','d','e'],async u=>{started.push(u);return new Promise((resolve,reject)=>pending.set(u,{resolve,reject}));},()=>{});
 const outcome=run.then(()=>{settled=true;return null;},e=>{settled=true;return e;});pending.get('a').reject(error);
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(started,['a','b','c']);
 pending.get('b').resolve(x.bytes);await new Promise(r=>setImmediate(r));assert.equal(settled,false);
 pending.get('c').reject(Error('LATER_ERROR'));assert.equal(await outcome,error);assert.deepEqual(started,['a','b','c']);
});
test('capture prefetch preserves the shared deadline and joins reads after expiry',async()=>{
 const x=f(),pending=[],started=[];let expired=false,settled=false;
 const check=()=>{if(expired)throw Error('MEDIA_PLANNING_TIME_BUDGET');};
 const run=api.captureMediaMetadataSources(['a','b','c','d'],async u=>{started.push(u);await new Promise(r=>pending.push(r));return x.bytes;},check);
 const outcome=run.then(()=>{settled=true;},e=>{settled=true;return e;});expired=true;pending.shift()();await new Promise(r=>setImmediate(r));assert.equal(settled,false);
 pending.splice(0).forEach(r=>r());assert.match((await outcome).message,/TIME_BUDGET/);assert.deepEqual(started,['a','b','c']);
});
test('prefetch does not read the byte buffer and exact query variants remain separate',async()=>{
 const x=f(),urls=[];Object.defineProperty(x.bytes,'bytes',{get(){throw Error('BUFFER_RETAINED');}});
 const out=await api.captureMediaMetadataSources(['a?v=1','a?v=2','a?v=1'],async u=>{urls.push(u);return x.bytes;},()=>{});
 assert.deepEqual(urls,['a?v=1','a?v=2']);assert.equal(out.size,2);
});
test('actual mappers preserve both independent baselines and immutable provenance',async()=>{const x=f(),out=await x.run();assert.deepEqual(out.pair,x.pair);assert.deepEqual(out.refs,x.refs);assert.equal(out.proofs.length,2);assert.equal(x.calls.length,1,'same bytes at same URL decode once');assert.deepEqual(x.calls[0][1],id);});
test('planning consumes metadata only and never retains or reads source byte buffers',async()=>{
 const x=f();Object.defineProperty(x.bytes,'bytes',{get(){throw Error('PLANNING_MUST_NOT_READ_OR_RETAIN_BYTES');},enumerable:true});
 const out=await x.run();assert.deepEqual(out.pair,x.pair);assert.equal(x.calls.length,1);
 assert.ok(out.proofs.every(p=>!Object.hasOwn(p.proof,'bytes')));
});
test('new Gallery angle derives own UUID key, never existing Shopify positional identity',async()=>{const x=f(),a={...x.raw.angles[0],id:'a0000000-0000-4000-8000-000000000007',angle_order:2,image_path:url+'?new=1'};x.raw.angles.push(a);const out=await x.run();assert.equal(out.refs[2].key,`g-angle:${a.id}`);assert.notEqual(out.refs[2].key,'existing');assert.equal(out.pair.gallery.assets.length,2);assert.equal(out.pair.shopify.assets.length,1);assert.match(out.proofs.find(p=>p.key===out.refs[2].key).evidenceId,/^g:[a-f0-9]{64}$/);});
test('changed bytes on existing angle retain key but create new verified lineage',async()=>{const x=f();x.bytes.sha256='c'.repeat(64);const out=await x.run();assert.equal(out.pair.gallery.assets[0].key,'existing');assert.equal(out.pair.gallery.assets[0].contentId,'c'.repeat(64));assert.notEqual(out.pair.gallery.assets[0].evidenceId,'g-existing');});
test('known clone preserves original content identity from server receipt',async()=>{const x=f();for(const p of x.context.provenance)p.content_id='d'.repeat(64);for(const side of ['gallery','shopify'])x.context.baselines[side].assets[0].contentId='d'.repeat(64);x.context.provenance[1].proof.operationId='a0000000-0000-4000-8000-000000000009';const out=await x.run();assert.equal(out.pair.shopify.assets[0].contentId,'d'.repeat(64));assert.equal(out.pair.gallery.assets[0].contentId,'d'.repeat(64));});
test('conflicting same-product provenance is a hold, never a guessed merge',async()=>{const x=f();x.context.provenance.push({...structuredClone(x.context.provenance[0]),evidence_id:'other',content_id:'f'.repeat(64)});await assert.rejects(x.run(),/AMBIGUOUS_LINEAGE/);});
test('same Shopify MediaImage previously assigned multiple keys is held',async()=>{const x=f();x.context.provenance.push({...structuredClone(x.context.provenance[1]),evidence_id:'other',asset_key:'other'});await assert.rejects(x.run(),/AMBIGUOUS_LINEAGE/);});
test('multiple cover-equal angles without prior matching identity are held',async()=>{const x=f();x.context.galleryRefs=[];x.raw.angles.push({...x.raw.angles[0],id:'a0000000-0000-4000-8000-000000000007',angle_order:2});await assert.rejects(x.run(),/COVER_AMBIGUOUS|EQUIVALENT_TARGET_EXISTS/);});
test('cover previously shared with angle can become independent without hijacking angle',async()=>{const x=f();x.raw.item.cover_image_path=url+'?cover=1';const out=await x.run();assert.equal(out.refs[0].key,`g-cover:${id.itemId}`);assert.equal(out.refs[1].key,'existing');assert.equal(out.pair.gallery.assets.length,2);assert.equal(out.visuals.galleryCover,`g-cover:${id.itemId}`);assert.ok(`g-cover:${id.itemId}` in out.visuals.gallery);});
test('a cover that aliases an angle is not marked as a separate cover',async()=>{const out=await f().run();assert.equal(out.visuals.galleryCover,undefined);});
test('new Shopify media key derives ID, not nearby title/position/filename',async()=>{const x=f();x.product.media.nodes[0].id='gid://shopify/MediaImage/999';const fresh=ready.parseMediaReadResponse({data:{product:x.product}},id);x.deps.shopify=async()=>fresh;const out=await x.run();assert.equal(out.pair.shopify.assets[0].key,'s-media:999');assert.equal(out.pair.gallery.assets[0].key,'existing');});
test('Shopify image size must match actual decoded pixels',async()=>{const x=f();x.read.images[0].width++;await assert.rejects(x.run(),/IMAGE_DIMENSIONS_CHANGED/);});
test('Gallery change during remote decoding blocks publication of snapshot',async()=>{const x=f();x.deps.gallery=()=>({read:async()=>({...x.raw,revision:'e'.repeat(64)})});await assert.rejects(x.run(),/SOURCE_CHANGED_DURING_READ/);});
test('Shopify change during remote decoding blocks publication of snapshot',async()=>{const x=f();let n=0;x.deps.shopify=async()=>({...x.read,fingerprint:++n===1?x.read.fingerprint:'e'.repeat(64)});await assert.rejects(x.run(),/SOURCE_CHANGED_DURING_READ/);});
test('expired budget performs zero source reads',async()=>{const x=f();await assert.rejects(api.captureMediaPlanningPair(x.context,owner,now,x.deps),/TIME_BUDGET/);assert.equal(x.calls.length,0);});

function missingGalleryAngle({initialized=true}={}) {
 const x=f(),extra={...structuredClone(x.product.media.nodes[0]),id:'gid://shopify/MediaImage/2',image:{...x.product.media.nodes[0].image,id:'gid://shopify/ImageSource/2',url:url+'?side=1'}};
 x.product.media.nodes.push(extra);x.product.mediaCount.count=2;
 x.read=ready.parseMediaReadResponse({data:{product:x.product}},id);x.deps.shopify=async()=>x.read;
 const key=initialized?'store-only':'s-media:2',asset={...x.pair.shopify.assets[0],key,contentId:'c'.repeat(64),evidenceId:'s-side'};
 if(initialized){x.context.baselines.shopify.assets.push(asset);x.context.provenance.push({...structuredClone(x.context.provenance[1]),asset_key:key,evidence_id:'s-side',content_id:asset.contentId,proof:{...x.context.provenance[1].proof,platformRef:extra.id,url:extra.image.url,decodedSha256:asset.contentId}});}
 x.deps.capture=async(_i,u)=>({...x.bytes,sha256:u===url?x.bytes.sha256:'c'.repeat(64)});
 const angle={...x.raw.angles[0],id:'a0000000-0000-4000-8000-000000000007',angle_order:2,image_path:extra.image.url};x.raw.angles.push(angle);
 return {...x,extra,angle,key};
}
test('exact current Shopify URL copied to a new Gallery angle reuses unique decoded counterpart without duplicate attach',async()=>{
 const x=missingGalleryAngle(),out=await x.run();assert.equal(out.refs[2].key,x.key);assert.equal(out.pair.gallery.assets[1].contentId,'c'.repeat(64));
 const plan=core.reconcileMedia(x.context.baselines,out.pair,[],[]);assert.deepEqual(plan.conflicts,[]);assert.deepEqual(plan.patches,[]);
 assert.equal(plan.projected.shopify.length,2);
});
test('simultaneous exact new references share the real MediaImage key',async()=>{
 const x=missingGalleryAngle({initialized:false}),out=await x.run();assert.equal(out.refs[2].key,'s-media:2');
 const plan=core.reconcileMedia(x.context.baselines,out.pair,[],[]);assert.deepEqual(plan.conflicts,[]);assert.deepEqual(plan.patches,[]);
});
test('a new Gallery reference to transformed clone lineage is held without fabricating import evidence',async()=>{
 const x=missingGalleryAngle(),semantic='d'.repeat(64),receipt=x.context.provenance.find(p=>p.evidence_id==='s-side');receipt.content_id=semantic;receipt.proof.operationId='a0000000-0000-4000-8000-000000000009';
 x.context.baselines.shopify.assets.find(a=>a.key===x.key).contentId=semantic;
 await assert.rejects(x.run(),/IMPORT_LINEAGE_REQUIRES_REVIEW/);
});
test('exact reference with a conflicting alt remains a review rather than overwriting Shopify',async()=>{
 const x=missingGalleryAngle();x.angle.image_alt='different merchant description';const out=await x.run();
 const plan=core.reconcileMedia(x.context.baselines,out.pair,[],[]);assert.ok(plan.conflicts.length);assert.deepEqual(plan.patches,[]);
});
test('exact correspondence remains stable after refs and proofs are persisted',async()=>{
 const x=missingGalleryAngle(),first=await x.run();x.context.galleryRefs=first.refs;x.context.baselines=first.pair;
 x.context.provenance=first.proofs.map(p=>({product_gid:id.productId,side:p.side,asset_key:p.key,evidence_id:p.evidenceId,content_id:p.contentId,proof:p.proof}));
 const second=await x.run();assert.deepEqual(second.pair,first.pair);assert.deepEqual(second.refs,first.refs);
 assert.deepEqual(second.proofs.sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId)),first.proofs.sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId)));
});
test('same decoded bytes at a different URL do not manufacture correspondence',async()=>{
 const x=missingGalleryAngle();x.angle.image_path=url+'?different-source=1';const out=await x.run();assert.equal(out.refs[2].key,`g-angle:${x.angle.id}`);
});
test('duplicate current Shopify URL is ambiguous even with equal bytes',async()=>{
 const x=missingGalleryAngle();x.product.media.nodes.push({...x.extra,id:'gid://shopify/MediaImage/3',image:{...x.extra.image,id:'gid://shopify/ImageSource/3'}});x.product.mediaCount.count=3;
 const fresh=ready.parseMediaReadResponse({data:{product:x.product}},id);x.deps.shopify=async()=>fresh;await assert.rejects(x.run(),/EQUIVALENT_SOURCE_AMBIGUOUS/);
});
test('exact source already represented by another Gallery identity is held',async()=>{
 const x=f();x.raw.angles.push({...x.raw.angles[0],id:'a0000000-0000-4000-8000-000000000007',angle_order:2});await assert.rejects(x.run(),/EQUIVALENT_TARGET_EXISTS/);
});
test('new modal angle for independent cover preserves cover identity and does not synthesize removal',async()=>{
 const x=f(),coverUrl=url+'?cover=1';x.raw.item.cover_image_path=coverUrl;
 const oldCover={...x.context.galleryRefs[0],key:'independent-cover',evidenceId:'g-cover'};x.context.galleryRefs[0]=oldCover;
 const coverAsset={...x.context.baselines.gallery.assets[0],key:oldCover.key,evidenceId:oldCover.evidenceId,contentId:'c'.repeat(64)};x.context.baselines.gallery.assets.unshift(coverAsset);
 x.context.provenance.push({...structuredClone(x.context.provenance[0]),asset_key:oldCover.key,evidence_id:oldCover.evidenceId,content_id:coverAsset.contentId,proof:{...x.context.provenance[0].proof,url:coverUrl,decodedSha256:coverAsset.contentId,platformRef:`cover:${id.itemId}`}});
 x.deps.capture=async(_i,u)=>({...x.bytes,sha256:u===coverUrl?'c'.repeat(64):x.bytes.sha256});
 x.raw.angles.push({...x.raw.angles[0],id:'a0000000-0000-4000-8000-000000000007',angle_order:2,image_path:coverUrl});
 const out=await x.run();assert.equal(out.refs[0].key,'independent-cover');assert.equal(out.refs[2].key,'independent-cover');assert.equal(out.pair.gallery.assets.length,2);
 const plan=core.reconcileMedia(x.context.baselines,out.pair,[],[]);assert.ok(!plan.conflicts.some(c=>c.code==='MEDIA_REMOVAL_INTENT_REQUIRED'));assert.ok(!plan.patches.some(p=>p.kind==='detach_reference'||p.kind==='attach'));
});
