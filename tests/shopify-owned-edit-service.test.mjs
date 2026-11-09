import test from 'node:test';
import assert from 'node:assert/strict';
import { family, service, loadWrapped, description } from './helpers/owned-edit-harness.mjs';

const makeAdmin = await loadWrapped('src/lib/shopify/admin-api.ts', [
  'createShopifyClientCredentialsProvider', 'plainDescriptionToHtml', 'descriptionTextFromHtml',
  'descriptionPairsEquivalent', 'assertSafeDescriptionHtml', 'process',
], ['writeShopifyVisibleCopy', 'visibleCopyFromProduct']);

const owner = '11111111-1111-4111-8111-111111111111';
async function setup(key, index = 0) {
  const f = await family(key);
  const s = service(f);
  const variant = f.variants[index];
  const row = () => f.tables.carousel_items.find(r => r.id === variant.itemId);
  const request = patch => ({ itemId: variant.itemId, expectedVersion: row().copy_updated_at, expectedRevision: row().editor_revision, patch });
  const deadline = () => Date.now() + 45000;
  const lease = async () => { await f.db.rpc('acquire_shopify_reconciliation_lease', { p_product_gid: f.productGid, p_owner: owner }); };
  const apply = async patch => { await lease(); return s.applyOwnedGalleryEdit(f.db, request(patch), owner, deadline()); };
  const angle = order => f.tables.carousel_item_angles.find(a => a.item_id === variant.itemId && a.angle_order === order);
  const token = order => key === 'md20' ? angle(order).image_alt.match(/ \| [^|]+ \| \d+$/)[0] : '';
  return { f, s, variant, row, request, apply, deadline, lease, angle, token };
}

for (const key of ['fzt73', 'md20']) {
  test(`${key}: a description edit reaches Shopify first, then every color card is rebuilt from it`, async () => {
    const { f, s, apply, row } = await setup(key);
    const versionBefore = row().copy_updated_at;
    const html = '<p>תיאור חדש</p><ul><li>נקודה אחת</li></ul>';
    const result = await apply({ description: f.helpers.descriptionTextFromHtml(html), descriptionHtml: html });
    assert.equal(result.changed, true);
    assert.deepEqual(result.written, ['description']);
    assert.equal(f.state.product.descriptionHtml, html);
    assert.equal(s.writes.copy.length, 1);
    assert.equal(s.writes.alt.length, 0);
    for (const v of f.variants) assert.equal(f.tables.carousel_items.find(r => r.id === v.itemId).description_html, html);
    assert.notEqual(row().copy_updated_at, versionBefore);
    assert.equal(result.copyUpdatedAt, row().copy_updated_at);
    assert.ok(f.calls.filter(c => c.name === f.batchRpc).every(c => c.args.p_owner === owner));
  });

  test(`${key}: a title edit changes the shared Shopify title and every color follows`, async () => {
    const { f, apply, variant } = await setup(key);
    const wanted = key === 'fzt73' ? `שם חדש לפאוץ׳ בצבע ${variant.color}` : 'שם חדש לפאוץ׳';
    await apply({ title: wanted });
    assert.equal(f.state.product.title, 'שם חדש לפאוץ׳');
    for (const v of f.variants) {
      assert.equal(f.tables.carousel_items.find(r => r.id === v.itemId).title, key === 'fzt73' ? `שם חדש לפאוץ׳ בצבע ${v.color}` : 'שם חדש לפאוץ׳');
    }
  });

  test(`${key}: SEO title and description are delivered with their verified color suffix`, async () => {
    const { f, apply, variant } = await setup(key);
    await apply({ seoTitle: `כותרת SEO חדשה בצבע ${variant.color}`, seoDescription: `תיאור SEO חדש בצבע ${variant.color}. משפט נוסף.` });
    assert.deepEqual(f.state.product.seo, { title: 'כותרת SEO חדשה', description: 'תיאור SEO חדש. משפט נוסף.' });
    for (const v of f.variants) {
      const stored = f.tables.carousel_items.find(r => r.id === v.itemId);
      assert.equal(stored.seo_title, `כותרת SEO חדשה בצבע ${v.color}`);
      assert.equal(stored.seo_description, `תיאור SEO חדש בצבע ${v.color}. משפט נוסף.`);
    }
  });

  test(`${key}: image alt text is delivered to the exact image and only that color changes`, async () => {
    const { f, s, apply, variant, angle, token } = await setup(key);
    const target = angle(2);
    const others = f.variants.filter(v => v !== variant).map(v => [v.itemId, structuredClone(f.cardOf(v.itemId).angles)]);
    const alt = 'תיאור חדש לתמונה' + token(2);
    const result = await apply({ angles: [{ id: target.id, imageAlt: alt }] });
    assert.deepEqual(result.written, ['alt:' + target.image_path]);
    assert.equal(s.writes.copy.length, 0);
    assert.equal(s.writes.alt.length, 1);
    assert.equal(f.cardOf(variant.itemId).angles[1].image_alt, alt);
    for (const [itemId, angles] of others) assert.deepEqual(f.cardOf(itemId).angles, angles);
  });

  test(`${key}: alt text is written before copy, in separate Shopify requests`, async () => {
    const { f, s, apply, variant, angle, token } = await setup(key);
    const order = [];
    for (const name of ['copy', 'alt']) { const push = s.writes[name].push.bind(s.writes[name]); s.writes[name].push = (...args) => { order.push(name); return push(...args); }; }
    const html = '<p>שניהם יחד</p>';
    await apply({ description: 'שניהם יחד', descriptionHtml: html, angles: [{ id: angle(1).id, imageAlt: 'אלט חדש' + token(1) }] });
    assert.deepEqual(order, ['alt', 'copy']);
    assert.equal(f.state.product.descriptionHtml, html);
    assert.equal(f.cardOf(variant.itemId).angles[0].image_alt, 'אלט חדש' + token(1));
  });

  test(`${key}: a stale form is refused before anything is read from or written to Shopify`, async () => {
    const { f, s, variant, row, deadline, lease } = await setup(key);
    await lease();
    const stale = { itemId: variant.itemId, expectedVersion: '2026-01-01T00:00:00.000Z', expectedRevision: row().editor_revision, patch: { title: 'x' } };
    await assert.rejects(s.applyOwnedGalleryEdit(f.db, stale, owner, deadline()), /SYNC_COPY_STALE_EDIT_RELOAD/);
    await assert.rejects(s.applyOwnedGalleryEdit(f.db, { ...stale, expectedVersion: row().copy_updated_at, expectedRevision: 99 }, owner, deadline()), /SYNC_COPY_STALE_EDIT_RELOAD/);
    assert.equal(f.state.reads, 0);
    assert.equal(s.writes.copy.length + s.writes.alt.length, 0);
  });

  test(`${key}: a Shopify change the editor has not seen makes the form stale and is shown, never overwritten`, async () => {
    const { f, s, apply } = await setup(key);
    f.state.product.descriptionHtml = '<p>עודכן בחנות בינתיים</p>';
    await assert.rejects(apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>' }), /SYNC_COPY_STALE_EDIT_RELOAD/);
    assert.equal(s.writes.copy.length + s.writes.alt.length, 0);
    assert.equal(f.state.product.descriptionHtml, '<p>עודכן בחנות בינתיים</p>');
    for (const v of f.variants) assert.equal(f.tables.carousel_items.find(r => r.id === v.itemId).description_html, '<p>עודכן בחנות בינתיים</p>');
  });

  test(`${key}: a Shopify change between planning and writing stops the write`, async () => {
    const { f, s, apply } = await setup(key);
    // Snapshot reads: three for the preflight rebuild, one to plan, the fifth is the one just before writing.
    f.state.onRead = n => { if (n === 5) f.state.product.title = 'שונה בחנות ברגע האחרון'; };
    await assert.rejects(apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>' }), /SYNC_COPY_CONCURRENT_UPDATE/);
    assert.equal(s.writes.copy.length + s.writes.alt.length, 0);
  });

  test(`${key}: an edit that changes nothing writes nothing`, async () => {
    const { f, s, apply, variant } = await setup(key);
    const card = f.cardOf(variant.itemId);
    const result = await apply({ title: card.title, seoTitle: card.seo_title });
    assert.equal(result.changed, false);
    assert.equal(s.writes.copy.length + s.writes.alt.length, 0);
  });

  test(`${key}: unpublished, hidden, unknown and unbound cards are refused`, async () => {
    for (const status of ['DRAFT', 'ARCHIVED', 'UNLISTED']) {
      const { f, s, apply } = await setup(key);
      f.state.product.status = status;
      await assert.rejects(apply({ title: 'x' }), /SYNC_OWNED_SOURCE_UNPUBLISHED/);
      assert.equal(s.writes.copy.length, 0);
    }
    {
      const { f, apply, variant } = await setup(key);
      f.tables.carousel_items.find(r => r.id === variant.itemId).is_active = false;
      await assert.rejects(apply({ title: 'x' }), /SYNC_OWNED_IDENTITY_CONFLICT/);
    }
    {
      const { f, apply } = await setup(key);
      f.tables.shopify_gallery_bindings.find(b => b.carousel_item_id === f.variants[0].itemId).variant_gid = 'gid://shopify/ProductVariant/1';
      await assert.rejects(apply({ title: 'x' }), /SYNC_OWNED_IDENTITY_CONFLICT/);
    }
    {
      const { s, f, lease, deadline } = await setup(key);
      await lease();
      await assert.rejects(s.applyOwnedGalleryEdit(f.db, { itemId: '00000000-0000-4000-8000-000000000000', expectedVersion: '2026-01-01T00:00:00Z',
        expectedRevision: 1, patch: { title: 'x' } }, owner, deadline()), /SYNC_OWNED_ITEM_UNKNOWN/);
    }
  });

  test(`${key}: a projection that cannot follow (baseline, outbox or hidden Gallery edit) stops before Shopify is touched`, async () => {
    for (const code of ['SYNC_FZT73_BASELINE_REQUIRED', 'SYNC_MD20_BASELINE_REQUIRED']) {
      const { f, s, apply, variant } = await setup(key);
      f.state.batchError = code;
      await assert.rejects(apply({ seoTitle: `חדש בצבע ${variant.color}` }), new RegExp(code));
      assert.equal(s.writes.copy.length + s.writes.alt.length, 0);
    }
    const { f, s, apply, variant } = await setup(key);
    f.tables.carousel_items.find(r => r.id === variant.itemId).title = 'נערך בגלריה בלי להישלח';
    await assert.rejects(apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>' }), /SYNC_FZT73_EDITORIAL_CHANGED/);
    assert.equal(s.writes.copy.length + s.writes.alt.length, 0);
  });

  test(`${key}: a lease that is not held refuses the edit before any Shopify write`, async () => {
    const { f, s, variant, row, deadline } = await setup(key);
    f.state.busy = true;
    await assert.rejects(s.applyOwnedGalleryEdit(f.db, { itemId: variant.itemId, expectedVersion: row().copy_updated_at,
      expectedRevision: row().editor_revision, patch: { title: 'x' } }, owner, deadline()), /LEASE_REQUIRED/);
    assert.equal(s.writes.copy.length, 0);
  });

  test(`${key}: a first rejected response is reconciled without claiming that nothing was sent`, async () => {
    const { f, apply } = await setup(key);
    const before = structuredClone(f.tables);
    f.state.failCopyWrite = 'SHOPIFY_PRODUCT_COPY_WRITE_REJECTED';
    await assert.rejects(apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>' }), /SYNC_OWNED_EDIT_UNCERTAIN/);
    assert.deepEqual(f.tables, before);
  });

  test(`${key}: a partially applied first ALT mutation is read back and projected even when it rejects`, async () => {
    const { f, apply, variant, angle, token } = await setup(key);
    f.state.partialAltWrite = true;
    const first = 'ראשון נשלח' + token(1), second = 'שני לא נשלח' + token(2);
    await assert.rejects(apply({ angles: [{ id: angle(1).id, imageAlt: first }, { id: angle(2).id, imageAlt: second }] }), /SYNC_OWNED_EDIT_PARTIAL/);
    assert.equal(f.cardOf(variant.itemId).angles[0].image_alt, first);
    assert.notEqual(f.cardOf(variant.itemId).angles[1].image_alt, second);
  });

  test(`${key}: a lost first copy response can succeed only after source and Gallery readback prove delivery`, async () => {
    const { f, apply, variant } = await setup(key);
    f.state.copyResponseLost = true;
    const result = await apply({ description: 'הגיע למרות תשובה אבודה', descriptionHtml: '<p>הגיע למרות תשובה אבודה</p>' });
    assert.equal(result.ok, true);
    assert.equal(f.cardOf(variant.itemId).description_html, '<p>הגיע למרות תשובה אבודה</p>');
  });

  test(`${key}: ALT followed by an external copy change refuses the second mutation and preserves the external text`, async () => {
    const { f, s, apply, variant, angle, token } = await setup(key);
    f.state.afterAlt = () => { f.state.product.descriptionHtml = '<p>external during alt</p>'; };
    await assert.rejects(apply({ description: 'my edit', descriptionHtml: '<p>my edit</p>',
      angles: [{ id: angle(1).id, imageAlt: 'האלט שלנו' + token(1) }] }), /SYNC_OWNED_EDIT_PARTIAL/);
    assert.equal(s.writes.copy.length, 0);
    assert.equal(f.state.product.descriptionHtml, '<p>external during alt</p>');
    assert.equal(f.cardOf(variant.itemId).description_html, '<p>external during alt</p>');
  });

  test(`${key}: Shopify mirroring our ALT into image.altText does not create a false conflict`, async () => {
    const { f, apply, angle, token } = await setup(key);
    f.state.afterAlt = () => { for (const media of f.state.product.media.nodes) {
      if (media.alt === 'האלט שלנו' + token(1)) media.image.altText = media.alt;
    } };
    const result = await apply({ description: 'my edit', descriptionHtml: '<p>my edit</p>',
      angles: [{ id: angle(1).id, imageAlt: 'האלט שלנו' + token(1) }] });
    assert.equal(result.ok, true);
    assert.equal(f.state.product.descriptionHtml, '<p>my edit</p>');
  });

  test(`${key}: an unrelated ALT mirror change during our ALT write still blocks copy`, async () => {
    const { f, s, apply, angle, token } = await setup(key);
    f.state.afterAlt = () => { f.state.product.media.nodes[1].image.altText = 'external mirror'; };
    await assert.rejects(apply({ description: 'my edit', descriptionHtml: '<p>my edit</p>',
      angles: [{ id: angle(1).id, imageAlt: 'האלט שלנו' + token(1) }] }), /SYNC_OWNED_EDIT_PARTIAL/);
    assert.equal(s.writes.copy.length, 0);
  });

  test(`${key}: an expired deadline after ALT prevents starting copy and returns uncertainty`, async () => {
    const { f, s, request, lease, angle, token } = await setup(key);
    await lease();
    const end = Date.now() + 45000;
    const realNow = Date.now;
    f.state.afterAlt = () => { Date.now = () => end; };
    try {
      await assert.rejects(s.applyOwnedGalleryEdit(f.db, request({ description: 'my edit', descriptionHtml: '<p>my edit</p>',
        angles: [{ id: angle(1).id, imageAlt: 'האלט שלנו' + token(1) }] }), owner, end), /SYNC_OWNED_EDIT_UNCERTAIN/);
      assert.equal(s.writes.copy.length, 0);
    } finally { Date.now = realNow; }
  });

  test(`${key}: readback failure after an ambiguous first mutation never becomes a no-change rejection`, async () => {
    const { f, apply } = await setup(key);
    f.state.afterAlt = () => { f.state.failRead = 'SHOPIFY_API_HTTP_503'; };
    f.state.altResponseLost = true;
    await assert.rejects(apply({ coverImageAlt: 'תשובה לא ידועה' + (key === 'md20' ? ' | ' + f.variants[0].sku + ' | 1' : '') }), /SYNC_OWNED_EDIT_UNCERTAIN/);
  });

  test(`${key}: alt text that landed before a failed copy write is reported as partial and the Gallery follows Shopify`, async () => {
    const { f, apply, variant, angle, token } = await setup(key);
    f.state.failCopyWrite = 'SHOPIFY_PRODUCT_COPY_WRITE_REJECTED';
    await assert.rejects(apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>', angles: [{ id: angle(1).id, imageAlt: 'חלקי' + token(1) }] }), /SYNC_OWNED_EDIT_PARTIAL/);
    assert.equal(f.cardOf(variant.itemId).angles[0].image_alt, 'חלקי' + token(1));
    assert.notEqual(f.state.product.descriptionHtml, '<p>שלי</p>');
  });

  test(`${key}: a write Shopify silently ignored is reported, not claimed as saved`, async () => {
    const { f, apply } = await setup(key);
    f.state.dropCopyWrite = true;
    await assert.rejects(apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>' }), /SYNC_COPY_READBACK_MISMATCH/);
  });

  test(`${key}: when Shopify has the change but the cards cannot be rebuilt, the result says so`, async () => {
    const { f, apply } = await setup(key);
    // The preflight rebuild (three reads) and the plan (one) come first; fail the batch from the next read on.
    f.state.onRead = n => { if (n >= 5) f.state.batchError = 'SYNC_COPY_CONCURRENT_UPDATE'; };
    await assert.rejects(apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>' }), /SYNC_OWNED_EDIT_DELIVERED_PROJECTION_PENDING/);
    assert.equal(f.state.product.descriptionHtml, '<p>שלי</p>');
  });

  test(`${key}: losing the lease after a verified ALT write is projection pending, never a success`, async () => {
    const { f, apply, angle, token } = await setup(key);
    f.state.afterAlt = () => { f.state.leaseOwner = 'other-owner'; };
    await assert.rejects(apply({ angles: [{ id: angle(1).id, imageAlt: 'האלט שלנו' + token(1) }] }), /SYNC_OWNED_EDIT_DELIVERED_PROJECTION_PENDING/);
  });

  test(`${key}: a source change during the final rebuild cannot be reported as our verified card`, async () => {
    const { f, apply } = await setup(key);
    // Our first readback is 6; the reconciliation starts with a newer source at 7.
    f.state.onRead = n => { if (n === 7) f.state.product.descriptionHtml = '<p>external after readback</p>'; };
    await assert.rejects(apply({ description: 'my edit', descriptionHtml: '<p>my edit</p>' }), /SYNC_COPY_READBACK_MISMATCH/);
  });

  test(`${key}: a hidden sibling color is neither projected nor reactivated`, async () => {
    const { f, apply } = await setup(key, 0);
    const hidden = f.variants[1];
    f.tables.carousel_items.find(r => r.id === hidden.itemId).is_active = false;
    const hiddenBefore = structuredClone(f.tables.carousel_items.find(r => r.id === hidden.itemId));
    await apply({ description: 'שלי', descriptionHtml: '<p>שלי</p>' });
    assert.deepEqual(f.tables.carousel_items.find(r => r.id === hidden.itemId), hiddenBefore);
    assert.ok(f.calls.filter(c => c.name === f.batchRpc).every(c => !c.args.p_entries.some(e => e.itemId === hidden.itemId)));
  });
}

test('only the two reviewed families are owned', async () => {
  const f = await family('fzt73');
  const s = service(f);
  for (const v of f.variants) assert.equal(s.ownedFamilyForItem(v.itemId).key, 'fzt73');
  assert.equal(s.ownedFamilyForItem('660aea87-5082-438d-86f0-bd982ac43a68'), null);
  const m = await family('md20');
  for (const v of m.variants) assert.equal(service(m).ownedFamilyForItem(v.itemId).key, 'md20');
});

test('the real copy transport honors the owned deadline before network, including time consumed acquiring a token', async t => {
  // Only synthetic process/config/token values are supplied; no environment secrets or network are read.
  const current = { id: 'gid://shopify/Product/123', title: 'old', descriptionHtml: '<p>old</p>', seoTitle: 'old', seoDescription: 'old' };
  let calls = 0, now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('NETWORK_MUST_NOT_START'); });
  for (const expireDuringToken of [false, true]) {
    now = 1000;
    const api = makeAdmin({ ...description,
      process: { env: { SHOPIFY_SHOP_DOMAIN: 'fixture.myshopify.com', SHOPIFY_CLIENT_ID: 'fixture', SHOPIFY_CLIENT_SECRET: 'fixture',
        SHOPIFY_ONLINE_STORE_PUBLICATION_ID: 'gid://shopify/Publication/1' } },
      createShopifyClientCredentialsProvider: () => async () => { if (expireDuringToken) now = 2000; return 'synthetic-token'; },
    });
    await assert.rejects(api.writeShopifyVisibleCopy(current.id, { ...api.visibleCopyFromProduct(current), title: 'new' }, current,
      expireDuringToken ? 1500 : 1000), /SPEC_TIME_BUDGET/);
  }
  assert.equal(calls, 0);
});
