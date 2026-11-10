import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
Error.stackTraceLimit = 0;

const sql = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const patch = sql('20261110072708_ordinary_media_reorder_timestamps.sql');
const ts = name => readFileSync(new URL(`../src/lib/shopify/${name}.ts`, import.meta.url), 'utf8');
const coreUrl = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(resolveImageLimits(ts('media-sync-core')))).toString('base64');
const core = await import(coreUrl);
const read = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(resolveImageLimits(ts('media-transport-read')))
  .replaceAll('from "./media-sync-core";', `from "${coreUrl}";`)).toString('base64'));
const hash = x => createHash('sha256').update(x).digest('hex');
const j = JSON.stringify;
const stamp = '2026-11-10T07:00:00.123456Z';

async function rpc(db, name, args) {
  return (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`,
    args.map(x => x && typeof x === 'object' ? j(x) : x))).rows[0].result;
}
async function fingerprint(db, raw) {
  raw.revision = (await db.query('select toptik_media_private.raw_transport_fingerprint($1::jsonb) result', [j(raw)])).rows[0].result;
  return raw;
}
async function createDb() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table public.shopify_gallery_copy_eligibility(product_gid text primary key,catalog_key text,carousel_item_id uuid,variant_gid text,exact_gallery_sku text,exact_shopify_sku text,approved_product_handle text,enabled boolean);
    create table public.shopify_gallery_reconciliation_leases(product_gid text primary key,owner uuid,expires_at timestamptz);
    create table public.shopify_webhook_events(id uuid,topic text,shop_domain text,payload jsonb,delivery_id text);
    create function public.assert_shopify_verified_copy_identity(p_item uuid,p_key text,p_gsku text,p_product text,p_variant text,p_ssku text)
    returns void language plpgsql as $$begin
      if not exists(select 1 from public.shopify_gallery_copy_eligibility where product_gid=p_product and catalog_key=p_key and carousel_item_id=p_item and exact_gallery_sku=p_gsku and variant_gid=p_variant and exact_shopify_sku=p_ssku and enabled)then raise exception'COPY_IDENTITY_CHANGED';end if;
    end$$;`);
  for (const name of ['20260930_media_sync_journal.sql', '20260930_media_transport_substeps.sql', '20260930_media_transport_runtime.sql',
    '20261001_existing_media_25mp.sql', '20261007_media_final_readback.sql', '20261007_media_transport_not_sent_precondition.sql',
    '20261007_media_transport_guard_refresh.sql']) await db.exec(sql(name));
  return db;
}
let serial = 8000;
async function fixture(db) {
  const n = serial++, owner = randomUUID(), op = randomUUID();
  const identity = { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(),
    exactGallerySku: `SKU-${n}`, exactShopifySku: `SKU${n}`, productHandle: `fixture-${n}` };
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)',
    [identity.productId, `SKU${n}`, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval'5 minutes')", [identity.productId, owner]);
  const asset = (key, side) => ({ key, contentId: hash(key), alt: `Photo ${key}`, evidenceId: `p${n}-${side}-${key}` });
  const base = Object.fromEntries(['gallery', 'shopify'].map(side => [side,
    { identity, side, revision: `${side}-v1`, complete: true, assets: ['a', 'b', 'c'].map(k => asset(k, side)) }]));
  const proofs = Object.values(base).flatMap(s => s.assets.map(a => ({ evidenceId: a.evidenceId, key: a.key, side: s.side, contentId: a.contentId, proof: {
    platformRef: s.side === 'shopify' ? `gid://shopify/MediaImage/${a.key.charCodeAt(0)}` : `owned/${a.key}.png`,
    url: s.side === 'shopify' ? `https://cdn.shopify.com/s/files/1/0001/${a.key}.png` : `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/${a.key}.png`,
    decodedSha256: a.contentId, mime: 'image/png', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(),
    ownership: s.side === 'shopify' ? 'reference_only' : 'owned_storage' } })));
  const approval = randomUUID();
  await rpc(db, 'bootstrap_toptik_media', [identity.productId, owner, approval, base, proofs, { evidenceId: `review-${n}` }]);
  await rpc(db, 'set_toptik_media_enabled', [identity.productId, owner, randomUUID(), true, approval]);
  const media = base.shopify.assets.map(a => ({ mediaId: `gid://shopify/MediaImage/${a.key.charCodeAt(0)}`, mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY',
    updatedAt: stamp, alt: a.alt, image: { id: `gid://shopify/ImageSource/${a.key.charCodeAt(0) + 1000}`, url: `https://cdn.shopify.com/s/files/1/0001/${a.key}.png`, width: 800, height: 900 } }));
  const before = await fingerprint(db, { side: 'shopify', identity, complete: true, revision: '', updatedAt: stamp, media,
    variantMediaIds: [media[0].mediaId], variantImage: { id: 'gid://shopify/ProductImage/999', url: media[0].image.url } });
  const current = structuredClone(base);
  current.shopify.revision = (await db.query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) result', [j(before)])).rows[0].result;
  current.gallery.assets = [current.gallery.assets[1], current.gallery.assets[0], current.gallery.assets[2]];
  current.gallery.revision = 'gallery-reordered';
  const plan = core.reconcileMedia(base, current);
  assert.equal(plan.patches.length, 0); assert.equal(plan.orders.length, 1); assert.equal(plan.orders[0].target, 'shopify');
  await rpc(db, 'reserve_toptik_media_operation', [identity.productId, owner, op, 1, current, plan]);
  await rpc(db, 'begin_toptik_media_step', [identity.productId, owner, op, 0, randomUUID(), current]);
  const guard = raw => ({ sourceFingerprint: core.mediaSnapshotFingerprint(current.gallery), target: raw, observedAt: new Date().toISOString() });
  await rpc(db, 'prepare_toptik_media_transport', [identity.productId, owner, op, 0, randomUUID(), ['reorder'], guard(before)]);
  const desiredIds = [media[1].mediaId, media[0].mediaId, media[2].mediaId];
  const request = { mutationSha256: 'f'.repeat(64), mediaGids: desiredIds };
  const begin = raw => rpc(db, 'begin_toptik_media_transport', [identity.productId, owner, op, 0, 0, randomUUID(), request, guard(raw)]);
  const after = structuredClone(before); after.media = [after.media[1], after.media[0], after.media[2]];
  after.updatedAt = '2026-11-10T07:01:00Z';
  for (const m of after.media.slice(0, 2)) m.updatedAt = '2026-11-10T07:01:00.123457Z';
  await fingerprint(db, after);
  const accept = (permit, raw) => rpc(db, 'accept_toptik_media_transport', [identity.productId, owner, op, 0, 0, randomUUID(), guard(raw),
    { requestHash: permit.requestHash, readbackSha256: raw.revision, artifact: null }]);
  return { before, after, begin, accept, guard, desiredIds, current, identity, owner, op, request };
}

test('actual ordinary reorder acceptance and final readback allow only moved-position timestamp advances', { timeout: 60000 }, async t => {
  const db = await createDb();
  try {
    const signatures = ['public.accept_toptik_media_transport(text,uuid,uuid,integer,integer,uuid,jsonb,jsonb)',
      'public.accept_toptik_media_final_readback(text,uuid,uuid,integer,uuid,jsonb,jsonb)',
      'public.begin_toptik_media_transport(text,uuid,uuid,integer,integer,uuid,jsonb,jsonb)',
      'public.refresh_toptik_media_transport_guard(text,uuid,uuid,integer,integer,uuid,jsonb)'];
    const definitions = async () => (await db.query(`select p.oid::regprocedure::text signature,p.proowner,p.proacl,p.prosecdef,p.proconfig,
      md5(pg_get_functiondef(p.oid)) definition from pg_proc p where p.oid=any($1::regprocedure[]) order by 1`, [signatures])).rows;
    const oldDefinitions = await definitions();
    await t.test('the exact previous SQL reproduces the false conflict', async () => {
      const f = await fixture(db); const permit = await f.begin(f.before); assert.equal(permit.mayExecute, true);
      assert.equal((await f.accept(permit, f.after)).status, 'conflict');
    });
    await t.test('a duplicated predecessor block aborts atomically instead of patching twice', async () => {
      const original = (await db.query('select pg_get_functiondef($1::regprocedure) result', [signatures[0]])).rows[0].result.replaceAll('\r\n', '\n');
      const oldBlock = patch.match(/old_block text:=\$old\$([\s\S]*?)\$old\$;/)[1];
      assert.ok(original.includes(oldBlock));
      await db.exec(original.replace(oldBlock, oldBlock + oldBlock));
      const duplicated = (await db.query('select pg_get_functiondef($1::regprocedure) result', [signatures[0]])).rows[0].result;
      await assert.rejects(db.exec(patch), /MEDIA_REORDER_ACCEPT_PREDECESSOR_CHANGED/);
      await db.exec('rollback');
      assert.equal((await db.query('select pg_get_functiondef($1::regprocedure) result', [signatures[0]])).rows[0].result, duplicated);
      assert.equal((await db.query("select to_regprocedure('toptik_media_private.reorder_media_matches(jsonb,jsonb,jsonb)') result")).rows[0].result, null);
      await db.exec(original);
    });
    await db.exec(patch);
    await t.test('RPC ACLs and every before-call/final function definition are preserved', async () => {
      const updated = await definitions();
      assert.deepEqual(updated.map(x => ({ ...x, definition: '' })), oldDefinitions.map(x => ({ ...x, definition: '' })));
      for (const old of oldDefinitions.filter(x => !x.signature.startsWith('accept_toptik_media_transport('))) {
        assert.deepEqual(updated.find(x => x.signature === old.signature), old);
      }
      const rights = (await db.query(`select
        has_function_privilege('anon','toptik_media_private.reorder_media_matches(jsonb,jsonb,jsonb)','EXECUTE') anon,
        has_function_privilege('authenticated','toptik_media_private.reorder_media_matches(jsonb,jsonb,jsonb)','EXECUTE') auth,
        has_function_privilege('service_role','toptik_media_private.reorder_media_matches(jsonb,jsonb,jsonb)','EXECUTE') service`)).rows[0];
      assert.deepEqual(rights, { anon: false, auth: false, service: false });
    });
    await t.test('moved timestamps pass real begin, accept and unmodified final readback', async () => {
      const f = await fixture(db), permit = await f.begin(f.before);
      assert.equal(permit.mayExecute, true); assert.equal(read.matchesMediaReorderReadback(f.before, f.after, f.desiredIds), true);
      assert.equal((await f.accept(permit, f.after)).status, 'verified');
      const observed = structuredClone(f.current);
      observed.shopify.assets = [observed.shopify.assets[1], observed.shopify.assets[0], observed.shopify.assets[2]];
      observed.shopify.revision = (await db.query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) result', [j(f.after)])).rows[0].result;
      const result = await rpc(db, 'accept_toptik_media_final_readback', [f.identity.productId, f.owner, f.op, 0, randomUUID(), observed, f.guard(f.after)]);
      assert.equal(result.status, 'verified');
      const chain = (await db.query('select current_guard,status from toptik_media_private.transport_chains where operation_id=$1', [f.op])).rows[0];
      assert.equal(chain.status, 'verified'); assert.deepEqual(chain.current_guard.target, f.after);
    });
    for (const [name, mutate] of [
      ['unchanged-position timestamp', r => { r.media[2].updatedAt = '2026-11-10T07:01:00Z'; }],
      ['moved timestamp backwards by one microsecond', r => { r.media[0].updatedAt = '2026-11-10T07:00:00.123455Z'; }],
      ['changed ALT', r => { r.media[0].alt = 'foreign color'; }],
      ['changed URL', r => { r.media[0].image.url += '?v=2'; }],
      ['changed image ID', r => { r.media[0].image.id = 'gid://shopify/ImageSource/123456'; }],
      ['changed dimensions', r => { r.media[0].image.width++; }],
      ['changed status', r => { r.media[0].status = 'PROCESSING'; }],
      ['changed native association', r => { r.variantMediaIds = [r.media[0].mediaId]; r.variantImage.url = r.media[0].image.url; }],
      ['changed native primary', r => { r.variantImage.id = 'gid://shopify/ProductImage/123456'; }],
      ['wrong order', r => { r.media.reverse(); }],
    ]) await t.test(`${name} remains a durable conflict in SQL and fails local proof`, async () => {
      const f = await fixture(db), permit = await f.begin(f.before); mutate(f.after); await fingerprint(db, f.after);
      assert.equal(read.matchesMediaReorderReadback(f.before, f.after, f.desiredIds), false);
      assert.equal((await f.accept(permit, f.after)).status, 'conflict');
    });
    for (const value of ['', null, 'infinity', 'not-a-date', '2026-02-30T00:00:00Z', '2026-11-10T24:00:00Z', '2026-11-10T07:01:00+16:00']) {
      await t.test(`invalid timestamp ${String(value)} never proves reorder`, async () => {
        const f = await fixture(db); f.after.media[0].updatedAt = value; await fingerprint(db, f.after);
        assert.equal(read.matchesMediaReorderReadback(f.before, f.after, f.desiredIds), false);
        const result = (await db.query('select toptik_media_private.reorder_media_matches($1,$2,$3) result',
          [j(f.before.media), j(f.desiredIds), j(f.after.media)])).rows[0].result;
        assert.equal(result, false);
      });
    }
    await t.test('before-call timestamp drift still conflicts, including moved IDs', async () => {
      const f = await fixture(db), raw = structuredClone(f.before); raw.media[0].updatedAt = '2026-11-10T07:01:00Z'; await fingerprint(db, raw);
      assert.equal((await f.begin(raw)).status, 'conflict');
    });
    await t.test('an unchanged order has no timestamp exception', async () => {
      const f = await fixture(db), ids = f.before.media.map(m => m.mediaId);
      assert.equal(read.matchesMediaReorderReadback(f.before, f.before, ids), true);
      const changed = structuredClone(f.before); changed.media[0].updatedAt = '2026-11-10T07:01:00Z'; await fingerprint(db, changed);
      assert.equal(read.matchesMediaReorderReadback(f.before, changed, ids), false);
      assert.equal((await db.query('select toptik_media_private.reorder_media_matches($1,$2,$3) result',
        [j(f.before.media), j(ids), j(changed.media)])).rows[0].result, false);
    });
    await t.test('source compare-and-swap still records concurrent source edits as conflict', async () => {
      const f = await fixture(db), permit = await f.begin(f.before);
      f.current.gallery.assets[0].alt = 'external edit';
      assert.equal((await f.accept(permit, f.after)).status, 'conflict');
    });
    await t.test('final readback keeps the exact accepted media timestamp baseline', async () => {
      const f = await fixture(db), permit = await f.begin(f.before);
      assert.equal((await f.accept(permit, f.after)).status, 'verified');
      const changed = structuredClone(f.after); changed.media[0].updatedAt = '2026-11-10T07:02:00Z'; await fingerprint(db, changed);
      const observed = structuredClone(f.current);
      observed.shopify.assets = [observed.shopify.assets[1], observed.shopify.assets[0], observed.shopify.assets[2]];
      observed.shopify.revision = (await db.query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) result', [j(changed)])).rows[0].result;
      const result = await rpc(db, 'accept_toptik_media_final_readback', [f.identity.productId, f.owner, f.op, 0, randomUUID(), observed, f.guard(changed)]);
      assert.equal(result.status, 'conflict'); assert.equal(result.code, 'MEDIA_FINAL_READBACK_CONCURRENT_CHANGE');
    });
    await t.test('the patch reruns without altering other function definitions or privileges', async () => {
      const before = await definitions(); await db.exec(patch); assert.deepEqual(await definitions(), before);
    });
  } finally { await db.close(); }
});
