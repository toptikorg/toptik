// Loads the real staged-review record, store, upload and route modules plus the real review guard, so the
// staged Gallery review tests exercise production code against in-memory storage and database fakes.
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { dataUrl, loadWrapped, policy } from './owned-edit-harness.mjs';

const strip = path => stripTypeScriptTypes(readFileSync(path, 'utf8'));
export const nativeRecord = await import(dataUrl(strip('src/lib/shopify/reviewed-media-record.ts')));
const guardSource = readFileSync('src/lib/shopify/reviewed-media-guard.ts', 'utf8').replace(/^import[^\n]*;\r?\n/gm, '');
export const guard = await import(dataUrl(stripTypeScriptTypes('const manifest={items:[],deniedUrls:[],deniedSha256:[]};' + guardSource)));

const stagedNames = ['STAGED_STORAGE_ORIGIN', 'STAGED_UPLOAD_MIMES', 'MAX_STAGED_BYTES', 'MAX_STAGED_NOTE', 'stagedStoragePath', 'stagedPublicUrl',
  'stagedUploadPath', 'stagedRecord', 'signStagedReview', 'verifyStagedReview', 'stagedReviewPrefix', 'stagedReviewPath', 'stagedReviewEntry'];
export const staged = (await loadWrapped('src/lib/shopify/staged-media-review-record.ts', ['createHash', 'createHmac', 'timingSafeEqual', 'reviewIdentity'], stagedNames))(
  { createHash, createHmac, timingSafeEqual, reviewIdentity: nativeRecord.reviewIdentity });

export const KEY = 'k'.repeat(48);
export const itemId = '660aea87-5082-438d-86f0-bd982ac43a68';
export const otherItemId = '11111111-2222-4333-8444-555555555555';
export const actorId = 'f4a10335-5d41-4b70-9e16-93bb74a52eba';
export const identity = {
  productId: 'gid://shopify/Product/15453683548410', variantId: 'gid://shopify/ProductVariant/67936407388410', itemId,
  exactGallerySku: 'KF901003', exactShopifySku: 'KF901003', productHandle: 'backpack-14-1-blue',
};
export const sha = 'a'.repeat(64);
export const uploadUrlFor = (id = itemId, folder = 'angles', name = '5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg') =>
  `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/items/${id}/${folder}/${name}`;
export const uploadUrl = uploadUrlFor();
export function recordInput(overrides = {}) {
  const stagedPath = staged.stagedStoragePath(itemId, sha, 'image/jpeg');
  return {
    version: 1, kind: 'staged_gallery_upload', identity: structuredClone(identity), approvalId: 'published-shopify-v1:15453683548410',
    uploadPath: new URL(uploadUrl).pathname.replace('/storage/v1/object/public/carousel-media/', ''), stagedPath,
    imageUrl: staged.stagedPublicUrl(stagedPath), decodedSha256: sha, mime: 'image/jpeg', width: 1698, height: 2000, byteLength: 260000,
    note: 'נבדק בעיניים: תיק הגב הכחול', actorId, reviewedAt: '2026-11-10T06:00:00.000Z', reviewedExactSkuColor: true, ...overrides,
  };
}
export const record = () => staged.stagedRecord(recordInput());

/** Minimal private-bucket storage fake: list/download/upload/getBucket/createBucket with the real error shapes. */
export function storageFake({ bucket = { public: false }, existing = {} } = {}) {
  const files = new Map(Object.entries(existing)), calls = [];
  const state = { bucket };
  const client = {
    storage: {
      async getBucket(name) { calls.push(['getBucket', name]); return state.bucket ? { data: state.bucket, error: null } : { data: null, error: { statusCode: '404', message: 'Bucket not found' } }; },
      async createBucket(name, options) { calls.push(['createBucket', name, options]); state.bucket = { public: options.public }; return { data: {}, error: null }; },
      from(name) {
        return {
          async list(prefix) {
            calls.push(['list', name, prefix]);
            // listErrorPrefix narrows the failure to one folder, so a test can fail the staged folder alone.
            if (state.listError && (!state.listErrorPrefix || prefix.startsWith(state.listErrorPrefix))) return { data: null, error: state.listError };
            const entries = [...files.keys()].filter(path => path.startsWith(prefix + '/')).map(path => ({ name: path.slice(prefix.length + 1) }));
            return { data: entries, error: null };
          },
          async download(path) {
            calls.push(['download', name, path]);
            if (!files.has(path)) return { data: null, error: { statusCode: '404', message: 'not found' } };
            const text = files.get(path);
            return { data: { size: Buffer.byteLength(text), text: async () => text }, error: null };
          },
          async upload(path, body, options) {
            calls.push(['upload', name, path, options]);
            if (files.has(path)) return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
            files.set(path, body); return { data: { path }, error: null };
          },
        };
      },
    },
  };
  return { client, files, calls, state };
}

export const storeDepNames = ['createSupabaseServiceRoleClient', 'supabaseEnv', 'reviewEntry', 'reviewIdentity', 'reviewPath', 'signMediaReview', 'verifyMediaReview',
  'signStagedReview', 'stagedReviewEntry', 'stagedReviewPath', 'stagedReviewPrefix', 'verifyStagedReview'];
export const makeStore = await loadWrapped('src/lib/shopify/reviewed-media-store.ts', storeDepNames,
  ['loadReviewedMedia', 'loadReviewedMediaForItems', 'saveStagedReview', 'saveReviewedMedia']);
export function store(fake, key = KEY) {
  return makeStore({ createSupabaseServiceRoleClient: () => fake.client, supabaseEnv: { serviceRoleKey: key }, ...nativeRecord, ...staged });
}
export { loadWrapped, dataUrl, randomUUID, policy };
