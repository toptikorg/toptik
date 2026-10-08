import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('../src/lib/shopify/media-sync-core.ts', import.meta.url), 'utf8');
const api = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const identity = { productId: 'gid://shopify/Product/7550812619002', variantId: 'gid://shopify/ProductVariant/42465754808570',
  itemId: '6f887176-e70a-44ba-b252-238f994b66ad', exactGallerySku: 'P10SZV24-05J-TU', exactShopifySku: 'P10SZV2405J', productHandle: 'logoduck-i-טרולי' };
const asset = (key, overrides = {}) => ({ key, contentId: key.charCodeAt(0).toString(16).padStart(64, '0'), alt: `תמונה ${key}`, evidenceId: `receipt-${key}`, ...overrides });
const snapshot = (side, assets) => ({ side, identity: structuredClone(identity), revision: `${side}-v1`, complete: true, assets });
const pair = (g = [asset('a'), asset('b')], s = structuredClone(g)) => ({ gallery: snapshot('gallery', g), shopify: snapshot('shopify', s) });
const clone = x => structuredClone(x);
const removal = (base, side, key) => ({ side, key, requestId: 'ddd236a0-1f03-4103-9ed5-8981f888c667',
  kind: side === 'gallery' ? 'authenticated_editor' : 'signed_shopify_event', expectedBaselineFingerprint: api.mediaSnapshotFingerprint(base[side]) });
const noMutation = plan => { assert.deepEqual(plan.patches, []); assert.deepEqual(plan.orders, []); };

test('bootstrap preserves different source-specific collections, alt and ordering', () => {
  const base = pair([asset('a'), asset('b')], [asset('c'), asset('b', { alt: 'store original' }), asset('a')]);
  const plan = api.reconcileMedia(base, clone(base)); noMutation(plan); assert.deepEqual(plan.conflicts, []);
});
test('different revisions or evidence receipts alone are not content edits', () => {
  const base = pair(), now = clone(base); now.shopify.revision = 's-v2'; now.shopify.assets[0].evidenceId = 'refreshed';
  noMutation(api.reconcileMedia(base, now));
});
for (const side of ['gallery', 'shopify']) test(`ordinary ${side} alt propagates only alt, preserving target file bytes`, () => {
  const base = pair(), now = clone(base), target = side === 'gallery' ? 'shopify' : 'gallery';
  now[side].assets[0].alt = 'תיק נסיעות צהוב';
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(plan.patches, [{ source: side, target, key: 'a', kind: 'alt', value: 'תיק נסיעות צהוב' }]);
  assert.equal(plan.projected[target][0].contentId, base[target].assets[0].contentId);
});
test('empty alt is a deliberate decorative-alt edit, distinct from missing field', () => {
  const base = pair(), now = clone(base); now.gallery.assets[0].alt = '';
  assert.equal(api.reconcileMedia(base, now).patches[0].value, '');
  delete now.gallery.assets[0].alt; assert.throws(() => api.reconcileMedia(base, now), /ASSET_INVALID/);
});
test('content replacement is a new reference, never global file mutation or alt overwrite', () => {
  const base = pair(), now = clone(base); now.gallery.assets[0].contentId = 'f'.repeat(64); now.gallery.assets[0].evidenceId = 'new-file';
  now.shopify.assets[0].alt = 'Shopify concurrent accessibility edit';
  const plan = api.reconcileMedia(base, now);
  assert.equal(plan.patches.length, 2);
  assert.deepEqual(plan.patches.find(p => p.kind === 'replace_reference').value, { contentId: 'f'.repeat(64), evidenceId: 'new-file' });
  assert.deepEqual(plan.projected.gallery.map(a => [a.key,a.contentId,a.alt]), plan.projected.shopify.map(a => [a.key,a.contentId,a.alt]));
  assert.deepEqual(plan.conflicts, []);
});
test('same-field concurrent edits conflict without discarding a safe edit to another image', () => {
  const base = pair(), now = clone(base); now.gallery.assets[0].alt = 'one'; now.shopify.assets[0].alt = 'two'; now.gallery.assets[1].alt = 'safe';
  const plan = api.reconcileMedia(base, now); assert.equal(plan.patches.length, 1); assert.equal(plan.patches[0].key, 'b');
  assert.deepEqual(plan.conflicts, [{ key: 'a', field: 'alt', code: 'MEDIA_CONCURRENT_FIELD' }]);
});
test('both sides reaching same value after uncertain acknowledgement does not repeat write', () => {
  const base = pair(), now = clone(base); now.gallery.assets[0].alt = now.shopify.assets[0].alt = 'same';
  noMutation(api.reconcileMedia(base, now));
});
test('new exact asset attaches at source anchors and keeps unrelated target assets', () => {
  const base = pair([asset('a'), asset('b')], [asset('a'), asset('z'), asset('b')]), now = clone(base);
  now.gallery.assets.splice(1, 0, asset('c'));
  const plan = api.reconcileMedia(base, now); assert.equal(plan.patches[0].kind, 'attach');
  assert.deepEqual(plan.projected.shopify.map(a => a.key), ['a','z','c','b']);
});
test('new source asset never overwrites an independently existing different target', () => {
  const base = pair([asset('a')], [asset('a'), asset('b', { alt: 'target' })]), now = clone(base);
  now.gallery.assets.push(asset('b')); const plan = api.reconcileMedia(base, now); noMutation(plan);
  assert.equal(plan.conflicts[0].code, 'MEDIA_EXISTING_TARGET_DIFFERENT');
});
test('missing or incomplete read cannot remove images', () => {
  const base = pair(), now = clone(base); now.gallery.assets.pop();
  const plan = api.reconcileMedia(base, now); noMutation(plan); assert.equal(plan.conflicts[0].code, 'MEDIA_REMOVAL_INTENT_REQUIRED');
  now.gallery.complete = false; assert.throws(() => api.reconcileMedia(base, now), /COMPLETE_SNAPSHOT_REQUIRED/);
});
test('even simultaneous disappearance needs removal evidence', () => {
  const base = pair(), now = clone(base); now.gallery.assets.pop(); now.shopify.assets.pop();
  assert.equal(api.reconcileMedia(base, now).conflicts[0].code, 'MEDIA_REMOVAL_INTENT_REQUIRED');
});
test('explicit removal detaches only this product reference and preserves target-only files', () => {
  const base = pair([asset('a'), asset('b')], [asset('a'), asset('b'), asset('z')]), now = clone(base); now.gallery.assets.pop();
  const plan = api.reconcileMedia(base, now, [removal(base,'gallery','b')]);
  assert.deepEqual(plan.patches, [{ source: 'gallery', target: 'shopify', key: 'b', kind: 'detach_reference' }]);
  assert.deepEqual(plan.projected.shopify.map(a => a.key), ['a','z']);
});
test('removal does not destroy a concurrent target edit or last image', () => {
  const base = pair(), now = clone(base); now.gallery.assets.pop(); now.shopify.assets[1].alt = 'new';
  assert.equal(api.reconcileMedia(base, now, [removal(base,'gallery','b')]).conflicts[0].code, 'MEDIA_REMOVE_VS_EDIT');
  const single = pair([asset('a')]), empty = clone(single); empty.gallery.assets = [];
  assert.equal(api.reconcileMedia(single, empty, [removal(single,'gallery','a')]).conflicts[0].code, 'MEDIA_LAST_IMAGE_PROTECTED');
});
test('stale, mismatched or duplicate removal evidence fails closed', () => {
  const base = pair(), now = clone(base), evidence = removal(base,'gallery','b'); now.gallery.assets.pop();
  assert.throws(() => api.reconcileMedia(base, now, [{ ...evidence, expectedBaselineFingerprint: '0'.repeat(64) }]), /EVIDENCE_INVALID/);
  assert.throws(() => api.reconcileMedia(base, now, [{ ...evidence, kind: 'signed_shopify_event' }]), /EVIDENCE_INVALID/);
  assert.throws(() => api.reconcileMedia(base, now, [evidence, evidence]), /EVIDENCE_DUPLICATE/);
});
test('gallery reorder keeps target-only image slots and never changes alt/content', () => {
  const base = pair([asset('a'),asset('b'),asset('c')], [asset('a'),asset('z'),asset('b'),asset('c')]), now = clone(base);
  now.gallery.assets.reverse(); const plan = api.reconcileMedia(base, now); assert.deepEqual(plan.patches, []);
  assert.deepEqual(plan.projected.shopify.map(a => a.key), ['c','z','b','a']);
});
test('concurrent different reorders are reported, simultaneous identical reorder acknowledged', () => {
  const base = pair([asset('a'),asset('b'),asset('c')]), now = clone(base);
  now.gallery.assets.reverse(); now.shopify.assets = [asset('b'),asset('a'),asset('c')];
  const plan = api.reconcileMedia(base, now); noMutation(plan); assert.equal(plan.conflicts[0].code, 'MEDIA_CONCURRENT_ORDER');
  now.shopify.assets.reverse(); now.shopify.assets = clone(now.gallery.assets); noMutation(api.reconcileMedia(base, now));
});
test('membership change alone does not reorder stable existing assets', () => {
  const base = pair(), now = clone(base); now.gallery.assets.push(asset('c'));
  const plan = api.reconcileMedia(base, now); assert.deepEqual(plan.orders, [{ target: 'shopify', keys: ['a','b','c'] }]);
});
test('one-sided reorder plus anchored insertion converges in the exact source order', () => {
  for (const side of ['gallery','shopify']) {
    const base = pair([asset('a'),asset('b'),asset('c')]), now = clone(base), target = side === 'gallery' ? 'shopify' : 'gallery';
    now[side].assets = [asset('c'),asset('a'),asset('x'),asset('b')];
    const plan = api.reconcileMedia(base, now);
    assert.deepEqual(plan.projected[target].map(a => a.key), ['c','a','x','b']); assert.deepEqual(plan.conflicts, []);
  }
});
test('removal versus a concurrent promotion retains target image and reports conflict', () => {
  const base = pair([asset('a'),asset('b'),asset('c')]), now = clone(base);
  now.gallery.assets = [asset('a'),asset('c')]; now.shopify.assets = [asset('b'),asset('a'),asset('c')];
  const plan = api.reconcileMedia(base,now,[removal(base,'gallery','b')]);
  assert.equal(plan.conflicts[0].code,'MEDIA_REMOVE_VS_EDIT'); assert.ok(plan.projected.shopify.some(a=>a.key==='b'));
  assert.equal(plan.patches.some(p=>p.kind==='detach_reference'),false);
});
test('a concurrently attached shared image participates in conflicting order detection', () => {
  const base = pair([asset('a'),asset('b'),asset('c')]), now = clone(base);
  now.gallery.assets = [asset('c'),asset('a'),asset('x'),asset('b')];
  now.shopify.assets = [asset('a'),asset('x'),asset('b'),asset('c')];
  const plan = api.reconcileMedia(base,now); noMutation(plan);
  assert.ok(plan.conflicts.some(c=>c.code==='MEDIA_CONCURRENT_ORDER'));
  assert.deepEqual(plan.projected.shopify,now.shopify.assets);
});
test('a held membership conflict cannot reorder a pre-existing target reference', () => {
  const base = pair([asset('a'),asset('b')], [asset('a'),asset('x'),asset('b')]), now = clone(base);
  now.gallery.assets = [asset('x',{contentId:'f'.repeat(64)}),asset('a'),asset('b')];
  const plan = api.reconcileMedia(base,now); noMutation(plan); assert.deepEqual(plan.projected.shopify,now.shopify.assets);
  assert.equal(plan.conflicts[0].code,'MEDIA_EXISTING_TARGET_DIFFERENT');
  now.gallery.assets.reverse(); const reordered = api.reconcileMedia(base,now); noMutation(reordered);
  assert.ok(reordered.conflicts.some(c=>c.code==='MEDIA_ORDER_TOUCHES_HELD_MEMBERSHIP'));
});
test('trusted exact detach receipt acknowledges lost reply without a second user deletion or repeat', () => {
  const base = pair(), now = clone(base); now.gallery.assets.pop(); now.shopify.assets.pop(); now.shopify.revision = 'readback-v2';
  const intent = removal(base,'gallery','b');
  const receipt = {source:'gallery',target:'shopify',key:'b',operationId:'aaaa1111-1111-4111-8111-111111111111',sourceIntentId:intent.requestId,
    sourceBaselineFingerprint:api.mediaSnapshotFingerprint(base.gallery), targetBaselineFingerprint:api.mediaSnapshotFingerprint(base.shopify),targetAbsentReadbackRevision:'readback-v2'};
  const plan = api.reconcileMedia(base,now,[intent],[receipt]); noMutation(plan); assert.deepEqual(plan.conflicts,[]);
  for (const change of [{sourceIntentId:'bbbb1111-1111-4111-8111-111111111111'},{targetAbsentReadbackRevision:'stale'},{targetBaselineFingerprint:'0'.repeat(64)}]) {
    assert.throws(()=>api.reconcileMedia(base,now,[intent],[{...receipt,...change}]),/DETACH_RECEIPT_INVALID/);
  }
});

for (const source of ['gallery', 'shopify']) test(`verified ${source} detach and independent target intent attest one absence without duplicate failure`, () => {
  const target = source === 'gallery' ? 'shopify' : 'gallery';
  const base = pair(), now = clone(base);
  now.gallery.assets.pop(); now.shopify.assets.pop();
  now.gallery.revision = 'gallery-readback'; now.shopify.revision = 'shopify-readback';
  const sourceIntent = removal(base, source, 'b');
  const targetIntent = { ...removal(base, target, 'b'), requestId: 'cccc1111-1111-4111-8111-111111111111' };
  const receipt = { source, target, key: 'b', operationId: 'aaaa1111-1111-4111-8111-111111111111', sourceIntentId: sourceIntent.requestId,
    sourceBaselineFingerprint: api.mediaSnapshotFingerprint(base[source]), targetBaselineFingerprint: api.mediaSnapshotFingerprint(base[target]),
    targetAbsentReadbackRevision: now[target].revision };
  const intents = [sourceIntent, targetIntent];
  const plan = api.reconcileMedia(base, now, intents, [receipt]);
  noMutation(plan); assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(api.reconcileMedia(base, now, intents, [receipt]), plan);
  const reciprocal = { ...receipt, source: target, target: source, operationId: 'bbbb1111-1111-4111-8111-111111111111',
    sourceIntentId: targetIntent.requestId, sourceBaselineFingerprint: api.mediaSnapshotFingerprint(base[target]),
    targetBaselineFingerprint: api.mediaSnapshotFingerprint(base[source]), targetAbsentReadbackRevision: now[source].revision };
  const both = api.reconcileMedia(base, now, intents, [receipt, reciprocal]);
  noMutation(both); assert.deepEqual(both.conflicts, []);
  assert.throws(() => api.reconcileMedia(base, now, intents, [receipt, { ...receipt, operationId: reciprocal.operationId }]), /DETACH_RECEIPT_DUPLICATE/);
  assert.throws(() => api.reconcileMedia(base, now, [targetIntent], [receipt]), /DETACH_RECEIPT_INVALID/);
  for (const change of [{ sourceBaselineFingerprint: '0'.repeat(64) }, { targetBaselineFingerprint: '0'.repeat(64) }, { targetAbsentReadbackRevision: 'stale' }]) {
    assert.throws(() => api.reconcileMedia(base, now, intents, [{ ...receipt, ...change }]), /DETACH_RECEIPT_INVALID/);
  }
  for (const side of [source, target]) {
    const reappeared = clone(now); reappeared[side].assets.push(asset('b'));
    assert.throws(() => api.reconcileMedia(base, reappeared, intents, [receipt]), /DETACH_RECEIPT_INVALID/);
  }
});
test('independent additions in the same gap converge with deterministic order and retain each sequence', () => {
  for (const [g,s] of [[['g'],['s']],[['z','g'],['y','s']]]) {
    const base=pair(), now=clone(base);
    now.gallery.assets=[asset('a'),...g.map(k=>asset(k)),asset('b')];
    now.shopify.assets=[asset('a'),...s.map(k=>asset(k)),asset('b')];
    const plan=api.reconcileMedia(base,now);
    const gallery=plan.projected.gallery.map(a=>a.key), shopify=plan.projected.shopify.map(a=>a.key);
    assert.deepEqual(gallery,shopify); assert.deepEqual(plan.conflicts,[]);
    assert.deepEqual(gallery.filter(k=>g.includes(k)),g); assert.deepEqual(gallery.filter(k=>s.includes(k)),s);
    const readback=pair(plan.projected.gallery,plan.projected.shopify);
    noMutation(api.reconcileMedia(base,readback));
  }
});
test('concurrent insertions in different gaps retain exact source anchors', () => {
  const base=pair([asset('a'),asset('b'),asset('c')]), now=clone(base);
  now.gallery.assets=[asset('a'),asset('x'),asset('b'),asset('c')];
  now.shopify.assets=[asset('a'),asset('b'),asset('y'),asset('c')];
  const plan=api.reconcileMedia(base,now);
  assert.deepEqual(plan.projected.gallery.map(a=>a.key),['a','x','b','y','c']);
  assert.deepEqual(plan.projected.shopify.map(a=>a.key),['a','x','b','y','c']); assert.deepEqual(plan.conflicts,[]);
});
test('a newly shared image anchors distinct concurrent additions on either side of it', () => {
  const base=pair(), now=clone(base);
  now.gallery.assets=[asset('a'),asset('z'),asset('x'),asset('b')];
  now.shopify.assets=[asset('a'),asset('x'),asset('c'),asset('b')];
  const plan=api.reconcileMedia(base,now);
  assert.deepEqual(plan.projected.gallery.map(a=>a.key),['a','z','x','c','b']);
  assert.deepEqual(plan.projected.shopify.map(a=>a.key),['a','z','x','c','b']); assert.deepEqual(plan.conflicts,[]);
});
test('deterministic tie-break never moves a new image across a local legacy reference', () => {
  const base=pair([asset('a'),asset('l'),asset('b')],[asset('a'),asset('b')]), now=clone(base);
  now.gallery.assets=[asset('a'),asset('z'),asset('l'),asset('b')]; now.shopify.assets=[asset('a'),asset('c'),asset('b')];
  const plan=api.reconcileMedia(base,now); const keys=plan.projected.gallery.map(a=>a.key);
  assert.ok(keys.indexOf('z')<keys.indexOf('l'));
  assert.ok(plan.conflicts.some(c=>c.code==='MEDIA_CONCURRENT_INSERTION_ANCHORS'));
});
test('all single-side permutations with insertion/removal converge from equal baseline', () => {
  const permutations = xs => xs.length ? xs.flatMap((x,i) => permutations(xs.filter((_,j)=>j!==i)).map(rest=>[x,...rest])) : [[]];
  for (const side of ['gallery','shopify']) for (const keys of [['a','b','c'],['a','b','c','x'],['a','c'],['b','c','x']]) {
    for (const order of permutations(keys)) {
      const base = pair([asset('a'),asset('b'),asset('c')]), now = clone(base), target = side==='gallery'?'shopify':'gallery';
      now[side].assets = order.map(k=>asset(k));
      const evidence = base[side].assets.filter(a=>!keys.includes(a.key)).map(a=>removal(base,side,a.key));
      const plan = api.reconcileMedia(base,now,evidence);
      assert.deepEqual(plan.conflicts,[],`${side}: ${order}`);
      assert.deepEqual(plan.projected[target].map(a=>a.key),order,`${side}: ${order}`);
    }
  }
});
test('ambiguous insertion against reversed target anchors holds the image', () => {
  const base = pair([asset('a'),asset('b')], [asset('b'),asset('a')]), now = clone(base); now.gallery.assets.splice(1,0,asset('c'));
  const plan = api.reconcileMedia(base, now); noMutation(plan); assert.equal(plan.conflicts[0].code, 'MEDIA_AMBIGUOUS_INSERT_ORDER');
});
// POLICY (2026-10-07, replaces the former blanket HOLD for every one-sided legacy edit): an ALT-only edit of an
// existing INDEPENDENT image is acknowledged locally. No counterpart, no patch, no mapping; reported separately.
const independent = () => pair([asset('a'), asset('x')], [asset('a'), asset('y')]);
const commitPlan = plan => pair(clone(plan.projected.gallery), clone(plan.projected.shopify));
for (const side of ['gallery', 'shopify']) test(`independent ${side} ALT is local: no counterpart, no patch, ordinary commit, idempotent repeat`, () => {
  const base = independent(), now = clone(base), other = side === 'gallery' ? 'shopify' : 'gallery', key = side === 'gallery' ? 'x' : 'y';
  now[side].assets[1].alt = 'תיאור נגיש מדויק של הזווית הקיימת';
  const plan = api.reconcileMedia(base, now); noMutation(plan); assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.projected, { gallery: now.gallery.assets, shopify: now.shopify.assets });
  assert.ok(!plan.projected[other].some(a => a.key === key));
  assert.deepEqual(api.independentLocalAltChanges(base, now), [{ side, key, previousAlt: `תמונה ${key}`, currentAlt: 'תיאור נגיש מדויק של הזווית הקיימת' }]);
  // Readback of exactly the projected pair verifies; a repeated reconciliation on the committed baseline is a no-op.
  api.verifyMediaReadback(plan, now);
  const committed = commitPlan(plan), repeat = api.reconcileMedia(committed, clone(committed));
  noMutation(repeat); assert.deepEqual(repeat.conflicts, []); assert.deepEqual(api.independentLocalAltChanges(committed, clone(committed)), []);
});
test('both sides may each keep their own independent local ALT in one plan', () => {
  const base = independent(), now = clone(base); now.gallery.assets[1].alt = 'g local'; now.shopify.assets[1].alt = 's local';
  const plan = api.reconcileMedia(base, now); noMutation(plan); assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(api.independentLocalAltChanges(base, now).map(x => [x.side, x.key]), [['gallery', 'x'], ['shopify', 'y']]);
});
test('independent ALT comparison is independent of JSONB versus mapper property order', () => {
  const x = asset('x'), base = pair([asset('a'), { alt: x.alt, key: x.key, contentId: x.contentId, evidenceId: x.evidenceId }], [asset('a'), asset('y')]);
  const now = clone(base); now.gallery.assets[1] = { key: x.key, contentId: x.contentId, evidenceId: x.evidenceId, alt: 'changed' };
  const plan = api.reconcileMedia(base, now); noMutation(plan); assert.deepEqual(plan.conflicts, []);
});
for (const side of ['gallery', 'shopify']) for (const changed of ['contentId', 'evidenceId']) test(`independent ${side} ALT with changed ${changed} (content/source/colour) still requires mapping`, () => {
  const base = independent(), now = clone(base); now[side].assets[1].alt = 'changed';
  now[side].assets[1][changed] = changed === 'contentId' ? 'f'.repeat(64) : 'another-source-proof';
  const plan = api.reconcileMedia(base, now); noMutation(plan); assert.equal(plan.conflicts[0].code, 'MEDIA_TARGET_MAPPING_REQUIRED');
  assert.deepEqual(api.independentLocalAltChanges(base, now), []);
});
test('independent local ALT does not block an unrelated approved new image, which alone is patched', () => {
  const base = independent(), now = clone(base); now.gallery.assets[1].alt = 'local'; now.shopify.assets.push(asset('z'));
  const plan = api.reconcileMedia(base, now); assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.patches.length, 1); assert.equal(plan.patches[0].kind, 'attach'); assert.equal(plan.patches[0].key, 'z');
  assert.equal(plan.projected.gallery.find(a => a.key === 'x').alt, 'local'); assert.ok(!plan.projected.shopify.some(a => a.key === 'x'));
});
test('historical removal evidence for the key keeps the mapping hold', () => {
  const base = independent(), now = clone(base); now.gallery.assets[1].alt = 'local';
  const plan = api.reconcileMedia(base, now, [removal(base, 'gallery', 'x')]); assert.equal(plan.conflicts[0].code, 'MEDIA_TARGET_MAPPING_REQUIRED'); noMutation(plan);
});
for (const [name, mutate] of [
  ['same bytes under another key on the other side', (b, n) => { const y = n.shopify.assets[1]; y.contentId = n.gallery.assets[1].contentId; b.shopify.assets[1].contentId = y.contentId; }],
  ['same source proof under another key on the other side', (b, n) => { n.shopify.assets[1].evidenceId = n.gallery.assets[1].evidenceId; b.shopify.assets[1].evidenceId = n.gallery.assets[1].evidenceId; }],
  ['alternate key with the same URL/bytes on the same side (cover alias)', (b, n) => { const dup = asset('w', { contentId: n.gallery.assets[1].contentId }); b.gallery.assets.push(clone(dup)); n.gallery.assets.push(dup); }],
  ['a counterpart under a new key appears now', (b, n) => { n.shopify.assets.push(asset('v', { contentId: n.gallery.assets[1].contentId })); }],
]) test(`possible counterpart keeps the hold: ${name}`, () => {
  const base = independent(), now = clone(base); now.gallery.assets[1].alt = 'local'; mutate(base, now);
  const plan = api.reconcileMedia(base, now); assert.ok(plan.conflicts.some(c => c.key === 'x' && c.code === 'MEDIA_TARGET_MAPPING_REQUIRED'));
  assert.deepEqual(api.independentLocalAltChanges(base, now), []);
});
test('a new counterpart under the SAME key is an existing-target conflict, never a silent local ALT', () => {
  const base = independent(), now = clone(base); now.gallery.assets[1].alt = 'local'; now.shopify.assets.push(asset('x', { alt: 'store text' }));
  const plan = api.reconcileMedia(base, now); assert.ok(plan.conflicts.length > 0); assert.deepEqual(api.independentLocalAltChanges(base, now), []);
});
test('ALT together with a change of position or membership keeps the hold', () => {
  const moved = independent(); moved.gallery.assets.push(asset('b')); moved.shopify.assets.push(asset('b'));
  const now = clone(moved); now.gallery.assets = [now.gallery.assets[1], now.gallery.assets[0], now.gallery.assets[2]]; now.gallery.assets[0].alt = 'local';
  assert.ok(api.reconcileMedia(moved, now).conflicts.some(c => c.key === 'x' && c.code === 'MEDIA_TARGET_MAPPING_REQUIRED'));
  const gone = independent(), later = clone(gone); later.gallery.assets[1].alt = 'local'; later.gallery.assets.splice(0, 1);
  assert.ok(api.reconcileMedia(gone, later).conflicts.some(c => c.code === 'MEDIA_REMOVAL_INTENT_REQUIRED'));
});
// Live case P10SZV24466/651 (8.10): the shared images on the store were reordered to the gallery order,
// while a store-only image kept its index and its order among store-only images and only gained an ALT.
const sharedReorder = () => pair([asset('a'), asset('b')], [asset('s'), asset('a'), asset('y'), asset('b')]);
test('a shared reorder around an independent image that kept its place does not hold its local ALT', () => {
  const base = sharedReorder(), now = clone(base);
  now.shopify.assets = [now.shopify.assets[0], now.shopify.assets[3], now.shopify.assets[2], now.shopify.assets[1]];
  now.shopify.assets[2].alt = 'תיאור נגיש';
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.patches, []);
  assert.deepEqual(plan.orders, [{ target: 'gallery', keys: ['b', 'a'] }]);
  assert.deepEqual(api.independentLocalAltChanges(base, now).map(x => [x.side, x.key]), [['shopify', 'y']]);
});
test('with a shared reorder, an independent image that changed index keeps the hold', () => {
  const base = sharedReorder(), now = clone(base);
  now.shopify.assets = [now.shopify.assets[0], now.shopify.assets[3], now.shopify.assets[1], now.shopify.assets[2]];
  now.shopify.assets[3].alt = 'תיאור נגיש';
  assert.ok(api.reconcileMedia(base, now).conflicts.some(c => c.key === 'y' && c.code === 'MEDIA_TARGET_MAPPING_REQUIRED'));
});
test('the same exception holds on the gallery side (mirror)', () => {
  const base = pair([asset('s'), asset('a'), asset('y'), asset('b')], [asset('a'), asset('b')]), now = clone(base);
  now.gallery.assets = [now.gallery.assets[0], now.gallery.assets[3], now.gallery.assets[2], now.gallery.assets[1]];
  now.gallery.assets[2].alt = 'תיאור נגיש';
  const plan = api.reconcileMedia(base, now); assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.orders, [{ target: 'shopify', keys: ['b', 'a'] }]);
});
test('a newly shared copy moving around the image (live shape) is acknowledged', () => {
  // Store-only n is copied to the gallery and the store order follows the gallery: n moves past y.
  const base = pair([asset('a'), asset('b')], [asset('s'), asset('n'), asset('y'), asset('a'), asset('b')]), now = clone(base);
  now.gallery.assets.push(clone(base.shopify.assets[1]));
  const [s, n, y, a, b] = now.shopify.assets; now.shopify.assets = [s, a, y, b, n]; y.alt = 'תיאור נגיש';
  const plan = api.reconcileMedia(base, now); assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.patches, []); assert.deepEqual(plan.orders, []);
  assert.deepEqual(api.independentLocalAltChanges(base, now).map(x => [x.side, x.key]), [['shopify', 'y']]);
});
test('an addition or removal on the same side cannot mask a move of the image', () => {
  const removed = pair([asset('a'), asset('b'), asset('h')], [asset('r'), asset('a'), asset('y'), asset('b')]), r1 = clone(removed);
  r1.shopify.assets = [asset('a'), asset('b'), { ...asset('y'), alt: 'תיאור נגיש' }, asset('h')];
  assert.ok(api.reconcileMedia(removed, r1, [removal(removed, 'shopify', 'r')]).conflicts.some(c => c.key === 'y' && c.code === 'MEDIA_TARGET_MAPPING_REQUIRED'));
  const added = pair([asset('a'), asset('b'), asset('h')], [asset('a'), asset('y'), asset('b')]), r2 = clone(added);
  r2.shopify.assets = [asset('h'), { ...asset('y'), alt: 'תיאור נגיש' }, asset('a'), asset('b')];
  assert.ok(api.reconcileMedia(added, r2).conflicts.some(c => c.key === 'y' && c.code === 'MEDIA_TARGET_MAPPING_REQUIRED'));
});
test('with a shared reorder, an independent image reordered among independent images keeps the hold', () => {
  const base = pair([asset('a'), asset('b')], [asset('s'), asset('a'), asset('y'), asset('b'), asset('t')]), now = clone(base);
  const [s, a, y, b, t] = now.shopify.assets; now.shopify.assets = [t, b, y, a, s]; y.alt = 'תיאור נגיש';
  assert.ok(api.reconcileMedia(base, now).conflicts.some(c => c.key === 'y' && c.code === 'MEDIA_TARGET_MAPPING_REQUIRED'));
});
test('a genuine unrelated conflict is never hidden by a local ALT acknowledgement', () => {
  const base = independent(), now = clone(base); now.gallery.assets[1].alt = 'local';
  now.gallery.assets[0].alt = 'gallery edit'; now.shopify.assets[0].alt = 'store edit';
  const plan = api.reconcileMedia(base, now); assert.deepEqual(plan.conflicts.map(c => [c.key, c.code]), [['a', 'MEDIA_CONCURRENT_FIELD']]);
  assert.deepEqual(api.independentLocalAltChanges(base, now), []);
});
test('stale observation and interrupted/altered commit readback still fail closed', () => {
  const base = independent(), now = clone(base); now.gallery.assets[1].alt = 'local'; const plan = api.reconcileMedia(base, now);
  const stale = clone(now); stale.gallery.revision = 'gallery-v2'; stale.gallery.assets[1].alt = 'edited again';
  assert.throws(() => api.assertMediaPreconditions(plan, stale), /MEDIA_SOURCE_OR_TARGET_CHANGED/);
  const reverted = clone(now); reverted.gallery.assets[1].alt = base.gallery.assets[1].alt;
  assert.throws(() => api.verifyMediaReadback(plan, reverted), /MEDIA_READBACK_MISMATCH/);
  api.assertMediaPreconditions(plan, clone(now));
});
test('shared images keep ordinary ALT propagation; identity/colour drift and invalid ALT still fail', () => {
  const base = independent(), now = clone(base); now.gallery.assets[0].alt = 'shared edit';
  assert.deepEqual(api.reconcileMedia(base, now).patches, [{ source: 'gallery', target: 'shopify', key: 'a', kind: 'alt', value: 'shared edit' }]);
  const drift = clone(base); drift.gallery.assets[1].alt = 'local'; drift.gallery.identity.variantId = 'gid://shopify/ProductVariant/1';
  assert.throws(() => api.reconcileMedia(base, drift), /MEDIA_IDENTITY_DRIFT/);
  const bad = clone(base); bad.gallery.assets[1].alt = 'bad\u0001alt'; assert.throws(() => api.reconcileMedia(base, bad), /MEDIA_ASSET_INVALID/);
});
test('raw SKU, variant, item and handle drift cannot select a different product', () => {
  for (const field of ['variantId','itemId','exactGallerySku','exactShopifySku','productHandle']) {
    const base = pair(), now = clone(base);
    now.shopify.identity[field] = field === 'variantId' ? 'gid://shopify/ProductVariant/9' : field === 'itemId' ? 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' : 'changed';
    assert.throws(() => api.reconcileMedia(base, now), /IDENTITY_DRIFT/);
  }
});
test('unvalidated data, duplicate keys, missing revisions and excessive collections rejected', () => {
  for (const alter of [s => s.assets.push(clone(s.assets[0])), s => s.assets[0].contentId = 'url-not-digest',
    s => s.assets[0].evidenceId = '', s => s.revision = '', s => s.assets = Array.from({length:251},(_,i)=>asset(`key-${i}`))]) {
    const base = pair(), now = clone(base); alter(now.gallery); assert.throws(() => api.reconcileMedia(base, now), /MEDIA_/);
  }
});
test('immediate pre-write check detects any source or target change including unrelated image', () => {
  const base = pair(), now = clone(base); now.gallery.assets[0].alt = 'new'; const plan = api.reconcileMedia(base, now);
  api.assertMediaPreconditions(plan, clone(now));
  const drift = clone(now); drift.shopify.assets[1].alt = 'external';
  assert.throws(() => api.assertMediaPreconditions(plan, drift), /SOURCE_OR_TARGET_CHANGED/);
});
test('readback checks full result, preserving untouched data and order; evidence receipt may refresh', () => {
  const base = pair(), now = clone(base); now.gallery.assets[0].alt = 'new'; const plan = api.reconcileMedia(base, now);
  const observed = pair(clone(plan.projected.gallery), clone(plan.projected.shopify)); observed.shopify.revision = 'fresh';
  observed.shopify.assets[0].evidenceId = 'new-import-receipt'; api.verifyMediaReadback(plan, observed);
  observed.shopify.assets[1].contentId = 'e'.repeat(64); assert.throws(() => api.verifyMediaReadback(plan, observed), /READBACK_MISMATCH/);
});
test('reconcile is deterministic and does not mutate baseline/current/evidence', () => {
  const base = pair(), now = clone(base); now.gallery.assets[0].alt = 'new'; const before = JSON.stringify([base,now]);
  const one = api.reconcileMedia(base, now); assert.deepEqual(api.reconcileMedia(base,now), one); assert.equal(JSON.stringify([base,now]), before);
});

// Adopted copy of a target-baseline image (BXL58145 class): the gallery gained byte-identical copies
// of Shopify images carrying Shopify's PREVIOUS alt, while Shopify corrected the alt.
const adoption = (mutate = () => {}) => {
  const base = pair([asset('a')], [asset('a'), asset('b', { alt: 'מזוודה 70 ס"מ', evidenceId: 's-b' })]), now = clone(base);
  now.gallery.assets.push(asset('b', { alt: 'מזוודה 70 ס"מ', evidenceId: 'g-b' }));
  now.shopify.assets[1].alt = 'מזוודה 77 ס"מ';
  mutate(base, now); return { base, now, plan: api.reconcileMedia(base, now) };
};
test('copy proven equal to the target baseline receives only the target ALT edit', () => {
  const { base, now, plan } = adoption();
  assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.orders, []);
  assert.deepEqual(plan.patches, [{ source: 'shopify', target: 'gallery', key: 'b', kind: 'alt', value: 'מזוודה 77 ס"מ' }]);
  assert.deepEqual(plan.projected.gallery.find(a => a.key === 'b'), { ...now.gallery.assets[1], alt: 'מזוודה 77 ס"מ' });
  assert.deepEqual(plan.projected.shopify, now.shopify.assets);
  // After the verified commit the projected pair is the baseline: nothing further happens.
  const committed = { gallery: { ...now.gallery, assets: plan.projected.gallery }, shopify: now.shopify };
  const again = api.reconcileMedia(committed, clone(committed)); noMutation(again); assert.deepEqual(again.conflicts, []);
  assert.equal(base.gallery.assets.some(a => a.key === 'b'), false);
});
test('held: the mirror direction (Shopify gains a copy of a gallery baseline image) stays a conflict', () => {
  const base = pair([asset('a'), asset('b', { alt: 'old', evidenceId: 'g-b' })], [asset('a')]), now = clone(base);
  now.shopify.assets.push(asset('b', { alt: 'old', evidenceId: 's-b' })); now.gallery.assets[1].alt = 'new';
  const plan = api.reconcileMedia(base, now); noMutation(plan);
  assert.deepEqual(plan.conflicts.map(c => c.code), ['MEDIA_EXISTING_TARGET_DIFFERENT']);
});
for (const [name, mutate] of [
  ['copy ALT differs from the target baseline (concurrent edit on the copy)', (b, n) => { n.gallery.assets[1].alt = 'עריכה מקבילה'; }],
  ['copy bytes differ from the target', (b, n) => { n.gallery.assets[1].contentId = 'e'.repeat(64); }],
  ['target bytes changed since baseline', (b, n) => { n.shopify.assets[1].contentId = n.gallery.assets[1].contentId = 'd'.repeat(64); }],
  ['target source evidence changed since baseline', (b, n) => { n.shopify.assets[1].evidenceId = 's-b-new'; }],
  ['same bytes under another key (uncertain identity)', (b, n) => { n.shopify.assets.push(asset('c', { contentId: n.gallery.assets[1].contentId })); }],
  ['same source proof under another key', (b, n) => { b.gallery.assets.push(asset('z', { evidenceId: 'g-b' })); n.gallery.assets.splice(1, 0, asset('z', { evidenceId: 'g-b' })); }],
  ['target image repositioned', (b, n) => { n.shopify.assets.reverse(); }],
  ['extra field on the copy', (b, n) => { n.gallery.assets[1].note = 'x'; }],
  ['target source proof also appears under another key', (b, n) => { n.gallery.assets.push(asset('y', { evidenceId: 's-b' })); }],
]) test(`held: ${name}`, () => {
  const { plan } = adoption(mutate);
  assert.equal(plan.patches.some(p => p.key === 'b' && p.target === 'gallery'), false);
  assert.ok(plan.conflicts.some(c => c.key === 'b' && c.code === 'MEDIA_EXISTING_TARGET_DIFFERENT'), JSON.stringify(plan.conflicts));
});
test('held: target ALT unchanged but copy ALT differs stays the original pre-existing-target conflict', () => {
  const base = pair([asset('a')], [asset('a'), asset('b', { alt: 'target' })]), now = clone(base);
  now.gallery.assets.push(asset('b')); const plan = api.reconcileMedia(base, now); noMutation(plan);
  assert.equal(plan.conflicts[0].code, 'MEDIA_EXISTING_TARGET_DIFFERENT');
});
// 2026-10-07: a same-side duplicate (identical bytes) that was deleted with explicit removal evidence is history.
// After the deletion the surviving image's ALT-only edit is local again; any other twin still keeps the hold.
const withRemovedDuplicate = () => {
  const base = independent(); base.gallery.assets.push(asset('w', { contentId: base.gallery.assets[1].contentId }));
  const now = clone(base); now.gallery.assets.pop(); now.gallery.assets[1].alt = 'local after duplicate removal';
  return { base, now };
};
test('removed same-side duplicate with removal evidence no longer blocks the survivor local ALT', () => {
  const { base, now } = withRemovedDuplicate();
  const plan = api.reconcileMedia(base, now, [removal(base, 'gallery', 'w')]);
  noMutation(plan); assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(api.independentLocalAltChanges(base, now, [removal(base, 'gallery', 'w')]).map(x => [x.side, x.key]), [['gallery', 'x']]);
});
test('removed duplicate WITHOUT removal evidence still holds (removal intent + mapping)', () => {
  const { base, now } = withRemovedDuplicate();
  const codes = api.reconcileMedia(base, now).conflicts.map(c => c.code);
  assert.ok(codes.includes('MEDIA_REMOVAL_INTENT_REQUIRED')); assert.ok(codes.includes('MEDIA_TARGET_MAPPING_REQUIRED'));
});
for (const [name, mutate] of [
  ['the twin still exists on the same side now', (b, n) => { n.gallery.assets.push(clone(b.gallery.assets[2])); }],
  ['the twin was also in the other side baseline', (b, n) => { b.shopify.assets.push(clone(b.gallery.assets[2])); n.shopify.assets.push(clone(b.gallery.assets[2])); }],
  ['a twin under another key appears on the other side now', (b, n) => { n.shopify.assets.push(asset('v', { contentId: n.gallery.assets[1].contentId })); }],
  ['a second twin without removal remains in the baseline of the other side', (b, n) => { b.shopify.assets.push(asset('u', { contentId: n.gallery.assets[1].contentId })); n.shopify.assets.push(asset('u', { contentId: n.gallery.assets[1].contentId })); }],
]) test(`removed-duplicate exception is narrow: ${name}`, () => {
  const { base, now } = withRemovedDuplicate(); mutate(base, now);
  const plan = api.reconcileMedia(base, now, [removal(base, 'gallery', 'w')]);
  assert.ok(plan.conflicts.some(c => c.key === 'x' && c.code === 'MEDIA_TARGET_MAPPING_REQUIRED'), JSON.stringify(plan.conflicts));
});
test('removed-duplicate exception mirrors on the Shopify side with signed removal evidence', () => {
  const base = independent(); base.shopify.assets.push(asset('w', { contentId: base.shopify.assets[1].contentId }));
  const now = clone(base); now.shopify.assets.pop(); now.shopify.assets[1].alt = 'store local after duplicate removal';
  const plan = api.reconcileMedia(base, now, [removal(base, 'shopify', 'w')]); noMutation(plan); assert.deepEqual(plan.conflicts, []);
});

// A target that already shows the same bytes (or lineage) under another key never receives a second copy.
const cid = c => c.repeat(64);
const conflictCodes = plan => plan.conflicts.map(c => [c.key, c.code]);
for (const source of ['gallery', 'shopify']) test(`new ${source} key whose bytes the target already shows under another key is held, not attached`, () => {
  const target = source === 'gallery' ? 'shopify' : 'gallery';
  const base = pair([asset('a'), asset('b')]); base[target].assets.push(asset('t-only', { contentId: cid('c') }));
  const now = clone(base); now[source].assets.push(asset('n-new', { contentId: cid('c') }));
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(conflictCodes(plan), [['n-new', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']]);
  assert.equal(plan.patches.some(p => p.kind === 'attach'), false);
});
test('a genuinely new image (bytes the target does not show) still attaches', () => {
  const base = pair([asset('a'), asset('b')]); base.shopify.assets.push(asset('t-only', { contentId: cid('c') }));
  const now = clone(base); now.gallery.assets.push(asset('n-new', { contentId: cid('d') }));
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.patches.map(p => [p.kind, p.target, p.key]), [['attach', 'shopify', 'n-new']]);
});
test('two new keys with the same bytes on one side: the product is held (the second key is the one reported)', () => {
  const base = pair([asset('a'), asset('b')]);
  const now = clone(base); now.gallery.assets.push(asset('n1', { contentId: cid('e') }), asset('n2', { contentId: cid('e') }));
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(conflictCodes(plan), [['n2', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']]);
});
test('live P10OXT0529O shape: replaced Gallery rows pointing at existing store files are held on every attach', () => {
  // Baseline: photos 1..5 shared, photo 7 shared under the old Gallery row key.
  const shared = ['p1', 'p2', 'p3', 'p4', 'p5'].map((k, i) => asset(k, { contentId: cid(String(i + 1)) }));
  const old7 = asset('g-angle:old7', { contentId: cid('7') }), s6 = asset('s-media:6', { contentId: cid('6') });
  const base = pair([...clone(shared), clone(old7)], [...clone(shared), clone(old7)]);
  // Now: the store shows a new photo 6, and the Gallery replaced its rows with new rows (new keys) that point
  // at the same store files. Without the hold: detach 7, attach 6 and 7 to the store, attach 6 to the Gallery.
  const now = clone(base);
  now.gallery.assets = [...clone(shared), asset('g-angle:new6', { contentId: cid('6') }), asset('g-angle:new7', { contentId: cid('7') })];
  now.shopify.assets = [...clone(shared), clone(s6), clone(old7)];
  const plan = api.reconcileMedia(base, now, [removal(base, 'gallery', 'g-angle:old7')]);
  assert.deepEqual(conflictCodes(plan).sort(), [
    ['g-angle:new6', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT'],
    ['g-angle:new7', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT'],
    ['s-media:6', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']]);
  // Any conflict holds the whole product before reservation, so the planned detach of the old row is never run.
  assert.equal(plan.patches.some(p => p.kind === 'attach'), false);
});
// Stricter than "no second copy" by design: removing a key and re-adding the same image under another key in one
// plan leaves the target without the image between steps (live P10OXT0529O lost photo 7 for hours that way).
const two = () => pair([asset('a', { contentId: cid('1') }), asset('b', { contentId: cid('2') })]);
test('held by design: a Gallery row replaced by a new row with the same bytes (old row removed with evidence)', () => {
  const base = two(), now = clone(base); now.gallery.assets[1] = asset('n', { contentId: cid('2') });
  const plan = api.reconcileMedia(base, now, [removal(base, 'gallery', 'b')]);
  assert.deepEqual(conflictCodes(plan), [['n', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']]);
});
test('held by design: a store delete and re-upload of the same file (signed removal evidence)', () => {
  const base = two(), now = clone(base); now.shopify.assets[1] = asset('s-media:y', { contentId: cid('2') });
  const plan = api.reconcileMedia(base, now, [removal(base, 'shopify', 'b')]);
  assert.deepEqual(conflictCodes(plan), [['s-media:y', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']]);
});
test('held by design: a swap (one row gets new bytes, a new row carries its old bytes)', () => {
  const base = two(), now = clone(base);
  now.gallery.assets[0] = asset('a', { contentId: cid('3'), evidenceId: 'receipt-a-new' }); now.gallery.assets.push(asset('n', { contentId: cid('1') }));
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(conflictCodes(plan), [['n', 'MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']]);
});
for (const source of ['gallery', 'shopify']) test(`${source} content change to bytes the target already shows under another key is held, not replaced`, () => {
  // e.g. a cover that keeps its key while its URL moves to a file the target already shows.
  const base = two(), now = clone(base); now[source].assets[0] = asset('a', { contentId: cid('2'), evidenceId: 'moved-to-b-file' });
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(plan.conflicts, [{ key: 'a', field: 'content', code: 'MEDIA_REPLACE_TARGET_HAS_SAME_CONTENT' }]);
  assert.equal(plan.patches.some(p => p.kind === 'replace_reference'), false);
});
test('content change to bytes the target does not show still replaces the reference', () => {
  const base = two(), now = clone(base); now.gallery.assets[0] = asset('a', { contentId: cid('4'), evidenceId: 'new-file' });
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.patches.map(p => [p.kind, p.target, p.key]), [['replace_reference', 'shopify', 'a']]);
});
test('replace held: a cover keeps its key while its URL moves to an image only the store shows', () => {
  const base = pair([asset('a', { contentId: cid('1') })], [asset('a', { contentId: cid('1') }), asset('s-only', { contentId: cid('2') })]);
  const now = clone(base); now.gallery.assets[0] = asset('a', { contentId: cid('2'), evidenceId: 'cover-moved' });
  assert.deepEqual(conflictCodes(api.reconcileMedia(base, now)), [['a', 'MEDIA_REPLACE_TARGET_HAS_SAME_CONTENT']]);
});
test('replace held by design: the other copy is being removed in the same plan', () => {
  const base = two(), now = clone(base);
  now.gallery.assets = [asset('a', { contentId: cid('2'), evidenceId: 'moved-to-b-file' })];
  const plan = api.reconcileMedia(base, now, [removal(base, 'gallery', 'b')]);
  assert.deepEqual(conflictCodes(plan), [['a', 'MEDIA_REPLACE_TARGET_HAS_SAME_CONTENT']]);
});
test('replace held: a content swap between two shared rows', () => {
  const base = two(), now = clone(base);
  now.gallery.assets = [asset('a', { contentId: cid('2'), evidenceId: 'swap-a' }), asset('b', { contentId: cid('1'), evidenceId: 'swap-b' })];
  assert.deepEqual(conflictCodes(api.reconcileMedia(base, now)).sort(), [['a', 'MEDIA_REPLACE_TARGET_HAS_SAME_CONTENT'], ['b', 'MEDIA_REPLACE_TARGET_HAS_SAME_CONTENT']]);
});

// Same photo in another encoding: different bytes (so a different contentId), near-identical pixels.
// A fingerprint is three 32x32 RGB framings (9216 bytes of hex); the smallest framing distance decides.
const vis = (seed, shift = 0) => { let x = seed >>> 0, out = ''; for (let i = 0; i < 9216; i++) { x = (x * 1103515245 + 12345) >>> 0; const v = Math.min(255, Math.max(0, ((x >>> 16) & 255) + shift)); out += v.toString(16).padStart(2, '0'); } return out; };
const visualsOf = (now, table) => ({ gallery: Object.fromEntries(now.gallery.assets.map(a => [a.key, table[a.key]])), shopify: Object.fromEntries(now.shopify.assets.map(a => [a.key, table[a.key]])) });
const flatVis = d => d.toString(16).padStart(2, '0').repeat(9216);
// A ramp pattern (so the tone fit has real variance) with one 8x8 block moved by delta IN EVERY framing.
const blockVis = (delta = 0) => { const bytes = new Uint8Array(9216); for (let i = 0; i < 9216; i++) bytes[i] = (i * 37) % 229; for (let f = 0; f < 3; f++) for (let row = 8; row < 16; row++) for (let col = 8; col < 16; col++) for (let ch = 0; ch < 3; ch++) { const at = f * 3072 + (row * 32 + col) * 3 + ch; bytes[at] = Math.min(255, bytes[at] + delta); } return [...bytes].map(v => v.toString(16).padStart(2, '0')).join(''); };
test('visual distance is the worst tone-matched block over the best framing; malformed fingerprints throw', () => {
  assert.equal(api.mediaVisualDistance(vis(1), vis(1)), 0);
  // Global tone shifts (brightness, re-encode gamma) cancel; a local block difference survives.
  assert.ok(api.mediaVisualDistance(vis(1), vis(1, 3)) < 0.5, 'a uniform +3 shift is tone-matched away');
  assert.ok(api.mediaVisualDistance(flatVis(100), flatVis(130)) === 0, 'two flat tones are the same picture');
  assert.ok(api.mediaVisualDistance(vis(1), vis(2)) > api.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, 'unrelated noise stays far');
  const local = api.mediaVisualDistance(blockVis(0), blockVis(12));
  assert.ok(local > api.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, 'a moved 8x8 block alone crosses the limit: ' + local);
  assert.ok(api.mediaVisualDistance(blockVis(0), blockVis(2)) <= api.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, 'a 2-level block wobble stays a duplicate');
  assert.ok(api.mediaVisualDistance(vis(1), vis(2), api.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE) > api.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, 'an early exit never understates past the limit');
  assert.throws(() => api.mediaVisualDistance('00', '00'), /VISUAL_IDENTITY_INVALID/);
  assert.throws(() => api.mediaVisualDistance('zz'.repeat(9216), flatVis(0)), /VISUAL_IDENTITY_INVALID/);
});
test('one matching framing is enough to hold: a crop-unstable duplicate differs in two framings only', () => {
  const a = blockVis(0), bytes = new Uint8Array(9216);
  const src = blockVis(0); for (let i = 0; i < 9216; i++) bytes[i] = parseInt(src.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < 3072; i++) { bytes[i] = (bytes[i] + 97) % 256; bytes[3072 + i] = (bytes[3072 + i] * 7 + 13) % 256; }   // framings 0+1 scrambled, framing 2 intact
  const b = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
  assert.ok(api.mediaVisualDistance(a, b) <= api.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE);
});
for (const source of ['gallery', 'shopify']) test(`${source} image that the target shows in another encoding under another key is held, not attached`, () => {
  const target = source === 'gallery' ? 'shopify' : 'gallery';
  const base = two(); base[target].assets.push(asset('t-only', { contentId: cid('5') }));
  const now = clone(base); now[source].assets.push(asset('n-new', { contentId: cid('6') }));
  const v = visualsOf(now, { a: vis(1), b: vis(2), 't-only': vis(3), 'n-new': vis(3, 1) });
  const plan = api.reconcileMedia(base, now, [], [], v);
  assert.deepEqual(conflictCodes(plan), [['n-new', 'MEDIA_ATTACH_TARGET_HAS_VISUAL_DUPLICATE']]);
  assert.equal(plan.patches.some(p => p.kind === 'attach'), false);
});
test('a visually different new image still attaches after its shared anchor', () => {
  const base = two(); const now = clone(base); now.gallery.assets.push(asset('n-new', { contentId: cid('6') }));
  const plan = api.reconcileMedia(base, now, [], [], visualsOf(now, { a: vis(1), b: vis(2), 'n-new': vis(9) }));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.patches.map(p => [p.kind, p.target, p.key]), [['attach', 'shopify', 'n-new']]);
  assert.deepEqual(plan.projected.shopify.map(a => a.key), ['a', 'b', 'n-new']);
});
test('threshold boundary: a 2-level block wobble is held, a moved block attaches', () => {
  const base = two(); base.shopify.assets.push(asset('t-only', { contentId: cid('5') }));
  const now = clone(base); now.gallery.assets.push(asset('n-new', { contentId: cid('6') }));
  const run = mine => api.reconcileMedia(base, now, [], [], visualsOf(now, { a: vis(1), b: vis(2), 't-only': blockVis(0), 'n-new': mine }));
  assert.deepEqual(conflictCodes(run(blockVis(2))), [['n-new', 'MEDIA_ATTACH_TARGET_HAS_VISUAL_DUPLICATE']]);
  assert.deepEqual(run(blockVis(12)).conflicts, []);
});
test('a missing fingerprint for the new image or for any target image holds the write', () => {
  const base = two(); const now = clone(base); now.gallery.assets.push(asset('n-new', { contentId: cid('6') }));
  assert.deepEqual(conflictCodes(api.reconcileMedia(base, now, [], [], visualsOf(now, { a: vis(1), b: vis(2) }))), [['n-new', 'MEDIA_VISUAL_IDENTITY_MISSING']]);
  const withTargetOnly = clone(base); withTargetOnly.shopify.assets.push(asset('t-only', { contentId: cid('5') }));
  const now2 = clone(withTargetOnly); now2.gallery.assets.push(asset('n-new', { contentId: cid('6') }));
  assert.deepEqual(conflictCodes(api.reconcileMedia(withTargetOnly, now2, [], [], visualsOf(now2, { a: vis(1), b: vis(2), 'n-new': vis(9) }))), [['n-new', 'MEDIA_VISUAL_IDENTITY_MISSING']]);
});
test('images the source itself shows under separate keys are distinct photos (front and back of a plain product)', () => {
  // Live: wallet front and back measure 0.88, pouch front and back 1.41, below the re-encode maximum 1.31-3.
  const base = two(); const now = clone(base); now.gallery.assets.push(asset('back', { contentId: cid('6') }));
  const plan = api.reconcileMedia(base, now, [], [], visualsOf(now, { a: vis(1), b: vis(2), back: vis(1, 1) }));   // back ~ shared front 'a'
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.patches.map(p => [p.kind, p.target, p.key]), [['attach', 'shopify', 'back']]);
  const pairNew = clone(base); pairNew.gallery.assets.push(asset('n1', { contentId: cid('6') }), asset('n2', { contentId: cid('7') }));
  assert.deepEqual(api.reconcileMedia(base, pairNew, [], [], visualsOf(pairNew, { a: vis(1), b: vis(2), n1: vis(5), n2: vis(5, 1) })).conflicts, []);
});
test('a target-only image that matches visually is still held even when other target images match nothing', () => {
  const base = two(); base.shopify.assets.push(asset('t-only', { contentId: cid('5') }));
  const now = clone(base); now.gallery.assets.push(asset('n-new', { contentId: cid('6') }));
  const plan = api.reconcileMedia(base, now, [], [], visualsOf(now, { a: vis(1), b: vis(2), 't-only': vis(4), 'n-new': vis(4, 2) }));
  assert.deepEqual(conflictCodes(plan), [['n-new', 'MEDIA_ATTACH_TARGET_HAS_VISUAL_DUPLICATE']]);
});
test('content change to a photo the target shows in another encoding under another key is held', () => {
  const base = two(); base.shopify.assets.push(asset('t-only', { contentId: cid('5') }));
  const now = clone(base); now.gallery.assets[0] = asset('a', { contentId: cid('6'), evidenceId: 'new-file' });
  const plan = api.reconcileMedia(base, now, [], [], visualsOf(now, { a: vis(3, 2), b: vis(2), 't-only': vis(3) }));
  assert.deepEqual(plan.conflicts, [{ key: 'a', field: 'content', code: 'MEDIA_REPLACE_TARGET_HAS_VISUAL_DUPLICATE' }]);
});
test('a separately uploaded Gallery cover that re-encodes an angle is held: the Gallery never shows the cover beside its angles', () => {
  const base = pair([asset('g-cover:item', { contentId: cid('1') }), asset('g-angle:1', { contentId: cid('2') }), asset('g-angle:2', { contentId: cid('3') })]);
  const now = clone(base); now.gallery.assets[0] = asset('g-cover:item', { contentId: cid('6'), evidenceId: 'new-cover-upload' });
  const sides = { gallery: { 'g-cover:item': vis(2, 1), 'g-angle:1': vis(2), 'g-angle:2': vis(3) }, shopify: { 'g-cover:item': vis(1), 'g-angle:1': vis(2), 'g-angle:2': vis(3) } };
  assert.deepEqual(api.reconcileMedia(base, now, [], [], { ...sides, galleryCover: 'g-cover:item' }).conflicts,
    [{ key: 'g-cover:item', field: 'content', code: 'MEDIA_REPLACE_TARGET_HAS_VISUAL_DUPLICATE' }]);
  // The same change on an angle row keeps the exemption: the Gallery shows both rows, so they are distinct photos.
  assert.deepEqual(api.reconcileMedia(base, now, [], [], sides).patches.map(p => [p.kind, p.key]), [['replace_reference', 'g-cover:item']]);
});
test('a new angle that re-encodes the separate Gallery cover is held', () => {
  const base = pair([asset('g-cover:item', { contentId: cid('1') }), asset('g-angle:1', { contentId: cid('2') })]);
  const now = clone(base); now.gallery.assets.push(asset('g-angle:2', { contentId: cid('6') }));
  const v = { gallery: { 'g-cover:item': vis(1), 'g-angle:1': vis(2), 'g-angle:2': vis(1, 1) }, shopify: { 'g-cover:item': vis(1), 'g-angle:1': vis(2) }, galleryCover: 'g-cover:item' };
  assert.deepEqual(conflictCodes(api.reconcileMedia(base, now, [], [], v)), [['g-angle:2', 'MEDIA_ATTACH_TARGET_HAS_VISUAL_DUPLICATE']]);
});
test('concurrent cross replaces that would show one photo twice on both sides are held', () => {
  const base = two(); const now = clone(base);
  now.gallery.assets[0] = asset('a', { contentId: cid('6'), evidenceId: 'editor-upload' });     // the editor puts P into row a
  now.shopify.assets[1] = asset('b', { contentId: cid('7'), evidenceId: 'merchant-upload' });   // the merchant puts P' into slot b
  const plan = api.reconcileMedia(base, now, [], [], { gallery: { a: vis(5), b: vis(2) }, shopify: { a: vis(1), b: vis(5, 1) } });
  assert.deepEqual(plan.patches, []);
  assert.deepEqual(conflictCodes(plan).sort(), [['a', 'MEDIA_REPLACE_TARGET_HAS_VISUAL_DUPLICATE'], ['b', 'MEDIA_REPLACE_TARGET_HAS_VISUAL_DUPLICATE']]);
});
test('without fingerprints (pure callers) the planner behaves as before', () => {
  const base = two(); const now = clone(base); now.gallery.assets.push(asset('n-new', { contentId: cid('6') }));
  assert.deepEqual(api.reconcileMedia(base, now).patches.map(p => p.kind), ['attach']);
});
test('no shared anchor in a non-empty target: the insert order is ambiguous and held (it used to go first)', () => {
  const base = pair([asset('g1', { contentId: cid('1') })], [asset('s1', { contentId: cid('2') })]);
  const now = clone(base); now.gallery.assets.push(asset('g2', { contentId: cid('3') }));
  assert.deepEqual(conflictCodes(api.reconcileMedia(base, now)), [['g2', 'MEDIA_AMBIGUOUS_INSERT_ORDER']]);
});
test('an empty target still receives new images in source order', () => {
  const base = pair([asset('g1', { contentId: cid('1') })], []);
  const now = clone(base); now.gallery.assets.push(asset('g2', { contentId: cid('3') }));
  const plan = api.reconcileMedia(base, now);
  assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.patches.map(p => p.key), ['g2']);
});
test('live BAH08451.001 shape: no shared keys, gallery adds photo 6 (another encoding of store 6) and photos 7-10', () => {
  const g = ['G1', 'G2', 'G3', 'G4', 'G5'].map((k, i) => asset(k, { contentId: cid(String(i + 1)) }));
  const s = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((k, i) => asset(k, { contentId: cid(String.fromCharCode(97 + i)) }));
  const base = pair(clone(g), clone(s)), now = clone(base);
  now.gallery.assets.push(...['G6', 'G7', 'G8', 'G9', 'G10'].map((k, i) => asset(k, { contentId: cid(String(i + 6 > 9 ? 0 : i + 6)) })));
  const table = { G1: vis(1), G2: vis(2), G3: vis(3), G4: vis(4), G5: vis(5), S1: vis(1, 1), S2: vis(2, 1), S3: vis(3, 1), S4: vis(4, 1), S5: vis(5, 2), S6: vis(6, 1),
    G6: vis(6), G7: vis(7), G8: vis(8), G9: vis(9), G10: vis(10) };
  const plan = api.reconcileMedia(base, now, [], [], visualsOf(now, table));
  const codes = Object.fromEntries(conflictCodes(plan));
  assert.equal(codes.G6, 'MEDIA_ATTACH_TARGET_HAS_VISUAL_DUPLICATE');
  for (const k of ['G7', 'G8', 'G9', 'G10']) assert.equal(codes[k], 'MEDIA_AMBIGUOUS_INSERT_ORDER');
  assert.equal(plan.patches.some(p => p.kind === 'attach'), false);
});
test('planning stays fast at large image counts (fingerprints decoded once, early exit)', () => {
  const shared = Array.from({ length: 30 }, (_, i) => asset('sh' + i));
  shared.forEach((a, i) => { a.contentId = (i.toString(16).padStart(2, '0')).repeat(32); });
  const targetOnly = Array.from({ length: 120 }, (_, i) => asset('to' + i, { contentId: ('a' + i.toString(16).padStart(3, '0')).repeat(16) }));
  const base = pair(clone(shared), [...clone(shared), ...clone(targetOnly)]), now = clone(base);
  const fresh = Array.from({ length: 90 }, (_, i) => asset('nw' + i, { contentId: ('b' + i.toString(16).padStart(3, '0')).repeat(16) }));
  now.gallery.assets.push(...fresh);
  const table = {}; [...shared, ...targetOnly, ...fresh].forEach((a, i) => { table[a.key] = vis(1000 + i); });
  const started = performance.now();
  const plan = api.reconcileMedia(base, now, [], [], visualsOf(now, table));
  const ms = performance.now() - started;
  assert.equal(plan.patches.filter(p => p.kind === 'attach').length, 90);
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});
