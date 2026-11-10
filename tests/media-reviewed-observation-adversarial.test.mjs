// Independent adversarial regression cases, isolated Postgres only; no network or live writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRestoredRetirementDatabase } from './helpers/media-restored-retirement-sql-fixture.mjs';
const f = await createRestoredRetirementDatabase(), { db, rpc } = f;
await db.exec(await readFile(new URL('../supabase/migrations/20261110191500_reviewed_gallery_observation_refresh.sql', import.meta.url), 'utf8'));
let serial = 41000;
async function seed({ observe = true } = {}) {
  const n = serial++, owner = randomUUID(), angle = randomUUID(), product = `gid://shopify/Product/${n}`;
  const identity = { productId: product, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(), exactGallerySku: 'SKU-' + n, exactShopifySku: 'SKU' + n, productHandle: 'source-' + n };
  const url = `https://cdn.shopify.com/s/files/1/0001/${n}.png`, oldId = 'g-old-' + n, newId = 'g-new-' + n;
  await db.query('insert into carousel_items(id,title,cover_image_path,catalog_number,cover_image_alt) values($1,$2,$3,$4,$2)', [identity.itemId, 'Photo', url, identity.exactGallerySku]);
  await db.query('insert into carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt) values($1,$2,$3,$4,1,$5)', [angle, identity.itemId, 'front', url, 'Photo']);
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [product, identity.exactShopifySku, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '10 minutes')", [product, owner]);
  const raw = await rpc('read_toptik_gallery_media', [product, owner]);
  const asset = (evidence, content = 'a'.repeat(64)) => ({ key: 'existing', contentId: content, evidenceId: evidence, alt: 'Photo' });
  const pair = Object.fromEntries(['gallery', 'shopify'].map(side => [side, { identity, side, revision: side === 'gallery' ? raw.revision : 'native-v1', complete: true, assets: [asset(side === 'gallery' ? oldId : 's-old-' + n)] }]));
  const proof = (side, evidence, hash, u = url) => ({ key: 'existing', side, evidenceId: evidence, contentId: hash, proof: { url: u, platformRef: side === 'gallery' ? `angle:${angle}` : `gid://shopify/MediaImage/${n}`, decodedSha256: hash, width: 40, height: 60, mime: 'image/png', byteLength: 100, ownership: 'reference_only', verifiedAt: new Date().toISOString() } });
  const approval = randomUUID(); await rpc('bootstrap_toptik_media', [product, owner, approval, pair, [proof('gallery', oldId, 'a'.repeat(64)), proof('shopify', 's-old-' + n, 'a'.repeat(64))], { evidenceId: 'approved-' + n }]);
  await rpc('set_toptik_media_enabled', [product, owner, randomUUID(), true, approval]);
  const refs = [{ role: 'cover', angleId: null, key: 'existing', evidenceId: oldId }, { role: 'angle', angleId: angle, key: 'existing', evidenceId: oldId }];
  if (observe) await rpc('observe_toptik_gallery_media', [product, owner, raw.revision, refs]);
  await rpc('register_toptik_media_provenance', [product, owner, [proof('gallery', newId, 'b'.repeat(64))]]);
  const next = refs.map(r => ({ ...r, evidenceId: newId }));
  return { identity, product, owner, angle, raw, refs, next, newId, url, proof, n, args: [product, owner, raw.revision, next, [newId]] };
}
const audits = async x => (await db.query('select count(*)::int n from toptik_media_private.observation_refreshes where product_gid=$1', [x.product])).rows[0].n;

test('A1 authorized list with an extra id besides the right one is refused', async () => {
  const x = await seed(); x.args[4] = [x.newId, 'extra-unrelated-id'];
  await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation', x.args), /REVIEW_REQUIRED/); assert.equal(await audits(x), 0);
});
test('A2 second refresh with the same expected revision fails and leaves exactly one receipt', async () => {
  const x = await seed(); await rpc('refresh_toptik_reviewed_gallery_observation', x.args);
  await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation', x.args), /CAS_CHANGED/); assert.equal(await audits(x), 1);
});
test('A3 swapped reference order is refused', async () => {
  const x = await seed(); x.args[3] = [x.next[1], x.next[0]];
  await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation', x.args), /REFERENCE_INVALID|SOURCE_CHANGED|INCOMPLETE/); assert.equal(await audits(x), 0);
});
test('A4 cover keeps the old evidence while the angle moves to the new one (alias split) is refused', async () => {
  const x = await seed(); x.args[3] = [x.refs[0], x.next[1]];
  await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation', x.args), /ALIAS|SOURCE_CHANGED|REVIEW_REQUIRED|PROVENANCE/); assert.equal(await audits(x), 0);
});
test('A5 new evidence registered for a different URL than the current path is refused', async () => {
  const x = await seed(); const other = 'g-other-' + x.n;
  await rpc('register_toptik_media_provenance', [x.product, x.owner, [x.proof('gallery', other, 'c'.repeat(64), x.url + '?other=1')]]);
  x.args[3] = x.next.map(r => ({ ...r, evidenceId: other })); x.args[4] = [other];
  await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation', x.args), /PROVENANCE|SOURCE_CHANGED/); assert.equal(await audits(x), 0);
});
test('A6 product never observed at the current revision is not applicable', async () => {
  const x = await seed({ observe: false });
  await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation', x.args), /NOT_APPLICABLE/); assert.equal(await audits(x), 0);
});
test('A7 ordinary catalog edit between observation and refresh makes the refresh stale', async () => {
  const x = await seed(); await db.query('update carousel_items set title=$1 where id=$2', ['Edited', x.identity.itemId]);
  await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation', x.args), /CAS_CHANGED|NOT_APPLICABLE/); assert.equal(await audits(x), 0);
});
test('A8 after a refresh the old revision observation is untouched and a later ordinary edit still works', async () => {
  const x = await seed(); const after = await rpc('refresh_toptik_reviewed_gallery_observation', x.args);
  const old = (await db.query('select revision from toptik_media_private.gallery_observations where product_gid=$1 order by created_at', [x.product])).rows.map(r => r.revision);
  assert.deepEqual(old, [x.raw.revision, after.raw.revision]);
  await db.query('update carousel_items set title=$1 where id=$2', ['Edited later', x.identity.itemId]);
  const raw2 = await rpc('read_toptik_gallery_media', [x.product, x.owner]); assert.equal(raw2.version, after.raw.version + 1);
});
test.after(async () => { await db.close(); });
