import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const url = path => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(readFileSync(path, 'utf8'))).toString('base64');
const client = await import(url('src/lib/shopify/owned-edit-client.ts'));

const angle = (n, extra = {}) => ({ id: 'a' + n, itemId: 'i', angleKey: String(n), angleOrder: n, imagePath: `https://cdn/x${n}.jpg`, imageAlt: `alt ${n}`, ...extra });
const card = (extra = {}) => ({
  id: 'i', title: 'פאוץ׳ בצבע שחור', description: 'תיאור', descriptionHtml: '<p>תיאור</p>', seoTitle: 'seo בצבע שחור', seoDescription: 'תיאור seo בצבע שחור.',
  copyUpdatedAt: '2026-11-09T10:00:00Z', editorRevision: 1, catalogNumber: 'P10FZT73001', coverImagePath: 'https://cdn/x1.jpg', coverImageAlt: 'alt 1',
  displayOrder: 3, isActive: true, angles: [angle(1), angle(2)], ...extra,
});
const changes = (patch, saved = card()) => client.ownedCardChanges(saved, { ...saved, ...patch });

test('an untouched card, or a change outside the delivered fields, produces no patch', () => {
  assert.deepEqual(changes({}), { patch: {}, unsupported: [] });
  assert.deepEqual(changes({ displayOrder: 9 }), { patch: {}, unsupported: [] });
});

test('title, description, SEO and image alt edits become a minimal patch', () => {
  assert.deepEqual(changes({ title: 'חדש בצבע שחור' }).patch, { title: 'חדש בצבע שחור' });
  assert.deepEqual(changes({ description: 'חדש', descriptionHtml: '<p>חדש</p>' }).patch, { description: 'חדש', descriptionHtml: '<p>חדש</p>' });
  assert.deepEqual(changes({ seoTitle: 'x בצבע שחור', seoDescription: 'y בצבע שחור.' }).patch, { seoTitle: 'x בצבע שחור', seoDescription: 'y בצבע שחור.' });
  assert.deepEqual(changes({ coverImageAlt: 'כיסוי חדש' }).patch, { coverImageAlt: 'כיסוי חדש' });
  assert.deepEqual(changes({ angles: [angle(1), angle(2, { imageAlt: 'חדש' })] }).patch, { angles: [{ id: 'a2', imageAlt: 'חדש' }] });
});

test('edits that cannot reach Shopify from the Gallery are named, never silently dropped', () => {
  const only = result => result.unsupported.sort();
  assert.deepEqual(only(changes({ seoTitle: '  ' })), ['empty_seo']);
  assert.deepEqual(only(changes({ seoDescription: '' })), ['empty_seo']);
  assert.deepEqual(only(changes({ coverImageAlt: '' })), ['empty_alt']);
  assert.deepEqual(only(changes({ angles: [angle(1), angle(2, { imageAlt: ' ' })] })), ['empty_alt']);
  assert.deepEqual(only(changes({ description: 'חדש', descriptionHtml: null })), ['plain_description']);
  assert.deepEqual(only(changes({ coverImagePath: 'https://cdn/other.jpg' })), ['images']);
  assert.deepEqual(only(changes({ angles: [angle(1)] })), ['images']);
  assert.deepEqual(only(changes({ angles: [angle(1), angle(2), angle(3)] })), ['images']);
  assert.deepEqual(only(changes({ angles: [angle(1), angle(2, { imagePath: 'https://cdn/swapped.jpg' })] })), ['images']);
  assert.deepEqual(only(changes({ angles: [angle(1), angle(2, { angleOrder: 5 })] })), ['images']);
  assert.deepEqual(only(changes({ catalogNumber: 'OTHER' })), ['catalog_number']);
  assert.deepEqual(only(changes({ isActive: false })), ['visibility']);
  for (const code of Object.keys(client.OWNED_UNSUPPORTED_MESSAGES)) assert.match(client.OWNED_UNSUPPORTED_MESSAGES[code], /[א-ת]/);
});

test('an allowed edit next to an unsupported one still reports the unsupported part', () => {
  const result = changes({ title: 'חדש בצבע שחור', angles: [angle(1)] });
  assert.deepEqual(result.patch, { title: 'חדש בצבע שחור' });
  assert.deepEqual(result.unsupported, ['images']);
});

test('every refusal code the owned edit can return explains itself in Hebrew', () => {
  const sources = ['src/lib/shopify/owned-edit-plan.ts', 'src/lib/shopify/owned-edit-service.ts', 'src/app/api/admin/shopify/owned/edit/route.ts']
    .map(path => readFileSync(path, 'utf8')).join('\n');
  const owned = [...new Set(sources.match(/SYNC_OWNED_[A-Z_]+/g))];
  assert.ok(owned.length >= 15);
  const generic = client.ownedEditErrorMessage('SYNC_NOT_A_REAL_CODE');
  assert.match(generic, /SYNC_NOT_A_REAL_CODE/);
  for (const code of owned) {
    const message = client.ownedEditErrorMessage(code);
    assert.notEqual(message, client.ownedEditErrorMessage('SYNC_NOT_A_REAL_CODE').replace('SYNC_NOT_A_REAL_CODE', code), code);
    assert.match(message, /[א-ת]/, code);
  }
  for (const code of ['SYNC_COPY_STALE_EDIT_RELOAD', 'SYNC_COPY_CONCURRENT_UPDATE', 'SYNC_COPY_READBACK_MISMATCH', 'SYNC_RECONCILIATION_BUSY',
    'SYNC_DESCRIPTION_HTML_UNSAFE', 'SYNC_DESCRIPTION_PAIR_MISMATCH', 'SYNC_ONBOARDING_COPY_LIMIT', 'SYNC_FZT73_BASELINE_REQUIRED', 'SYNC_MD20_BASELINE_REQUIRED',
    'SYNC_FZT73_EDITORIAL_CHANGED', 'SYNC_MD20_EDITORIAL_CHANGED', 'SHOPIFY_MEDIA_ALT_WRITE_REJECTED', 'SHOPIFY_PRODUCT_COPY_WRITE_REJECTED']) {
    assert.doesNotMatch(client.ownedEditErrorMessage(code), /\(SYNC_|\(SHOPIFY_/, code);
  }
});

test('the editor delivers owned colors through their own button and no longer locks their text', () => {
  const page = readFileSync('src/app/admin/page.tsx', 'utf8');
  assert.match(page, /\/api\/admin\/shopify\/owned\/edit/);
  assert.match(page, /saveOwnedCard/);
  // Only the catalog number stays locked on a source-owned card.
  assert.deepEqual([...page.matchAll(/readOnly=\{sourceOwned[^}]*\}/g)].map(match => match[0]), ['readOnly={sourceOwned || Boolean(item.shopifyLink)}']);
  // A catalog-wide save must refuse pending owned edits instead of dropping or half-saving them.
  assert.match(page, /ownedCardChanges\(saved, item\)/);
  // Image structure stays Shopify-only: upload, add and remove are disabled on owned cards.
  assert.equal([...page.matchAll(/disabled=\{sourceOwned\}/g)].length, 3);
});
