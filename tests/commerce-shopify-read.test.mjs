import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { p, fixture, gid, time } from './helpers/commerce-fixtures.mjs';
import { descriptionModuleUrl } from './helpers/description-module.mjs';

const data = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolveImageLimits(source))).toString('base64')}`;
const policy = data(readFileSync(new URL('../src/lib/shopify/commerce-finalization.ts', import.meta.url), 'utf8').replace("'zod'", JSON.stringify(import.meta.resolve('zod'))));
const moduleSource = readFileSync(new URL('../src/lib/shopify/commerce-shopify-read.ts', import.meta.url), 'utf8');
const source = moduleSource.replace('import "server-only";', '')
  .replace('from "zod"', `from ${JSON.stringify(import.meta.resolve('zod'))}`)
  .replace('import { configuredShopifyDomain, shopifyAdminGraphql } from "./admin-api";', 'const configuredShopifyDomain=()=>"toptikcoil.myshopify.com"; const shopifyAdminGraphql=()=>{throw Error("NETWORK_FORBIDDEN")};')
  .replace('from "./description-document"', `from ${JSON.stringify(descriptionModuleUrl)}`)
  .replace('from "./commerce-finalization"', `from ${JSON.stringify(policy)}`);
const m = await import(data(source));
const cp = structuredClone, conn = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
const paged = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
function setup() {
  const f = fixture(), identity = cp(f.snapshot.identity), namespace = identity.customId.namespace;
  const sourceId = { namespace, key: 'source_item_id', type: 'single_line_text_field', value: identity.customId.value };
  const sourceHash = { namespace, key: 'creation_source_hash', type: 'single_line_text_field', value: identity.sourceFingerprint };
  const image = { id: gid('MediaImage', 10), mediaContentType: 'IMAGE', status: 'READY', alt: null, fileStatus: 'READY', updatedAt: time,
    image: { id: gid('ImageSource', 11), url: 'https://cdn.shopify.com/s/files/1/0001/files/synthetic.png?v=1', width: 400, height: 600 } };
  const product = { id: identity.productGid, handle: identity.handle, vendor: identity.brand, status: 'DRAFT', updatedAt: time,
    title: 'Synthetic local fixture', descriptionHtml: '<p>Exact <strong>copy</strong>.</p>', seo: { title: null, description: null },
    productType: '', tags: [], templateSuffix: null, isGiftCard: false, requiresSellingPlan: false, category: null,
    options: [{ id: gid('ProductOption', 12), name: 'Title', position: 1, values: ['Default Title'] }], sourceId, sourceHash,
    metafields: conn([sourceId, sourceHash]), variants: conn([{ id: identity.variantGid, sku: identity.sku }]),
    publications: conn([]), marketPublications: conn([]), companyPublications: conn([]), media: conn([image]) };
  const variant = { id: identity.variantGid, sku: identity.sku, product: { id: identity.productGid }, updatedAt: time,
    price: '0.00', compareAtPrice: null, barcode: null, taxable: true, inventoryPolicy: 'DENY', publishedOnPublication: true,
    requiresComponents: false, unitPrice: null, selectedOptions: [{ name: 'Title', value: 'Default Title' }],
    productParents: conn([]), productVariantComponents: conn([]), sellingPlanGroups: conn([]), metafields: conn([]),
    image: { id: gid('ProductImage', 999), url: image.image.url }, media: conn([{ id: image.id }]),
    inventoryItem: { id: identity.inventoryItemGid, sku: identity.sku, updatedAt: time, tracked: true, requiresShipping: true,
      trackedEditable: { locked: false }, countryCodeOfOrigin: null, provinceCodeOfOrigin: null, harmonizedSystemCode: null,
      unitCost: null, measurement: { weight: null }, countryHarmonizedSystemCodes: conn([]), variants: conn([{ id: identity.variantGid }]) } };
  const config = { shop: { myshopifyDomain: p.SHOP, currencyCode: 'ILS' },
    currentAppInstallation: { app: { id: gid('App', 123) }, accessScopes: ['read_products', 'write_products', 'write_inventory', 'write_publications'].map(handle => ({ handle })) },
    publication: { id: p.PUBLICATION, catalog: { __typename: 'AppCatalog' } } };
  const locations = paged([{ id: gid('Location', 1), isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: false, fulfillmentService: null }]);
  const catalog = paged([{ id: identity.variantGid, sku: identity.sku, product: { id: identity.productGid, status: 'DRAFT' } }]);
  const quantities = ['available', 'on_hand', 'committed', 'reserved', 'damaged', 'safety_stock', 'quality_control', 'incoming'].map(name => ({ name, quantity: 0 }));
  const levels = { inventoryItem: { id: identity.inventoryItemGid, updatedAt: time, inventoryLevels: paged([
    { id: 'gid://shopify/InventoryLevel/40?inventory_item_id=9003', isActive: true, item: { id: identity.inventoryItemGid }, location: { id: gid('Location', 1) }, quantities },
  ]) } };
  const state = { f, identity, product, variant, config, locations, catalog, levels, now: Date.parse(time), calls: [], decodes: [], hook: null };
  state.deps = {
    now: () => state.now,
    query: async (query, variables, deadline) => {
      state.calls.push({ query, variables: cp(variables), deadline });
      const changed = await state.hook?.(query, variables); if (changed !== undefined) return changed;
      if (query === m.COMMERCE_CONFIG_QUERY) return cp(config);
      if (query === m.COMMERCE_LOCATIONS_QUERY) return { locations: cp(locations) };
      if (query === m.COMMERCE_CATALOG_QUERY) return { productVariants: cp(catalog) };
      if (query === m.COMMERCE_PRODUCT_QUERY) return cp({ product, productVariant: variant });
      if (query === m.COMMERCE_LEVELS_QUERY) return cp(levels);
      throw Error('UNEXPECTED_QUERY');
    },
    decode: async (image, deadline) => { state.decodes.push({ image, deadline }); return { mediaGid: image.mediaGid, url: image.url,
      width: image.width, height: image.height, mime: 'image/png', byteLength: 12345, sha256: p.fingerprint(image.url) }; },
  };
  state.read = () => m.readCommerceShopify(state.identity, Date.parse(time) + 8000, state.deps, true);
  return state;
}
function assemble(s, read) {
  const { shopDomain, apiVersion, shopCurrency, scopes, capturedAt, locations, locationsComplete, shopify, catalogCapturedAt, ...context } = s.f.context;
  void shopDomain; void apiVersion; void shopCurrency; void scopes; void capturedAt; void locations; void locationsComplete; void shopify; void catalogCapturedAt;
  return m.assembleCommerceRead(read, { galleryRowFingerprint: s.f.snapshot.galleryRowFingerprint, galleryCopyVersion: time,
    galleryCopy: { ...s.f.snapshot.galleryCopy, description: null }, context });
}

test('default no-inventory reader needs products/publications only and never calls location or quantity resolvers',async()=>{
 const s=setup();s.config.currentAppInstallation.accessScopes=s.config.currentAppInstallation.accessScopes.filter(x=>x.handle!=='write_inventory');
 s.variant.inventoryItem.tracked=false;
 const read=await m.readCommerceShopify(s.identity,Date.parse(time)+8000,s.deps);
 assert.deepEqual(read.snapshot.levels,[]);assert.equal(read.snapshot.levelsComplete,false);
 assert.deepEqual(read.context.locations,[]);assert.equal(read.context.locationsComplete,false);
 assert.equal(read.snapshot.commercial.tracked,false);
 assert.ok(s.calls.every(x=>x.query!==m.COMMERCE_LEVELS_QUERY&&x.query!==m.COMMERCE_LOCATIONS_QUERY));
 assert.equal(s.calls.length,6);
});
test('existing-product commerce read accepts exact 25MP decode evidence and rejects above it',async()=>{
 const s=setup();s.product.media.nodes[0].image.width=5000;s.product.media.nodes[0].image.height=5000;
 const result=await s.read();assert.ok(result.snapshot.copyMediaFingerprint);
 s.product.media.nodes[0].image.width=5001;await assert.rejects(s.read(),/DECODE_IDENTITY_CHANGED/);
});

test('complete real reader projection composes with the unchanged finalization policy and raw Gallery nulls', async () => {
  const s = setup(), read = await s.read(), full = assemble(s, read);
  const expectedCopy = { title: s.product.title, descriptionHtml: s.product.descriptionHtml, seoTitle: null, seoDescription: null };
  const expectedMedia = [{ mediaGid: gid('MediaImage', 10), url: s.product.media.nodes[0].image.url, width: 400, height: 600,
    mime: 'image/png', byteLength: 12345, sha256: p.fingerprint(s.product.media.nodes[0].image.url), productGid: s.identity.productGid, status: 'READY', alt: '' }];
  assert.equal(read.snapshot.copyMediaFingerprint, p.fingerprint({ copy: expectedCopy, media: expectedMedia }));
  assert.equal(full.snapshot.galleryCopy.description, null);
  assert.equal(full.snapshot.shopifyCopy.description, 'Exact copy.');
  s.f.proof.readbackCopyMediaFingerprint = read.snapshot.copyMediaFingerprint;
  const planned = p.prepareFinalization(s.f.intent, s.f.proof, full.snapshot, full.context);
  assert.equal(planned.plan.initial.identity.inventoryItemGid, s.identity.inventoryItemGid);
  assert.equal(planned.plan.steps.at(-1).kind, 'publish_product');
  assert.equal(s.calls.length, 10); assert.equal(s.decodes.length, 1);
  assert.ok(s.calls.every(x => x.deadline === Date.parse(time) + 8000));
});

test('initial receipt identity can discover inventory ID and handle; planned retries pin both', async () => {
  const s = setup(); delete s.identity.inventoryItemGid; delete s.identity.handle;
  const read = await s.read(); assert.equal(read.snapshot.identity.inventoryItemGid, gid('InventoryItem', 9003));
  s.identity = read.snapshot.identity; s.variant.inventoryItem.id = gid('InventoryItem', 99);
  await assert.rejects(s.read(), /IDENTITY_CHANGED/);
});
test('DRAFT parent remains separate from true and false variant publication', async () => {
  const s = setup(); assert.equal((await s.read()).snapshot.variantOnlinePublished, true);
  s.variant.publishedOnPublication = false; assert.equal((await s.read()).snapshot.variantOnlinePublished, false);
});
test('ACTIVE publication is retained and future staged publications are refused', async () => {
  const s = setup(); s.product.status = 'ACTIVE'; s.catalog.nodes[0].product.status = 'ACTIVE';
  s.product.publications.nodes.push({ isPublished: true, publishDate: time, publication: { id: p.PUBLICATION } });
  assert.deepEqual((await s.read()).snapshot.publicationIds, [p.PUBLICATION]);
  s.product.publications.nodes[0].isPublished = false; await assert.rejects(s.read(), /SCHEDULED_PUBLICATION_UNSUPPORTED/);
});
test('inactive levels retain all quantity states, including incoming outside on-hand', async () => {
  const s = setup(), level = s.levels.inventoryItem.inventoryLevels.nodes[0]; level.isActive = false;
  const amounts = [3, 9, 1, 2, 1, 1, 1, 12]; level.quantities.forEach((q, index) => q.quantity = amounts[index]);
  const read = await s.read(); assert.equal(read.snapshot.levels[0].active, false);
  assert.deepEqual(read.snapshot.levels[0].quantities, { available: 3, onHand: 9, committed: 1, reserved: 2, damaged: 1, safetyStock: 1, qualityControl: 1, incoming: 12 });
});
test('actual granted scopes required before product/image calls; read_inventory is not write authority', async () => {
  const s = setup(); s.config.currentAppInstallation.accessScopes = [{ handle: 'read_inventory' }, { handle: 'write_products' }, { handle: 'write_publications' }];
  await assert.rejects(s.read(), /SCOPES_REQUIRED/); assert.equal(s.calls.length, 1); assert.equal(s.decodes.length, 0);
});
test('current installed app namespace, exact shop and publication are pinned', () => {
  for (const mutate of [s => s.config.currentAppInstallation.app.id = gid('App', 999), s => s.config.shop.myshopifyDomain = 'other.myshopify.com',
    s => s.config.publication.id = gid('Publication', 99), s => s.config.publication.catalog.__typename = 'MarketCatalog']) {
    const s = setup(); mutate(s); assert.throws(() => m.parseCommerceConfiguration(s.config, s.identity, true), /FINALIZE_READ_/);
  }
});
test('merchant-managed location permission is derived from current scopes and actual fulfillment-service fields', async () => {
  const s = setup(); s.locations.nodes[0].isFulfillmentService = true; s.locations.nodes[0].fulfillmentService = { id: gid('FulfillmentService', 44) };
  const read = await s.read(); assert.equal(read.context.locations[0].merchantManaged, false); assert.equal(read.context.locations[0].inventoryWriteAllowed, false);
});

for (const [name, mutate] of [
  ['missing nested field', s => delete s.variant.taxable],
  ['string boolean', s => s.variant.taxable = 'true'],
  ['envelope instead of validated data', s => s.hook = q => q === m.COMMERCE_PRODUCT_QUERY ? { data: { product: s.product, productVariant: s.variant } } : undefined],
  ['wrong exact SKU', s => s.variant.sku = 'OTHER-001'],
  ['wrong brand', s => s.product.vendor = 'Mandarina Duck'],
  ['wrong source hash', s => s.product.sourceHash.value = 'a'.repeat(64)],
  ['wrong custom ID', s => s.product.sourceId.value = 'other'],
  ['missing source metafield', s => s.product.metafields.nodes.pop()],
  ['multiple variants', s => s.product.variants.nodes.push({ id: gid('ProductVariant', 42), sku: 'SECOND' })],
  ['shared inventory item', s => s.variant.inventoryItem.variants.nodes.push({ id: gid('ProductVariant', 42) })],
  ['bundle parent', s => s.variant.productParents.nodes.push({ id: gid('Product', 42) })],
  ['subscription', s => s.variant.sellingPlanGroups.nodes.push({ id: gid('SellingPlanGroup', 42) })],
  ['unit-price mixed mode', s => s.variant.unitPrice = { amount: '1.00', currencyCode: 'ILS' }],
  ['video mixed media', s => s.product.media.nodes[0].mediaContentType = 'VIDEO'],
  ['processing media', s => s.product.media.nodes[0].status = 'PROCESSING'],
  ['empty media', s => s.product.media.nodes.length = 0],
  ['duplicate media', s => s.product.media.nodes.push(cp(s.product.media.nodes[0]))],
  ['foreign image URL', s => s.product.media.nodes[0].image.url = 'https://private.invalid/a.jpg'],
  ['URL credentials', s => s.product.media.nodes[0].image.url = 'https://user@cdn.shopify.com/s/files/a.jpg'],
  ['wrong variant media', s => s.variant.media.nodes[0].id = gid('MediaImage', 44)],
  ['wrong variant image URL', s => s.variant.image.url += '&width=300'],
  ['unsafe HTML', s => s.product.descriptionHtml = '<script>alert(1)</script>'],
  ['locked untracked inventory', s => { s.variant.inventoryItem.tracked = false; s.variant.inventoryItem.trackedEditable.locked = true; }],
]) test(`strict reader refuses ${name}`, async () => { const s = setup(); mutate(s); await assert.rejects(s.read(), /(?:FINALIZE_READ_|SYNC_DESCRIPTION_HTML_UNSAFE)/); });

test('every bounded product connection must be exhausted', async () => {
  for (const select of [s => s.product.metafields, s => s.product.variants, s => s.product.publications, s => s.product.marketPublications,
    s => s.product.companyPublications, s => s.product.media, s => s.variant.metafields, s => s.variant.media,
    s => s.variant.productParents, s => s.variant.productVariantComponents, s => s.variant.sellingPlanGroups,
    s => s.variant.inventoryItem.countryHarmonizedSystemCodes, s => s.variant.inventoryItem.variants]) {
    const s = setup(); select(s).pageInfo.hasNextPage = true; await assert.rejects(s.read(), /INCOMPLETE_CONNECTION/);
  }
});
test('complete paginated catalog includes ARCHIVED and DRAFT without active filters', async () => {
  const s = setup(); s.hook = (q, vars) => q !== m.COMMERCE_CATALOG_QUERY ? undefined : vars.after === null
    ? { productVariants: { nodes: cp(s.catalog.nodes), pageInfo: { hasNextPage: true, endCursor: 'second' } } }
    : { productVariants: paged([{ id: gid('ProductVariant', 500), sku: null, product: { id: gid('Product', 501), status: 'ARCHIVED' } }]) };
  assert.equal((await s.read()).context.shopify.length, 2);
});
test('cursor loops, empty next pages, duplicate variants and missing target catalog identity fail closed', async () => {
  for (const mutate of [s => s.catalog.pageInfo = { hasNextPage: true, endCursor: 'same' },
    s => { s.catalog.nodes = []; s.catalog.pageInfo = { hasNextPage: true, endCursor: 'next' }; },
    s => s.catalog.nodes.push(cp(s.catalog.nodes[0])), s => s.catalog.nodes = []]) {
    const s = setup(); mutate(s); await assert.rejects(s.read(), /FINALIZE_READ_/);
  }
});
test('inventory quantity omissions, duplicates, negative stock, bad sum and wrong owners reject', async () => {
  for (const mutate of [l => l.quantities.pop(), l => l.quantities[1].name = 'available', l => l.quantities[0].quantity = -1,
    l => l.quantities[0].quantity = 1, l => l.item.id = gid('InventoryItem', 44), l => l.location.id = gid('Location', 99),
    l => l.id = 'gid://shopify/InventoryLevel/40?inventory_item_id=44']) {
    const s = setup(); mutate(s.levels.inventoryItem.inventoryLevels.nodes[0]); await assert.rejects(s.read(), /FINALIZE_READ_/);
  }
});
test('duplicate location and inventory level identities reject', async () => {
  for (const mutate of [s => s.locations.nodes.push(cp(s.locations.nodes[0])), s => s.levels.inventoryItem.inventoryLevels.nodes.push(cp(s.levels.inventoryItem.inventoryLevels.nodes[0]))]) {
    const s = setup(); mutate(s); await assert.rejects(s.read(), /DUPLICATE_/);
  }
});
test('full source/media/stock/capability reread refuses drift while decoding', async () => {
  for (const mutate of [s => s.product.descriptionHtml = '<p>Changed</p>', s => s.product.media.nodes[0].image.url += '&v=2',
    s => s.variant.inventoryItem.updatedAt = '2026-09-30T12:00:01.000Z', s => s.config.shop.currencyCode = 'USD',
    s => s.locations.nodes[0].fulfillsOnlineOrders = false, s => s.catalog.nodes.push({ id: gid('ProductVariant', 44), sku: s.identity.sku, product: { id: gid('Product', 45), status: 'DRAFT' } }),
    s => { s.levels.inventoryItem.inventoryLevels.nodes[0].quantities[0].quantity = 1; s.levels.inventoryItem.inventoryLevels.nodes[0].quantities[1].quantity = 1; }]) {
    const s = setup(), decode = s.deps.decode; s.deps.decode = async (...args) => { const result = await decode(...args); mutate(s); return result; };
    await assert.rejects(s.read(), /(?:CHANGED_DURING_READ|VARIANT_IMAGE_CHANGED|INVENTORY_CHANGED_DURING_READ)/);
  }
});
test('decode evidence cannot substitute image identity, bytes or dimensions', async () => {
  for (const patch of [{ sha256: 'invalid' }, { byteLength: 0 }, { byteLength: 8388609 }, { width: 1 }, { mediaGid: gid('MediaImage', 99) }, { mime: 'text/html' }]) {
    const s = setup(), decode = s.deps.decode; s.deps.decode = async (...args) => ({ ...await decode(...args), ...patch });
    await assert.rejects(s.read(), /DECODE_/);
  }
});
test('deadline includes configuration, catalog, image decode and final reread; no later request starts', async () => {
  const s = setup(); s.hook = () => { s.now += 8001; return cp(s.config); };
  await assert.rejects(s.read(), /TIME_BUDGET/); assert.equal(s.calls.length, 1);
  const d = setup(), decode = d.deps.decode; d.deps.decode = async (...args) => { const result = await decode(...args); d.now += 8001; return result; };
  await assert.rejects(d.read(), /TIME_BUDGET/); assert.equal(d.calls.filter(call => call.query === m.COMMERCE_PRODUCT_QUERY).length, 1);
});
test('expired and nonfinite deadlines perform no request', async () => {
  for (const deadline of [NaN, Infinity, Date.parse(time)]) { const s = setup(); await assert.rejects(m.readCommerceShopify(s.identity, deadline, s.deps), /TIME_BUDGET/); assert.equal(s.calls.length, 0); }
});
test('read deadline bounds a stalled port; no partial result escapes', async () => {
  const s = setup(); s.deps.query = () => new Promise(() => {});
  await assert.rejects(m.readCommerceShopify(s.identity, Date.parse(time) + 15, s.deps), /TIME_BUDGET/);
});
test('server assembly cannot overwrite observed Shopify identity through extra properties', async () => {
  const s = setup(), read = await s.read(), full = assemble(s, read);
  const merged = m.assembleCommerceRead(read, { galleryCopy: full.snapshot.galleryCopy, galleryCopyVersion: time,
    galleryRowFingerprint: full.snapshot.galleryRowFingerprint, context: full.context,
    identity: { ...s.identity, productGid: gid('Product', 99) } });
  assert.equal(merged.snapshot.identity.productGid, s.identity.productGid);
});
test('exact protected extra product/inventory data fingerprint changes without copying supplier values into merchant intent', async () => {
  const s = setup(), first = await s.read(); s.variant.inventoryItem.unitCost = { amount: '50.00', currencyCode: 'ILS' }; s.product.tags.push('merchant-tag');
  const last = await s.read(); assert.notEqual(last.snapshot.otherInventoryDataFingerprint, first.snapshot.otherInventoryDataFingerprint);
  assert.notEqual(last.snapshot.otherProductDataFingerprint, first.snapshot.otherProductDataFingerprint); assert.equal(last.snapshot.commercial.price, '0.00');
});
test('query contract includes inactive/legacy levels, three publication catalog kinds, actual native quantity names and no writes', () => {
  assert.match(m.COMMERCE_LEVELS_QUERY, /includeInactive: true/); assert.match(m.COMMERCE_LOCATIONS_QUERY, /includeInactive: true, includeLegacy: true/);
  for (const value of ['APP', 'MARKET', 'COMPANY_LOCATION']) assert.match(m.COMMERCE_PRODUCT_QUERY, new RegExp(`catalogType: ${value}`));
  assert.match(m.COMMERCE_PRODUCT_QUERY, /publishedOnPublication\(publicationId:/);
  assert.match(m.COMMERCE_LEVELS_QUERY, /"safety_stock", "quality_control"/);
  assert.ok(!Object.entries(m).filter(([key]) => key.endsWith('_QUERY')).some(([, query]) => /\bmutation\b/.test(query)));
  assert.match(moduleSource, /shopifyAdminGraphql\(query, variables,.*deadline\)/);
});
