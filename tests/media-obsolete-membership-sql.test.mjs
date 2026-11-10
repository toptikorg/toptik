import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createVerifiedImportDatabase} from './helpers/verified-native-import-sql-fixture.mjs';
import {fixture,core} from './helpers/media-planning-fixture.mjs';

for (const principal of ['admin_panel_token','supabase_user']) test(`real removal RPC appends an idempotent ${principal} Gallery-only decision without changing baseline or media`,async()=>{
 const f=await createVerifiedImportDatabase(),{db,rpc}=f;
 try{
  const b=fixture(),identity=b.context.identity,owner=randomUUID(),requestId=randomUUID(),key='g-angle:'+randomUUID();
  const baseline=structuredClone(b.pair),old={key,contentId:'c'.repeat(64),evidenceId:'g-old',alt:'Old Gallery only'};
  baseline.gallery.assets.push(old);
  const proofs=b.context.provenance.map(p=>({side:p.side,key:p.asset_key,contentId:p.content_id,evidenceId:p.evidence_id,proof:{...p.proof,verifiedAt:new Date().toISOString()}}));
  proofs.push({side:'gallery',key,contentId:old.contentId,evidenceId:old.evidenceId,proof:{...proofs[0].proof,platformRef:'angle:'+randomUUID(),url:'https://cdn.shopify.com/s/files/1/old.png',decodedSha256:old.contentId}});
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)',[identity.productId,'ABC01',identity.itemId,identity.variantId,identity.exactGallerySku,identity.exactShopifySku,identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '5 minutes')",[identity.productId,owner]);
  const approval=randomUUID();await rpc('bootstrap_toptik_media',[identity.productId,owner,approval,baseline,proofs,{evidenceId:'independent-reviewed-bootstrap'}]);
  await rpc('set_toptik_media_enabled',[identity.productId,owner,randomUUID(),true,approval]);
  const before=(await db.query('select version,baselines from toptik_media_private.state where product_gid=$1',[identity.productId])).rows[0];
  const fingerprint=core.mediaSnapshotFingerprint(baseline.gallery),actor={kind:'authenticated_editor',actorType:principal,actorId:principal==='admin_panel_token'?'configured-admin-panel':randomUUID(),requestId,origin:'https://landing.toptik.co.il'};
  const args=[identity.productId,owner,requestId,'gallery',key,fingerprint,actor];
  const first=await rpc('record_toptik_media_removal',args),again=await rpc('record_toptik_media_removal',args);
  assert.deepEqual(first,again);assert.equal(first.key,key);assert.equal(first.kind,'authenticated_editor');
  assert.equal((await db.query('select count(*)::int n from toptik_media_private.removal_intents')).rows[0].n,1);
  assert.deepEqual((await db.query('select version,baselines from toptik_media_private.state where product_gid=$1',[identity.productId])).rows[0],before);
  assert.equal((await db.query('select count(*)::int n from toptik_media_private.operations')).rows[0].n,0);
  const plan=core.reconcileMedia(baseline,b.pair,[first]);assert.equal(plan.conflicts.length,0);assert.equal(plan.patches.length,0);assert.equal(plan.orders.length,0);
  await assert.rejects(rpc('record_toptik_media_removal',[...args.slice(0,6),{...actor,actorId:'different'}]),/MEDIA_REQUEST_REUSED/);
  const stale=randomUUID();await assert.rejects(rpc('record_toptik_media_removal',[identity.productId,owner,stale,'gallery',key,'f'.repeat(64),{...actor,requestId:stale}]),/MEDIA_REMOVAL_BASELINE_STALE/);
  const forged=randomUUID();await assert.rejects(rpc('record_toptik_media_removal',[identity.productId,owner,forged,'gallery',key,fingerprint,{...actor,requestId:forged,actorId:'unverified'}]),/MEDIA_REMOVAL_AUTH_INVALID/);
  assert.equal((await db.query('select count(*)::int n from toptik_media_private.removal_intents')).rows[0].n,1);
 }finally{await db.close();}
});
