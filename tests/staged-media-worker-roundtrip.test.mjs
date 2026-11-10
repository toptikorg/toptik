// Offline integration, not a production canary: production guards, decoder, planner, workers,
// immutable copier, Shopify request builder/transport and recovery; only I/O providers are fakes.
// The journal below models RPC storage/one-shot results. It does NOT replace the SQL integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { loadWrapped, staged, guard, storageFake, store, KEY, actorId } from './helpers/staged-media-harness.mjs';
import { core, ready, gallery, fixture, id, owner, opId, mod, src } from './helpers/media-planning-fixture.mjs';

Error.stackTraceLimit = 0;
const env = { VERCEL_ENV: 'production', SHOPIFY_MEDIA_SYNC: 'enabled_v1', SHOPIFY_SHOP_DOMAIN: 'toptikcoil.myshopify.com',
  SHOPIFY_API_VERSION: '2026-07', SHOPIFY_ONLINE_STORE_PUBLICATION_ID: 'gid://shopify/Publication/79538258170' };
const failIO = () => { throw Error('UNINJECTED_IO'); };
const limits = await import(mod(src('existing-media-limits')));
const raw = (await loadWrapped('src/lib/shopify/media-transport-read.ts', ['createHash', 'mediaSnapshotFingerprint', 'MAX_EXISTING_MEDIA_PIXELS'],
  ['parseMediaTransportResponse', 'parseTransportMedia', 'assertMediaTransportIdentity', 'assertMediaTransportRead', 'onlyForwardProductTimestampDrift', 'PRODUCT_TIMESTAMP_TOLERANT_PHASES']))({ createHash, ...core, ...limits });
const requests = (await loadWrapped('src/lib/shopify/media-transport-requests.ts', ['createHash', 'assertMediaTransportIdentity', 'assertMediaTransportRead', 'parseTransportMedia', 'MAX_EXISTING_MEDIA_PIXELS'],
  ['stagedMediaUrl', 'ownedMediaFilename', 'buildOwnedMediaCreate', 'buildOwnedMediaAssociate', 'buildMediaVariantReassign', 'buildMediaReferenceDetach',
    'buildMediaReorder', 'buildOwnedMediaRecoveryRead', 'buildOwnedMediaNodeRead', 'parseOwnedMediaRecovery', 'parseMediaTransportAcknowledgement']))({ createHash, ...raw, ...limits });
const intent = (await loadWrapped('src/lib/shopify/media-transport-journal-intent.ts', ['createHash', 'assertMediaTransportRead'],
  ['buildMediaJournalIntent', 'mediaJournalPhase']))({ createHash, ...raw });
const diagnostics = await import(mod(src('media-storage-diagnostics')));
const makeSource = await loadWrapped('src/lib/shopify/media-source-bytes.ts',
  ['createHash', 'lookup', 'sharp', 'isPrivateAddress', 'mediaSnapshotFingerprint', 'MAX_EXISTING_MEDIA_PIXELS', 'fetch'],
  ['assertMediaSourceBytesProof', 'captureMediaSourceBytes', 'readVerifiedMediaSourceBytes']);
const makeStorage = await loadWrapped('src/lib/shopify/media-storage-transport.ts',
  ['createHash', 'lookup', 'sharp', 'isPrivateAddress', 'hasSupabaseAdminEnv', 'supabaseEnv', 'stagedMediaUrl', 'MediaStorageFailure', 'MAX_EXISTING_MEDIA_PIXELS', 'process', 'fetch'],
  ['assertImmutableMediaUploadPreflight', 'assertImmutableMediaUploadReady', 'uploadImmutableMedia', 'readImmutableMedia']);
const makeCapture = await loadWrapped('src/lib/shopify/media-planning-observation.ts',
  ['createHash', 'mediaReadToSnapshot', 'galleryRawToSnapshot', 'createGalleryMediaTransport', 'captureMediaSourceBytes', 'readReadyShopifyMedia',
    'assertNotDeniedMedia', 'requireReviewedMedia', 'isReviewedMediaProof', 'reviewedMediaRegistry', 'loadReviewedMedia'], ['captureMediaPlanningPair']);
const makeReview = await loadWrapped('src/lib/shopify/reviewed-media-policy.ts',
  ['assertReviewedCatalogMedia', 'assertReviewedManufacturerImport', 'assertReviewedMediaOperation', 'changedCatalogMedia', 'requireReviewedMedia',
    'reviewedMediaRegistry', 'loadReviewedMedia', 'loadReviewedMediaForItems', 'captureMediaSourceBytes'], ['assertReviewedCatalogSave', 'assertReviewedPersistedMedia']);
const makeStage = await loadWrapped('src/lib/shopify/staged-media-upload.ts',
  ['captureMediaSourceBytes', 'assertNotDeniedMedia', 'saveStagedReview', 'STAGED_UPLOAD_MIMES', 'stagedPublicUrl', 'stagedRecord', 'stagedStoragePath', 'stagedUploadPath'], ['stageReviewedGalleryUpload']);
const makeStorageWorker = await loadWrapped('src/lib/shopify/media-storage-worker.ts',
  ['createHash', 'randomUUID', 'mediaSnapshotFingerprint', 'assertMediaTransportRead', 'stagedMediaUrl', 'discoverMediaTransportOperation', 'createMediaTransportRpc',
    'uploadImmutableMedia', 'readImmutableMedia', 'assertImmutableMediaUploadPreflight', 'assertImmutableMediaUploadReady', 'mediaStorageDiagnostic', 'assertMediaSourceBytesProof', 'readVerifiedMediaSourceBytes'],
  ['runPersistedStorageMediaPhase']);
const makeRuntimeJob = await loadWrapped('src/lib/shopify/media-runtime-job.ts',
  ['mediaSnapshotFingerprint', 'assertMediaTransportRead', 'parseTransportMedia', 'buildOwnedMediaCreate', 'buildOwnedMediaAssociate', 'buildMediaVariantReassign',
    'buildMediaReferenceDetach', 'buildMediaReorder', 'ownedMediaFilename', 'stagedMediaUrl', 'buildMediaJournalIntent', 'discoverMediaTransportOperation', 'readOwnedShopifyMediaNode'],
  ['assembleMediaRuntimeJob']);
const runtimeJob = makeRuntimeJob({ ...core, ...raw, ...requests, ...intent, discoverMediaTransportOperation: failIO, readOwnedShopifyMediaNode: failIO });
const makeShopify = await loadWrapped('src/lib/shopify/media-shopify-transport.ts',
  ['shopifyAdminGraphql', 'verifyOnboardingImage', 'buildMediaReadRequest', 'parseMediaReadResponse', 'MEDIA_API_VERSION', 'MEDIA_PUBLICATION_ID',
    'assertMediaTransportRead', 'parseMediaTransportResponse', 'parseTransportMedia', 'onlyForwardProductTimestampDrift', 'PRODUCT_TIMESTAMP_TOLERANT_PHASES',
    'buildOwnedMediaCreate', 'buildOwnedMediaAssociate', 'buildMediaVariantReassign', 'buildMediaReferenceDetach', 'buildMediaReorder', 'buildOwnedMediaRecoveryRead',
    'buildOwnedMediaNodeRead', 'ownedMediaFilename', 'parseOwnedMediaRecovery', 'parseMediaTransportAcknowledgement', 'process'],
  ['readShopifyMediaTransport', 'readReadyShopifyMedia', 'executeShopifyMediaTransport', 'readDecodedOwnedShopifyMedia']);
const worker = (await loadWrapped('src/lib/shopify/media-transport-worker.ts',
  ['randomUUID', 'parseMediaTransportAcknowledgement', 'assertMediaTransportRead', 'onlyForwardProductTimestampDrift', 'PRODUCT_TIMESTAMP_TOLERANT_PHASES', 'buildMediaJournalIntent', 'mediaJournalPhase'],
  ['runMediaTransportPhase']))({ randomUUID, ...requests, ...raw, ...intent });
const recovery = (await loadWrapped('src/lib/shopify/media-transport-recovery.ts',
  ['randomUUID', 'ownedMediaFilename', 'buildOwnedMediaCreate', 'buildOwnedMediaAssociate', 'buildMediaVariantReassign', 'buildMediaReferenceDetach', 'buildMediaReorder',
    'buildMediaJournalIntent', 'mediaJournalPhase', 'assertMediaTransportRead', 'parseTransportMedia'], ['recoverShopifyMediaPhase']))({ randomUUID, ...requests, ...raw, ...intent });

async function picture(seed) {
  const bytes = Buffer.alloc(40 * 60 * 3); let n = seed;
  for (let i = 0; i < bytes.length; i++) { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; bytes[i] = n >>> 24; }
  return sharp(bytes, { raw: { width: 40, height: 60, channels: 3 } }).png().toBuffer();
}

async function setup() {
  const deadline = () => Date.now() + 60000, v = fixture(), calls = [], blobs = new Map(), files = new Map();
  const previousBytes = await picture(17), uploadBytes = await picture(89), previousUrl = v.product.media.nodes[0].image.url;
  const uploadUrl = staged.stagedPublicUrl(`items/${id.itemId}/angles/${randomUUID()}.png`);
  blobs.set(previousUrl, previousBytes); blobs.set(uploadUrl, uploadBytes);
  // Every request is resolved from memory. Unexpected destinations fail closed, never fall through to fetch.
  const fetch = async (address, options = {}) => {
    calls.push({ type: 'storage-http', address, method: options.method ?? 'GET', options });
    if (options.method === 'POST') {
      assert.match(address, new RegExp(`/storage/v1/object/carousel-media/sync-media/${id.itemId}/[a-f0-9]{64}\\.png$`));
      assert.equal(options.headers['x-upsert'], 'false');
      const publicUrl = address.replace('/storage/v1/object/carousel-media/', '/storage/v1/object/public/carousel-media/');
      assert.equal(blobs.has(publicUrl), false, 'immutable copier never overwrites');
      blobs.set(publicUrl, Buffer.from(options.body)); return new Response('', { status: 200 });
    }
    assert.equal(options.method ?? 'GET', 'GET');
    const bytes = blobs.get(address);
    return bytes ? new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } }) : new Response('', { status: 404 });
  };
  const safeProviders = { createHash, sharp, ...limits, lookup: async () => [{ address: '93.184.216.34', family: 4 }], isPrivateAddress: () => false, fetch };
  const source = makeSource({ ...safeProviders, ...core });
  const storage = makeStorage({ ...safeProviders, ...requests, ...diagnostics, process: { env }, hasSupabaseAdminEnv: () => true,
    supabaseEnv: { publicUrl: staged.STAGED_STORAGE_ORIGIN, serviceRoleKey: 'sb_secret_offline_fixture_only' } });
  const privateStore = storageFake(), reviewStore = store(privateStore, KEY);
  const stageApi = makeStage({ ...source, ...guard, ...reviewStore, ...staged });
  const db = { storage: { from: bucket => ({ upload: async (path, bytes, options) => {
    assert.equal(bucket, 'carousel-media'); assert.equal(options.upsert, false);
    const url = staged.stagedPublicUrl(path); if (blobs.has(url)) return { error: { statusCode: '409' } };
    calls.push({ type: 'stage-approved', path }); blobs.set(url, Buffer.from(bytes)); return { data: { path }, error: null };
  } }) } };
  const stagedResult = await stageApi.stageReviewedGalleryUpload(db, { identity: id, approvalId: 'offline-approved-single', uploadUrl,
    note: 'Offline exact SKU/color review fixture', actorId }, deadline());
  const receipt = [...privateStore.files.values()].map(t => JSON.parse(t)).find(r => r.record?.kind === 'staged_gallery_upload').record;
  const entry = staged.stagedReviewEntry(receipt);
  assert.deepEqual(await reviewStore.loadReviewedMedia(id, deadline()), [entry]);
  const before = await source.captureMediaSourceBytes(id, previousUrl, deadline());
  for (const side of ['gallery', 'shopify']) v.context.baselines[side].assets[0].contentId = before.sha256;
  for (const p of v.context.provenance) { p.content_id = before.sha256; Object.assign(p.proof, { decodedSha256: before.sha256, mime: before.mime, width: before.width, height: before.height, byteLength: before.byteLength }); }
  v.product.updatedAt = new Date().toISOString(); v.product.media.nodes[0].updatedAt = v.product.updatedAt;
  v.read = ready.parseMediaReadResponse({ data: { product: v.product } }, id);
  v.context.baselines.shopify.revision = v.read.fingerprint;
  const old = { id: id.itemId, catalogNumber: id.exactGallerySku, coverImagePath: previousUrl,
    shopifyLink: { variantId: id.variantId.split('/').at(-1), handle: id.productHandle },
    angles: [{ id: v.raw.angles[0].id, imagePath: previousUrl }], colors: [] };
  const newAngle = { ...v.raw.angles[0], id: randomUUID(), angle_key: 'back', image_path: stagedResult.stagedUrl, image_alt: 'Exact reviewed new angle', angle_order: 1 };
  const candidate = { items: [{ ...structuredClone(old), angles: [{ id: newAngle.id, imagePath: newAngle.image_path }, ...old.angles] }] };
  const reviews = makeReview({ ...guard, ...reviewStore, ...source });
  await reviews.assertReviewedCatalogSave(candidate, { items: [old] }, deadline());
  // The actual existing catalog CAS is an I/O boundary here. Its stored row/revision are then
  // consumed by real planning/observation. SQL CAS behavior has its own isolated database suite.
  v.raw.angles[0].angle_order = 2; v.raw.angles.unshift(newAngle); v.raw.revision = createHash('sha256').update('fixture-after-catalog-cas').digest('hex');
  v.context.galleryRaw = v.raw;
  let created = null, createCalls = 0, loseCreate = false, hideCreated = false;
  const shopify = makeShopify({ ...raw, ...ready, ...requests, process: { env },
    shopifyAdminGraphql: async (query, variables) => {
      calls.push({ type: 'graphql', query, variables });
      if (query.startsWith('query TopTikMediaRead')) return { product: structuredClone(v.product) };
      if (query.startsWith('query TopTikRecover')) return { files: { nodes: !created || hideCreated ? [] : [structuredClone(created)], pageInfo: { hasNextPage: false } } };
      if (query.startsWith('query TopTikReadOwned')) return { node: structuredClone(created) };
      if (query.includes('fileCreate(')) {
        createCalls++; const file = variables.files[0];
        assert.notEqual(file.originalSource, stagedResult.stagedUrl, 'Shopify consumes verified sync-media, not the staging URL');
        assert.ok(blobs.has(file.originalSource)); assert.equal(file.duplicateResolutionMode, 'RAISE_ERROR');
        created = { ...structuredClone(v.product.media.nodes[0]), id: 'gid://shopify/MediaImage/999', alt: file.alt,
          image: { id: 'gid://shopify/ImageSource/999', url: `https://cdn.shopify.com/s/files/1/${file.filename}?v=1`, width: 40, height: 60 } };
        blobs.set(created.image.url, Buffer.from(blobs.get(file.originalSource))); files.set(created.id, created);
        if (loseCreate) throw Error('offline lost provider reply');
        return { fileCreate: { files: [structuredClone(created)], userErrors: [] } };
      }
      if (query.includes('fileUpdate(')) {
        const file = variables.files[0]; assert.deepEqual(file.referencesToAdd, [id.productId]);
        v.product.media.nodes.push(structuredClone(files.get(file.id))); v.product.mediaCount.count++;
        return { fileUpdate: { files: [structuredClone(files.get(file.id))], userErrors: [] } };
      }
      if (query.includes('productReorderMedia(')) {
        for (const move of variables.moves) { const index = v.product.media.nodes.findIndex(m => m.id === move.id);
          const [m] = v.product.media.nodes.splice(index, 1); v.product.media.nodes.splice(Number(move.newPosition), 0, m); }
        return { productReorderMedia: { job: { id: 'gid://shopify/Job/offline-1' }, mediaUserErrors: [] } };
      }
      throw Error('UNEXPECTED_GRAPHQL');
    },
    verifyOnboardingImage: async image => { const decoded = await source.captureMediaSourceBytes(id, image.image.url, deadline());
      return { mediaGid: image.id, url: image.image.url, ...decoded }; },
  });
  const captureApi = makeCapture({ createHash, ...ready, ...gallery, ...source, ...guard, ...reviewStore, ...shopify });
  const capture = c => captureApi.captureMediaPlanningPair(c, owner, deadline(), { gallery: () => ({ read: async () => structuredClone(v.raw) }) });
  const observed = await capture(v.context);
  const plan = core.reconcileMedia(v.context.baselines, observed.pair, [], [], observed.visuals);
  assert.deepEqual(plan.conflicts, []); assert.equal(plan.patches.length, 1); assert.equal(plan.patches[0].kind, 'attach');
  const key = plan.patches[0].key;
  v.context.provenance.push(...observed.proofs.filter(p => !v.context.provenance.some(old => old.evidence_id === p.evidenceId)).map(p =>
    ({ product_gid: id.productId, evidence_id: p.evidenceId, asset_key: p.key, side: p.side, content_id: p.contentId, proof: p.proof })));
  const expected = structuredClone(observed.pair); expected.shopify.assets = structuredClone(plan.projected.shopify);
  const readGuard = async () => ({ sourceFingerprint: core.mediaSnapshotFingerprint(observed.pair.gallery),
    target: await shopify.readShopifyMediaTransport(id, deadline()), observedAt: new Date().toISOString() });
  const discovery = { enabled: true, identity: id, operation: { id: opId, product_gid: id.productId, status: 'running', observed_pair: observed.pair },
    step: { operation_id: opId, step_index: 0, status: 'started', body: plan.patches[0], expected_pair: expected },
    transport: { chain: { operation_id: opId, step_index: 0, status: 'running', phases: ['stage_source', 'create_owned', 'associate', 'reorder'], next_phase: 0,
      current_guard: await readGuard() }, attempts: [], artifacts: [] }, provenance: v.context.provenance };
  const ref = phaseIndex => ({ operationId: opId, step: 0, phaseIndex });
  const journal = discovery.transport;
  const rpc = { acquire: async () => ({ owner, expiresAt: Date.now() + 120000 }), release: async () => {},
    read: async () => structuredClone(journal),
    begin: async (r, _owner, attemptId, request, fresh) => {
      const existing = journal.attempts.find(a => a.phase_index === r.phaseIndex);
      if (existing) return { mayExecute: false, status: existing.status };
      assert.equal(r.phaseIndex, journal.chain.next_phase); assert.equal(fresh.sourceFingerprint, journal.chain.current_guard.sourceFingerprint);
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex'), phase = journal.chain.phases[r.phaseIndex];
      journal.attempts.push({ operation_id: opId, step_index: 0, phase_index: r.phaseIndex, attempt_id: attemptId, phase, status: 'started', request, request_hash: requestHash, before_guard: structuredClone(fresh) });
      return { mayExecute: true, replayed: false, phase, attemptId, requestHash, request };
    },
    uncertain: async (r, _owner, ack) => { const a = journal.attempts.find(a => a.phase_index === r.phaseIndex); a.status = 'uncertain'; a.ack = ack; },
    conflict: async () => { throw Error('UNEXPECTED_JOURNAL_CONFLICT'); },
    accept: async (r, _owner, _requestId, requestHash, fresh, artifact) => {
      const a = journal.attempts.find(a => a.phase_index === r.phaseIndex); assert.equal(a.request_hash, requestHash);
      // Acceptance is a fake SQL port. These assertions prove the real worker's output carries
      // the original review lineage into its artifact, not a fabricated native approval.
      if (artifact) { assert.equal(artifact.contentId, stagedResult.sha256); assert.equal(artifact.ready, true); }
      a.status = 'verified'; a.after_guard = structuredClone(fresh);
      if (artifact) journal.artifacts.push({ operation_id: opId, step_index: 0, phase_index: r.phaseIndex, artifact: structuredClone(artifact) });
      journal.chain.next_phase++; journal.chain.current_guard = structuredClone(fresh);
      if (journal.chain.next_phase === journal.chain.phases.length) journal.chain.status = 'verified';
      return { mayExecute: false, status: 'verified' };
    },
  };
  const storageWorker = makeStorageWorker({ createHash, randomUUID, ...core, ...raw, ...requests, ...storage, ...source, ...diagnostics,
    discoverMediaTransportOperation: async () => structuredClone(discovery), createMediaTransportRpc: () => rpc });
  async function runStage() { await reviews.assertReviewedPersistedMedia(discovery, deadline());
    return storageWorker.runPersistedStorageMediaPhase(ref(0), deadline(), readGuard, { environment: env }); }
  async function assemble(index) { await reviews.assertReviewedPersistedMedia(discovery, deadline());
    return runtimeJob.assembleMediaRuntimeJob(ref(index), discovery, { environment: env, now: Date.now(),
      scopes: { shopDomain: env.SHOPIFY_SHOP_DOMAIN, apiVersion: env.SHOPIFY_API_VERSION, publicationId: env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID,
        scopes: ['write_files', 'write_products'], observedAt: new Date().toISOString() },
      ...(created ? { ownedMedia: { media: raw.parseTransportMedia(created), observedAt: new Date().toISOString() } } : {}) }); }
  async function runNative(index) {
    const loaded = await assemble(index); assert.equal(loaded.status, 'ready');
    const deps = { now: Date.now, load: async () => loaded.job, acquire: async () => rpc.acquire(), release: async () => {}, observe: readGuard,
      begin: rpc.begin, uncertain: rpc.uncertain, conflict: rpc.conflict, refresh: async () => { throw Error('UNEXPECTED_REFRESH'); },
      execute: (request, until) => shopify.executeShopifyMediaTransport(request, loaded.evidence, until),
      recover: (r, leaseOwner, job, until) => recovery.recoverShopifyMediaPhase(r, leaseOwner, job, loaded.evidence, loaded.expectedContentId, until,
        { now: Date.now, readJournal: rpc.read, observe: readGuard, readDecodedOwned: shopify.readDecodedOwnedShopifyMedia, accept: rpc.accept }) };
    return worker.runMediaTransportPhase(ref(index), deadline(), deps);
  }
  return { v, plan, observed, expected, calls, blobs, source, privateStore, reviewStore, reviews, receipt, entry, stagedResult, uploadUrl, key, journal,
    discovery, deadline, runStage, runNative, assemble, capture, get createCalls() { return createCalls; },
    set loseCreate(value) { loseCreate = value; }, set hideCreated(value) { hideCreated = value; }, get created() { return created; } };
}

test('reviewed sync-staged Gallery source crosses real planner/copy/create/associate/reorder with decoded readback and no duplicate', async () => {
  const x = await setup();
  assert.match(x.stagedResult.stagedPath, /^sync-staged\//);
  assert.deepEqual(await x.runStage(), { status: 'verified', executed: true });
  const stageArtifact = x.journal.artifacts[0].artifact;
  assert.match(stageArtifact.storagePath, /^sync-media\//); assert.notEqual(stageArtifact.url, x.stagedResult.stagedUrl);
  assert.deepEqual(x.blobs.get(stageArtifact.url), x.blobs.get(x.stagedResult.stagedUrl));
  const job = await x.assemble(1);
  assert.equal(job.job.sourceEvidenceId, x.expected.shopify.assets.find(a => a.key === x.key).evidenceId);
  assert.equal(job.evidence.source.receiptId, job.job.sourceEvidenceId);
  assert.equal(job.job.request.variables.files[0].originalSource, stageArtifact.url);
  assert.deepEqual(await x.runNative(1), { status: 'verified', executed: true });
  assert.equal(x.v.product.media.nodes.length, 1, 'fileCreate alone has not associated the new image');
  const createdArtifact = x.journal.artifacts.find(a => a.phase_index === 1).artifact;
  assert.equal(createdArtifact.contentId, x.stagedResult.sha256);
  assert.equal(createdArtifact.mediaGid, x.created.id);
  assert.deepEqual(await x.runNative(2), { status: 'verified', executed: true });
  assert.deepEqual(await x.runNative(3), { status: 'verified', executed: true });
  const parent = x.discovery.provenance.find(p => p.asset_key === x.key && p.side === 'gallery');
  x.v.context.provenance.push({ product_gid: id.productId, side: 'shopify', asset_key: x.key, evidence_id: 's-offline-created', content_id: parent.content_id,
    proof: { platformRef: x.created.id, url: createdArtifact.url, decodedSha256: createdArtifact.decodedSha256, mime: createdArtifact.mime,
      width: createdArtifact.width, height: createdArtifact.height, byteLength: createdArtifact.byteLength, ownership: 'owned_clone',
      operationId: opId, sourceEvidenceId: parent.evidence_id, verifiedAt: new Date().toISOString() } });
  const readback = await x.capture(x.v.context);
  core.verifyMediaReadback(x.plan, readback.pair);
  assert.equal(x.createCalls, 1); assert.equal(x.v.product.media.nodes.length, 2);
  assert.equal(x.v.product.media.nodes[0].id, x.created.id);
  x.v.context.baselines = readback.pair; x.v.context.galleryRefs = readback.refs;
  x.v.context.provenance = readback.proofs.map(p => ({ product_gid: id.productId, side: p.side, asset_key: p.key, evidence_id: p.evidenceId, content_id: p.contentId, proof: p.proof }));
  const unchanged = await x.capture(x.v.context), secondPlan = core.reconcileMedia(readback.pair, unchanged.pair, [], [], unchanged.visuals);
  assert.deepEqual(secondPlan.conflicts, []); assert.deepEqual(secondPlan.patches, []); assert.deepEqual(secondPlan.orders, []);
  assert.equal(x.createCalls, 1, 'a subsequent observation cannot duplicate the image');
});

test('lost fileCreate reply stays pending until independent native decode, then resumes with no second create', async () => {
  const x = await setup(); await x.runStage(); x.loseCreate = true; x.hideCreated = true;
  assert.deepEqual(await x.runNative(1), { status: 'pending', executed: true });
  assert.equal(x.createCalls, 1); assert.equal(x.journal.artifacts.length, 1, 'no native success from lost acknowledgement');
  assert.deepEqual(await x.runNative(1), { status: 'pending', executed: false });
  assert.equal(x.createCalls, 1);
  x.hideCreated = false;
  assert.deepEqual(await x.runNative(1), { status: 'verified', executed: false });
  assert.equal(x.createCalls, 1); assert.equal(x.journal.artifacts.length, 2);
});

test('signed review remains exact-identity and exact-byte bound across planning and storage, before any Shopify call', async () => {
  const x = await setup();
  const foreign = structuredClone(x.discovery); foreign.identity.variantId = 'gid://shopify/ProductVariant/789';
  await assert.rejects(x.reviews.assertReviewedPersistedMedia(foreign, x.deadline()), /MEDIA_REVIEW_REQUIRED/);
  const signedPath = [...x.privateStore.files.keys()].find(k => k.startsWith('staged-v1/'));
  const signed = JSON.parse(x.privateStore.files.get(signedPath)); signed.record.identity.variantId = 'gid://shopify/ProductVariant/789';
  x.privateStore.files.set(signedPath, JSON.stringify(signed));
  await assert.rejects(x.runStage(), /STAGED_MEDIA_RECORD_INVALID/);
  assert.equal(x.journal.attempts.length, 0); assert.equal(x.createCalls, 0);
  x.privateStore.files.set(signedPath, JSON.stringify(staged.signStagedReview(x.receipt, KEY)));
  x.blobs.set(x.stagedResult.stagedUrl, await picture(90));
  await assert.rejects(x.runStage(), /MEDIA_SOURCE_BYTES_CHANGED/);
  assert.equal(x.journal.attempts.length, 0); assert.equal(x.createCalls, 0);
  assert.equal(x.calls.some(c => c.type === 'storage-http' && c.method === 'POST'), false);
});
