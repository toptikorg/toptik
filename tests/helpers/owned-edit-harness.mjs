// Loads the real TypeScript sources of the source-owned color families and builds mutable Shopify and
// Gallery fixtures, so the owned-edit tests exercise the production projection, planning and
// reconciliation code instead of copies of it.
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const strip = path => stripTypeScriptTypes(readFileSync(path, 'utf8'));
// Wrap a server module: drop its imports/exports and resolve every free name from `deps`.
const unwrap = path => strip(path).replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
export async function loadWrapped(path, depNames, returnNames) {
  const { make } = await import(dataUrl(`export function make(deps){const {${depNames.join(',')}}=deps;${unwrap(path)};return {${returnNames.join(',')}};}`));
  return make;
}

export const policy = await import(dataUrl(strip('src/lib/shopify/variant-source-policy.ts')));
export const description = await import(dataUrl(strip('src/lib/shopify/description-document.ts')
  .replace('from "parse5"', `from ${JSON.stringify(pathToFileURL(require.resolve('parse5')).href)}`)));
export const plan = await import(dataUrl(strip('src/lib/shopify/owned-edit-plan.ts')));

export const { visibleCopiesEquivalent } = (await loadWrapped('src/lib/shopify/sync-policy.ts', ['descriptionPairsEquivalent'],
  ['visibleCopiesEquivalent']))({ descriptionPairsEquivalent: description.descriptionPairsEquivalent });
export const visibleCopyFromProduct = product => ({
  title: product.title, description: description.descriptionTextFromHtml(product.descriptionHtml),
  descriptionHtml: product.descriptionHtml, seoTitle: product.seoTitle, seoDescription: product.seoDescription,
});
const publication = 'gid://shopify/Publication/79538258170';
const sourceDeps = state => ({
  ...policy, process: { env: { SHOPIFY_ONLINE_STORE_PUBLICATION_ID: publication } },
  configuredShopifyDomain: () => 'toptikcoil.myshopify.com', visibleCopyFromProduct,
  assertSafeDescriptionHtml: description.assertSafeDescriptionHtml,
  shopifyAdminGraphql: async () => {
    state.reads++;
    if (state.failRead) throw new Error(state.failRead);
    state.onRead?.(state.reads);
    return { product: structuredClone(state.product) };
  },
  verifyOnboardingImage: async image => { state.verified.push(image.id); },
});

const fzt73Names = ['configuredShopifyDomain', 'shopifyAdminGraphql', 'visibleCopyFromProduct', 'assertSafeDescriptionHtml', 'verifyOnboardingImage',
  'FZT73_PRODUCT_GID', 'FZT73_PRODUCT_HANDLE', 'FZT73_VARIANTS', 'exactFzt73Media', 'exactVariantSeo', 'process'];
const md20Names = ['configuredShopifyDomain', 'shopifyAdminGraphql', 'visibleCopyFromProduct', 'assertSafeDescriptionHtml', 'verifyOnboardingImage',
  'MD20_PRODUCT_GID', 'MD20_PRODUCT_HANDLE', 'MD20_VARIANTS', 'MD20_LEGACY_UNASSIGNED_MEDIA', 'exactVariantMedia', 'exactVariantSeo', 'process'];
export const makeFzt73 = await loadWrapped('src/lib/shopify/fzt73-source-worker.ts', fzt73Names,
  ['readFzt73Snapshot', 'sameFzt73Source', 'fzt73SourceProjection', 'reconcileFzt73Variants']);
export const makeMd20 = await loadWrapped('src/lib/shopify/variant-source-worker.ts', md20Names,
  ['readMd20Snapshot', 'sameMd20Source', 'md20SourceProjection', 'reconcileApprovedVariants']);

const serviceNames = ['configuredShopifyDomain', 'visibleCopyFromProduct', 'writeShopifyOwnedMediaAlt', 'writeShopifyVisibleCopy',
  'assertSafeDescriptionHtml', 'descriptionPairsEquivalent', 'descriptionTextFromHtml',
  'fzt73SourceProjection', 'readFzt73Snapshot', 'reconcileFzt73Variants', 'sameFzt73Source',
  'md20SourceProjection', 'readMd20Snapshot', 'reconcileApprovedVariants', 'sameMd20Source',
  'planOwnedEdit', 'requireVariantMediaToken', 'visibleCopiesEquivalent',
  'FZT73_PRODUCT_GID', 'FZT73_VARIANTS', 'MD20_PRODUCT_GID', 'MD20_VARIANTS'];
export const makeService = await loadWrapped('src/lib/shopify/owned-edit-service.ts', serviceNames, ['applyOwnedGalleryEdit', 'ownedFamilyForItem']);

/** Fake Shopify writes that mutate the in-memory product the way productUpdate / fileUpdate do. */
function shopifyWrites(f) {
  const writes = { copy: [], alt: [] };
  return {
    writes,
    writeShopifyVisibleCopy: async (productGid, copy, current, deadline) => {
      if (deadline !== undefined && Date.now() >= deadline) throw new Error('SPEC_TIME_BUDGET');
      if (f.state.failCopyWrite) throw new Error(f.state.failCopyWrite);
      if (productGid !== f.productGid || current.id !== f.productGid) throw new Error('SYNC_SHOPIFY_PRODUCT_IDENTITY_CONFLICT');
      writes.copy.push(structuredClone(copy));
      if (f.state.dropCopyWrite) return;
      f.state.product.title = copy.title;
      f.state.product.descriptionHtml = copy.descriptionHtml;
      f.state.product.seo = { title: copy.seoTitle, description: copy.seoDescription };
      f.state.product.updatedAt = '2026-11-09T11:00:00Z';
      if (f.state.copyResponseLost) throw new Error('SHOPIFY_API_RESPONSE_LOST');
    },
    writeShopifyOwnedMediaAlt: async updates => {
      if (f.state.failAltWrite) throw new Error(f.state.failAltWrite);
      writes.alt.push(structuredClone(updates));
      for (const update of updates) {
        const media = f.state.product.media.nodes.find(node => node.id === update.mediaId);
        if (!media) throw new Error('SHOPIFY_MEDIA_ALT_WRITE_MISSING');
        media.alt = update.alt;
        if (f.state.partialAltWrite) throw new Error('SHOPIFY_MEDIA_ALT_WRITE_REJECTED');
      }
      f.state.product.updatedAt = '2026-11-09T11:00:00Z';
      f.state.afterAlt?.();
      if (f.state.altResponseLost) throw new Error('SHOPIFY_API_RESPONSE_LOST');
    },
  };
}

/** Service bound to a family fixture. `family(key)` must be awaited first. */
export function service(f) {
  const writes = shopifyWrites(f);
  const fzt73 = makeFzt73(f.deps), md20 = makeMd20(f.deps);
  const { applyOwnedGalleryEdit, ownedFamilyForItem } = makeService({
    ...f.deps, ...plan, ...writes, ...description, ...fzt73, ...md20, visibleCopiesEquivalent,
    FZT73_PRODUCT_GID: policy.FZT73_PRODUCT_GID, FZT73_VARIANTS: policy.FZT73_VARIANTS, MD20_PRODUCT_GID: policy.MD20_PRODUCT_GID, MD20_VARIANTS: policy.MD20_VARIANTS,
  });
  return { applyOwnedGalleryEdit, ownedFamilyForItem, writes: writes.writes };
}

const optionFor = v => [{ name: 'צבע', value: v.color }];
function fzt73Product() {
  return {
    id: policy.FZT73_PRODUCT_GID, handle: policy.FZT73_PRODUCT_HANDLE, title: 'פאוץ׳ עור קלאסי', descriptionHtml: '<p>עור איטלקי. כיס פנימי.</p>',
    status: 'ACTIVE', updatedAt: '2026-11-09T10:00:00Z', vendor: 'mandarinaduck', productType: 'bag', publishedOnPublication: true,
    seo: { title: 'פאוץ׳ עור קלאסי מנדרינה דאק', description: 'פאוץ׳ עור קלאסי. מתאים ליום יום. כולל כיס פנימי.' },
    variants: { nodes: policy.FZT73_VARIANTS.map(v => ({ id: 'gid://shopify/ProductVariant/' + v.variantId, sku: v.sku, selectedOptions: optionFor(v) })), pageInfo: { hasNextPage: false } },
    media: { nodes: policy.FZT73_MEDIA.map(m => ({ id: m.id, alt: '', status: 'READY', mediaContentType: 'IMAGE', image: { url: m.url, altText: null, width: 1000, height: 1500 } })), pageInfo: { hasNextPage: false } },
  };
}
function md20Product() {
  const nodes = policy.MD20_VARIANTS.flatMap((v, vi) => [1, 2, 3].map(n => ({
    id: `gid://shopify/MediaImage/${9000 + vi * 10 + n}`, alt: `פאוץ׳ ${v.color} | ${v.sku} | ${n}`, status: 'READY', mediaContentType: 'IMAGE',
    image: { url: `https://cdn.shopify.com/s/files/md20/${v.sku}_${n}.jpg`, altText: null, width: 1000, height: 1200 },
  })));
  return {
    id: policy.MD20_PRODUCT_GID, handle: policy.MD20_PRODUCT_HANDLE, title: 'MD 20 תיק פאוץ׳', descriptionHtml: '<p>תיק פאוץ׳ קטן.</p>',
    status: 'ACTIVE', updatedAt: '2026-11-09T10:00:00Z', vendor: 'mandarinaduck', productType: 'bag', publishedOnPublication: true,
    seo: { title: 'MD 20 תיק פאוץ׳ מנדרינה דאק', description: 'תיק פאוץ׳ קטן. מתאים לכל יום.' },
    variants: { nodes: policy.MD20_VARIANTS.map(v => ({ id: 'gid://shopify/ProductVariant/' + v.variantId, sku: v.sku, selectedOptions: optionFor(v) })), pageInfo: { hasNextPage: false } },
    media: { nodes, pageInfo: { hasNextPage: false } },
  };
}

/** A complete in-memory family: Shopify product, Gallery tables with applied baselines, and fake RPCs. */
export async function family(key) {
  const isFzt = key === 'fzt73';
  const variants = isFzt ? policy.FZT73_VARIANTS : policy.MD20_VARIANTS;
  const state = { product: isFzt ? fzt73Product() : md20Product(), reads: 0, verified: [], failRead: null };
  const deps = sourceDeps(state);
  const mod = isFzt ? makeFzt73(deps) : makeMd20(deps);
  const read = isFzt ? mod.readFzt73Snapshot : mod.readMd20Snapshot;
  const same = isFzt ? mod.sameFzt73Source : mod.sameMd20Source;
  const project = isFzt ? mod.fzt73SourceProjection : mod.md20SourceProjection;
  const reconcile = isFzt ? mod.reconcileFzt73Variants : mod.reconcileApprovedVariants;
  const batchRpc = isFzt ? 'apply_fzt73_owned_batch' : 'apply_md20_owned_batch';
  const productGid = isFzt ? policy.FZT73_PRODUCT_GID : policy.MD20_PRODUCT_GID;

  const tables = { carousel_items: [{ id: 'unrelated', catalog_number: 'OTHER', display_order: 403, editor_revision: 3 }], carousel_item_angles: [], shopify_gallery_bindings: [] };
  const source = await read(Date.now() + 45000);
  variants.forEach((v, n) => {
    const { angles, ...copy } = project(source, v);
    tables.carousel_items.push({ id: v.itemId, catalog_number: v.sku, display_order: n + 1, editor_revision: 1, copy_updated_at: '2026-11-09T10:00:00.000Z', is_active: true, ...copy });
    tables.shopify_gallery_bindings.push({ carousel_item_id: v.itemId, catalog_key: v.sku, product_gid: productGid, variant_gid: 'gid://shopify/ProductVariant/' + v.variantId, is_published: true });
    tables.carousel_item_angles.push(...angles.map((a, i) => ({ ...a, item_id: v.itemId, id: v.sku + '-' + i })));
  });
  state.reads = 0; // building the fixture read the product once
  const calls = [];
  // The SQL keeps a private baseline per color. A synced fixture starts with every baseline recorded.
  state.baselines = Object.fromEntries(variants.map(v => {
    const { angles, ...copy } = project(source, v);
    const { title, description, description_html, seo_title, seo_description, cover_image_path, cover_image_alt } = copy;
    return [v.itemId, { title, description, description_html, seo_title, seo_description, cover_image_path, cover_image_alt,
      angles: angles.map(a => ({ angle_key: a.angle_key, angle_order: a.angle_order, image_path: a.image_path, image_alt: a.image_alt })) }];
  }));
  const db = {
    from(table) {
      const filters = []; let slice;
      const q = {
        select() { return q; }, in(k, values) { filters.push(r => values.includes(r[k])); return q; }, eq(k, value) { filters.push(r => r[k] === value); return q; },
        order() { return q; }, range(a, b) { slice = [a, b + 1]; return q; },
        maybeSingle() { return q.then(result => ({ data: result.data[0] ?? null, error: null })); },
        then(resolve, reject) {
          let data = structuredClone(tables[table] ?? []).filter(r => filters.every(f => f(r)));
          if (slice) data = data.slice(...slice);
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'acquire_shopify_reconciliation_lease') { if (!state.busy) state.leaseOwner = args.p_owner; return { data: !state.busy, error: null }; }
      if (name === 'release_shopify_reconciliation_lease') return { data: true, error: null };
      if (name === 'read_fzt73_unresolved_outbox' || name === 'read_md20_unresolved_outbox') return { data: state.unresolvedOutbox ?? [], error: null };
      if (name !== batchRpc) throw new Error('unexpected RPC ' + name);
      if (state.batchError) return { data: null, error: { message: state.batchError } };
      // Same guards as the SQL: owned lease, copy/editor CAS, and "the card still equals its baseline".
      if (state.busy || args.p_owner !== state.leaseOwner) return { data: null, error: { message: 'SYNC_FZT73_LEASE_REQUIRED' } };
      const results = [];
      const staged = structuredClone({ items: tables.carousel_items, angles: tables.carousel_item_angles });
      for (const entry of args.p_entries) {
        const row = staged.items.find(r => r.id === entry.itemId);
        if (!row || !row.is_active) return { data: null, error: { message: 'SYNC_FZT73_REMOVED_OR_HIDDEN' } };
        if (Date.parse(row.copy_updated_at) !== Date.parse(entry.expectedVersion) || row.editor_revision !== entry.expectedRevision) {
          return { data: null, error: { message: 'SYNC_COPY_CONCURRENT_UPDATE' } };
        }
        const now = { ...row, angles: staged.angles.filter(a => a.item_id === row.id) };
        const asProjection = r => ({ title: r.title, description: r.description, description_html: r.description_html, seo_title: r.seo_title, seo_description: r.seo_description,
          cover_image_path: r.cover_image_path, cover_image_alt: r.cover_image_alt,
          angles: r.angles.sort((a, b) => a.angle_order - b.angle_order).map(a => ({ angle_key: a.angle_key, angle_order: a.angle_order, image_path: a.image_path, image_alt: a.image_alt })) });
        if (state.baselines[entry.itemId] && JSON.stringify(asProjection(now)) !== JSON.stringify(state.baselines[entry.itemId])) {
          return { data: null, error: { message: 'SYNC_FZT73_EDITORIAL_CHANGED' } };
        }
        const { angles, ...copy } = structuredClone(entry.projection);
        const changed = JSON.stringify(asProjection(now)) !== JSON.stringify(entry.projection);
        if (changed) {
          Object.assign(row, copy, { copy_updated_at: new Date(Date.parse(row.copy_updated_at) + 1000).toISOString() });
          staged.angles = staged.angles.filter(a => a.item_id !== row.id).concat(angles.map((a, i) => ({ ...a, item_id: row.id, id: row.id + '-' + i })));
        }
        results.push({ itemId: entry.itemId, projection: entry.projection, status: changed ? 'updated' : 'unchanged' });
      }
      tables.carousel_items = staged.items; tables.carousel_item_angles = staged.angles;
      for (const r of results) state.baselines[r.itemId] = structuredClone(r.projection);
      return { data: { items: results.map(r => ({ itemId: r.itemId, result: { status: r.status } })) }, error: null };
    },
  };
  const cardOf = itemId => {
    const row = tables.carousel_items.find(r => r.id === itemId);
    return {
      title: row.title, description: row.description, description_html: row.description_html, seo_title: row.seo_title, seo_description: row.seo_description,
      cover_image_path: row.cover_image_path, cover_image_alt: row.cover_image_alt,
      angles: tables.carousel_item_angles.filter(a => a.item_id === itemId).sort((a, b) => a.angle_order - b.angle_order)
        .map(a => ({ angle_key: a.angle_key, angle_order: a.angle_order, image_path: a.image_path, image_alt: a.image_alt })),
    };
  };
  const helpers = {
    project: (src, v) => project(src, v), variants,
    titleSuffix: v => isFzt ? ` בצבע ${v.color}` : '', seoSuffix: v => ` בצבע ${v.color}`,
    altGuard: isFzt ? () => {} : plan.requireVariantMediaToken,
    descriptionPairsEquivalent: description.descriptionPairsEquivalent, descriptionTextFromHtml: description.descriptionTextFromHtml,
    assertSafeDescriptionHtml: description.assertSafeDescriptionHtml,
  };
  return { key, isFzt, variants, productGid, state, tables, calls, db, deps, mod, read, same, project, reconcile, cardOf, helpers, batchRpc };
}
