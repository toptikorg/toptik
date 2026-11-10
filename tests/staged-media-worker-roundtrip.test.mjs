// Offline integration, not a production canary: production guards, decoder, planner, workers,
// immutable copier, Shopify request builder/transport and recovery; only I/O providers are fakes.
// The main roundtrip uses actual SQL register, journal, final readback and commit. Other tests
// use an in-memory journal for provider timeout cases; none is a production canary or browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { loadWrapped, staged, guard, storageFake, store, KEY, actorId } from './helpers/staged-media-harness.mjs';
import { core, ready, gallery, fixture, id, owner, opId, mod, src } from './helpers/media-planning-fixture.mjs';
import { createVerifiedImportDatabase, seedVerifiedImportOperation } from './helpers/verified-native-import-sql-fixture.mjs';

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
const makeImports = await loadWrapped('src/lib/shopify/media-import-lineage.ts', ['createHash', 'assertMediaTransportRead', 'assertNotDeniedMedia'],
  ['verifiedNativeImportProofs']);
const imports = makeImports({ createHash, ...raw, ...guard });
const makeStorage = await loadWrapped('src/lib/shopify/media-storage-transport.ts',
  ['createHash', 'lookup', 'sharp', 'isPrivateAddress', 'hasSupabaseAdminEnv', 'supabaseEnv', 'stagedMediaUrl', 'MediaStorageFailure', 'MAX_EXISTING_MEDIA_PIXELS', 'process', 'fetch'],
  ['assertImmutableMediaUploadPreflight', 'assertImmutableMediaUploadReady', 'uploadImmutableMedia', 'readImmutableMedia']);
const makeCapture = await loadWrapped('src/lib/shopify/media-planning-observation.ts',
  ['createHash', 'mediaReadToSnapshot', 'galleryRawToSnapshot', 'createGalleryMediaTransport', 'captureMediaSourceBytes', 'readReadyShopifyMedia',
    'assertNotDeniedMedia', 'requireReviewedMedia', 'isReviewedMediaProof', 'reviewedMediaRegistry', 'loadReviewedMedia', 'verifiedNativeImportProofs'], ['captureMediaPlanningPair']);
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

async function setup(sqlJournal = false) {
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
  for (const p of v.context.provenance) { p.content_id = before.sha256; Object.assign(p.proof, { decodedSha256: before.sha256, mime: before.mime, width: before.width, height: before.height, byteLength: before.byteLength, verifiedAt: new Date().toISOString() }); }
  v.product.updatedAt = new Date().toISOString(); v.product.media.nodes[0].updatedAt = v.product.updatedAt;
  v.read = ready.parseMediaReadResponse({ data: { product: v.product } }, id);
  v.context.baselines.shopify.revision = v.read.fingerprint;
  const old = { id: id.itemId, catalogNumber: id.exactGallerySku, coverImagePath: previousUrl,
    shopifyLink: { variantId: id.variantId.split('/').at(-1), handle: id.productHandle },
    angles: [{ id: v.raw.angles[0].id, imagePath: previousUrl }], colors: [] };
  const newAngle = { ...v.raw.angles[0], id: randomUUID(), angle_key: 'back', image_path: stagedResult.stagedUrl, image_alt: 'Exact reviewed new angle', angle_order: 2 };
  const candidate = { items: [{ ...structuredClone(old), angles: [...old.angles, { id: newAngle.id, imagePath: newAngle.image_path }] }] };
  const reviews = makeReview({ ...guard, ...reviewStore, ...source });
  await reviews.assertReviewedCatalogSave(candidate, { items: [old] }, deadline());
  // The actual existing catalog CAS is an I/O boundary here. Its stored row/revision are then
  // consumed by real planning/observation. SQL CAS behavior has its own isolated database suite.
  v.raw.angles.push(newAngle); v.raw.revision = createHash('sha256').update('fixture-after-catalog-cas').digest('hex');
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
        // A real codec creates different bytes, like Shopify's observed recompression. The artifact
        // must retain source semantic contentId and independently decoded native hash/MIME/size.
        blobs.set(created.image.url, await sharp(blobs.get(file.originalSource)).jpeg({ quality: 86 }).toBuffer()); files.set(created.id, created);
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
  const captureApi = makeCapture({ createHash, ...ready, ...gallery, ...source, ...guard, ...reviewStore, ...shopify, ...imports });
  const capture = (c, verifiedTransport) => captureApi.captureMediaPlanningPair(c, owner, deadline(), {
    gallery: () => ({ read: async () => structuredClone(v.raw) }), ...(verifiedTransport ? { verifiedTransport } : {}) });
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
  let sql = null;
  if (sqlJournal) {
    sql = await createVerifiedImportDatabase();
    await sql.db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)',
      [id.productId, 'ABC01', id.itemId, id.variantId, id.exactGallerySku, id.exactShopifySku, id.productHandle]);
    await sql.db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '5 minutes')", [id.productId, owner]);
    const approval = randomUUID();
    const initialProofs = v.context.provenance.filter(p => p.asset_key === 'existing').map(p => ({
      key: p.asset_key, side: p.side, evidenceId: p.evidence_id, contentId: p.content_id, proof: p.proof }));
    await sql.rpc('bootstrap_toptik_media', [id.productId, owner, approval, v.context.baselines, initialProofs, { evidenceId: 'offline-visual-baseline' }]);
    await sql.rpc('set_toptik_media_enabled', [id.productId, owner, randomUUID(), true, approval]);
    await sql.rpc('register_toptik_media_provenance', [id.productId, owner, observed.proofs]);
    await sql.rpc('reserve_toptik_media_operation', [id.productId, owner, opId, 1, observed.pair, plan]);
    await sql.rpc('begin_toptik_media_step', [id.productId, owner, opId, 0, randomUUID(), observed.pair]);
    await sql.rpc('prepare_toptik_media_transport', [id.productId, owner, opId, 0, randomUUID(), journal.chain.phases, journal.chain.current_guard]);
  }
  const reloadSqlJournal = async () => {
    const d = await sql.rpc('read_toptik_media_operation', [opId, 0, 0]);
    Object.assign(journal, d.transport); Object.assign(discovery, d, { transport: journal });
  };
  const rpc = { acquire: async () => ({ owner, expiresAt: Date.now() + 120000 }), release: async () => {},
    read: async () => { if (sql) await reloadSqlJournal(); return structuredClone(journal); },
    begin: async (r, _owner, attemptId, request, fresh) => {
      if (sql) { const result = await sql.rpc('begin_toptik_media_transport', [id.productId, owner, opId, r.step, r.phaseIndex, attemptId, request, fresh]);
        await reloadSqlJournal(); return result; }
      const existing = journal.attempts.find(a => a.phase_index === r.phaseIndex);
      if (existing) return { mayExecute: false, status: existing.status };
      assert.equal(r.phaseIndex, journal.chain.next_phase); assert.equal(fresh.sourceFingerprint, journal.chain.current_guard.sourceFingerprint);
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex'), phase = journal.chain.phases[r.phaseIndex];
      journal.attempts.push({ operation_id: opId, step_index: 0, phase_index: r.phaseIndex, attempt_id: attemptId, phase, status: 'started', request, request_hash: requestHash, before_guard: structuredClone(fresh) });
      return { mayExecute: true, replayed: false, phase, attemptId, requestHash, request };
    },
    uncertain: async (r, _owner, ack) => { if (sql) { await sql.rpc('mark_toptik_media_transport_uncertain', [id.productId, owner, opId, r.step, r.phaseIndex, randomUUID(), ack]); await reloadSqlJournal(); return; }
      const a = journal.attempts.find(a => a.phase_index === r.phaseIndex); a.status = 'uncertain'; a.ack = ack; },
    conflict: async () => { throw Error('UNEXPECTED_JOURNAL_CONFLICT'); },
    accept: async (r, _owner, _requestId, requestHash, fresh, artifact) => {
      if (sql) { const result = await sql.rpc('accept_toptik_media_transport', [id.productId, owner, opId, r.step, r.phaseIndex, randomUUID(), fresh,
        { requestHash, readbackSha256: fresh.target.revision, artifact }]); await reloadSqlJournal(); return result; }
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
  return { v, plan, observed, expected, calls, blobs, source, shopify, privateStore, reviewStore, reviews, receipt, entry, stagedResult, uploadUrl, key, journal, sql, reloadSqlJournal,
    discovery, deadline, runStage, runNative, assemble, capture, get createCalls() { return createCalls; },
    set loseCreate(value) { loseCreate = value; }, set hideCreated(value) { hideCreated = value; }, get created() { return created; } };
}

test('reviewed sync-staged source survives real recompression via builder, SQL provenance registration, capture, final accept and commit', async t => {
  const x = await setup(true);
  try {
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
  assert.notEqual(createdArtifact.decodedSha256, x.stagedResult.sha256, 'provider actually recompressed the source');
  assert.equal(createdArtifact.mediaGid, x.created.id);
  assert.deepEqual(await x.runNative(2), { status: 'verified', executed: true });
  assert.deepEqual(await x.runNative(3), { status: 'verified', executed: false }, 'SQL verifies append order without another native call');
  assert.equal(x.discovery.provenance.some(p => p.proof.platformRef === x.created.id), false, 'no hand-seeded native provenance');
  await assert.rejects(x.capture(x.v.context), /MEDIA_REVIEW_REQUIRED/, 'this is the actual pre-fix failure');
  const mutations = [
    ['unverified create', d => d.transport.attempts.find(a => a.phase === 'create_owned').status = 'uncertain'],
    ['unverified association', d => d.transport.attempts.find(a => a.phase === 'associate').status = 'uncertain'],
    ['wrong product identity', d => d.identity.productId = 'gid://shopify/Product/789'],
    ['wrong variant identity', d => d.identity.variantId = 'gid://shopify/ProductVariant/789'],
    ['wrong item identity', d => d.identity.itemId = randomUUID()],
    ['wrong exact SKU', d => d.identity.exactShopifySku = 'FOREIGN'],
    ['wrong native media ID', d => d.transport.artifacts.find(a => a.phase_index === 1).artifact.mediaGid = 'gid://shopify/MediaImage/789'],
    ['wrong decoded artifact hash', d => d.transport.artifacts.find(a => a.phase_index === 1).artifact.decodedSha256 = 'f'.repeat(64)],
    ['wrong source parent', d => d.transport.attempts.find(a => a.phase === 'create_owned').request.sourceEvidenceId = 'foreign-parent'],
    ['wrong logical key', d => d.step.body.key = 'foreign-key'],
    ['ambiguous create artifacts', d => d.transport.artifacts.push(structuredClone(d.transport.artifacts.find(a => a.phase_index === 1)))],
    ['ambiguous existing native lineage', d => d.provenance.push({ product_gid: id.productId, side: 'shopify', asset_key: 'other-key',
      content_id: x.stagedResult.sha256, evidence_id: 'conflicting-proof', proof: { platformRef: x.created.id } })],
  ];
  for (const [name, mutate] of mutations) await t.test(`untrusted lineage holds before register: ${name}`, async () => {
    const changed = structuredClone(x.discovery); mutate(changed);
    await assert.rejects(x.capture(x.v.context, changed), /MEDIA_IMPORT_LINEAGE_REQUIRED/);
  });
  await t.test('the real denylist guard still wins over a verified create receipt', async () => {
    const read = await x.shopify.readReadyShopifyMedia(id, x.deadline());
    const metadata = new Map(); for (const image of read.images) metadata.set(image.url, await x.source.captureMediaSourceBytes(id, image.url, x.deadline()));
    const deniedImports = makeImports({ createHash, ...raw, assertNotDeniedMedia: (url, hash) => guard.assertNotDeniedMedia(url, hash,
      { items: [], deniedUrls: [x.created.image.url], deniedSha256: [] }) });
    assert.throws(() => deniedImports.verifiedNativeImportProofs(x.discovery, id, read, metadata, Date.now()), /MEDIA_REVIEW_REJECTED/);
  });
  await t.test('fresh native bytes changed after the verified receipt cannot be imported', async () => {
    const saved = x.blobs.get(x.created.image.url);
    try { x.blobs.set(x.created.image.url, await picture(90));
      await assert.rejects(x.capture(x.v.context, x.discovery), /MEDIA_IMPORT_LINEAGE_REQUIRED/);
    } finally { x.blobs.set(x.created.image.url, saved); }
  });
  assert.equal((await x.sql.db.query("select count(*)::int n from toptik_media_private.provenance where product_gid=$1 and side='shopify' and proof->>'platformRef'=$2",
    [id.productId, x.created.id])).rows[0].n, 0, 'all negative cases leave native provenance absent');
  assert.equal(x.createCalls, 1, 'negative checks never replay a native mutation');
  const readback = await x.capture(x.v.context, x.discovery);
  core.verifyMediaReadback(x.plan, readback.pair);
  const nativeProof = readback.proofs.find(p => p.side === 'shopify' && p.key === x.key);
  assert.equal(nativeProof.proof.ownership, 'reference_only');
  assert.equal(nativeProof.contentId, x.stagedResult.sha256);
  assert.equal(nativeProof.proof.decodedSha256, createdArtifact.decodedSha256);
  await x.sql.rpc('register_toptik_media_provenance', [id.productId, owner, readback.proofs]);
  await x.reloadSqlJournal();
  x.v.context.provenance = (await x.sql.db.query('select * from toptik_media_private.provenance where product_gid=$1', [id.productId])).rows;
  const resumed = await x.capture(x.v.context, x.discovery);
  assert.equal(resumed.proofs.find(p => p.evidenceId === nativeProof.evidenceId).proof.verifiedAt, nativeProof.proof.verifiedAt,
    'retry reuses the exact registered proof instead of changing immutable evidence');
  await x.sql.rpc('register_toptik_media_provenance', [id.productId, owner, resumed.proofs]);
  const finalGuard = { sourceFingerprint: core.mediaSnapshotFingerprint(readback.pair.gallery), target: x.journal.chain.current_guard.target, observedAt: new Date().toISOString() };
  assert.equal((await x.sql.rpc('accept_toptik_media_final_readback', [id.productId, owner, opId, 0, randomUUID(), readback.pair, finalGuard])).status, 'verified');
  // The generic planner persists its logical order checkpoint separately; the attach transport
  // already produced this exact order, so SQL verifies the remaining reorder without a native call.
  for (let step = 1; step < x.plan.patches.length + x.plan.orders.length; step++) {
    await x.sql.rpc('begin_toptik_media_step', [id.productId, owner, opId, step, randomUUID(), readback.pair]);
    await x.sql.rpc('prepare_toptik_media_transport', [id.productId, owner, opId, step, randomUUID(), ['reorder'], finalGuard]);
    const permit = await x.sql.rpc('begin_toptik_media_transport', [id.productId, owner, opId, step, 0, randomUUID(),
      { mutationSha256: 'a'.repeat(64), mediaGids: finalGuard.target.media.map(m => m.mediaId) }, finalGuard]);
    assert.equal(permit.verifiedNoop, true);
    assert.equal((await x.sql.rpc('accept_toptik_media_final_readback', [id.productId, owner, opId, step, randomUUID(), readback.pair, finalGuard])).status, 'verified');
  }
  assert.equal((await x.sql.rpc('commit_toptik_media_operation', [id.productId, owner, opId, randomUUID(), readback.pair])).status, 'verified');
  assert.equal(x.createCalls, 1); assert.equal(x.v.product.media.nodes.length, 2);
  assert.equal(x.v.product.media.nodes.at(-1).id, x.created.id);
  x.v.context.baselines = readback.pair; x.v.context.galleryRefs = readback.refs;
  x.v.context.provenance = readback.proofs.map(p => ({ product_gid: id.productId, side: p.side, asset_key: p.key, evidence_id: p.evidenceId, content_id: p.contentId, proof: p.proof }));
  const unchanged = await x.capture(x.v.context), secondPlan = core.reconcileMedia(readback.pair, unchanged.pair, [], [], unchanged.visuals);
  assert.deepEqual(secondPlan.conflicts, []); assert.deepEqual(secondPlan.patches, []); assert.deepEqual(secondPlan.orders, []);
  assert.equal(x.createCalls, 1, 'a subsequent observation cannot duplicate the image');
  } finally { await x.sql.db.close(); }
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

test('ALT clone inherits only the exact pinned baseline photo through real SQL and capture after recompression, without another review', async t => {
  const database = await createVerifiedImportDatabase();
  try {
    const a = await picture(301), b = await picture(527), native = await sharp(a).jpeg({ quality: 86 }).toBuffer();
    const metadata = (bytes, mime) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), mime, width: 40, height: 60, byteLength: bytes.length });
    const f = await seedVerifiedImportOperation(database, { kind: 'alt', baseMetadata: { a: metadata(a, 'image/png'), b: metadata(b, 'image/png') },
      nativeMetadata: metadata(native, 'image/jpeg') });
    assert.notEqual(f.artifact.decodedSha256, f.parent.contentId);
    const desiredIds = f.expected.shopify.assets.map(asset => asset.key === f.added.key ? f.artifact.mediaGid :
      f.raw.media.find(m => m.alt === asset.alt).mediaId);
    const permit = await f.begin(f.reorderPhaseIndex, { mutationSha256: 'a'.repeat(64), mediaGids: desiredIds });
    f.raw = await f.stamp({ ...f.raw, media: desiredIds.map(id => f.raw.media.find(m => m.mediaId === id)) });
    assert.equal((await f.accept(f.reorderPhaseIndex, permit.requestHash, f.raw)).status, 'verified');
    const discovery = await f.rpc('read_toptik_media_operation', [f.op, 0, 0]);
    const provenance = (await f.db.query('select * from toptik_media_private.provenance where product_gid=$1', [f.product])).rows;
    assert.equal(provenance.some(p => p.proof.platformRef === f.artifact.mediaGid), false);
    const g = key => provenance.find(p => p.side === 'gallery' && p.asset_key === key);
    const angleA = randomUUID(), angleB = randomUUID();
    const galleryRaw = { identity: f.identity, version: 1, revision: f.current.gallery.revision,
      item: { id: f.identity.itemId, catalog_number: f.identity.exactGallerySku, title: 'Offline exact product', is_active: true,
        cover_image_path: g('a').proof.url, cover_image_alt: f.current.gallery.assets[0].alt },
      angles: ['a', 'b'].map((key, i) => ({ id: i ? angleB : angleA, item_id: f.identity.itemId, angle_key: key, angle_order: i + 1,
        image_path: g(key).proof.url, image_alt: f.current.gallery.assets.find(a => a.key === key).alt })) };
    const context = { identity: f.identity, stateVersion: 1, baselines: f.base, provenance, galleryRaw,
      galleryRefs: [{ role: 'cover', angleId: null, key: 'a', evidenceId: g('a').evidence_id },
        ...['a', 'b'].map((key, i) => ({ role: 'angle', angleId: i ? angleB : angleA, key, evidenceId: g(key).evidence_id }))],
      operations: [], steps: [], removals: [], detached: [] };
    const blobs = new Map(); for (const p of provenance) blobs.set(p.proof.url, p.asset_key === 'a' ? a : b);
    blobs.set(f.artifact.url, native);
    const source = makeSource({ createHash, sharp, ...limits, ...core, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      isPrivateAddress: () => false, fetch: async url => { assert.ok(blobs.has(url), 'only offline photos can be read'); return new Response(blobs.get(url)); } });
    const conn = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
    const read = ready.parseMediaReadResponse({ data: { product: { id: f.product, handle: f.identity.productHandle, status: 'ACTIVE', publishedOnPublication: true,
      updatedAt: f.raw.updatedAt, mediaCount: { count: f.raw.media.length, precision: 'EXACT' }, media: conn(f.raw.media.map(m => ({ ...m, id: m.mediaId }))),
      variants: conn([{ id: f.identity.variantId, sku: f.identity.exactShopifySku, image: f.raw.variantImage, media: conn([]) }]) } } }, f.identity);
    const dependencies = { createHash, ...ready, ...gallery, ...source, ...guard, ...imports, readReadyShopifyMedia: async () => read,
      loadReviewedMedia: async () => [] };
    const capture = (ctx, d, overrides = {}) => makeCapture({ ...dependencies, ...overrides }).captureMediaPlanningPair(ctx, f.owner, Date.now() + 30000,
      { gallery: () => ({ read: async () => galleryRaw }), ...(d ? { verifiedTransport: d } : {}) });
    await assert.rejects(capture(context), /MEDIA_REVIEW_REQUIRED/);
    for (const [name, mutate] of [
      ['wrong ALT parent', d => d.transport.attempts.find(a => a.phase === 'create_owned').request.sourceEvidenceId = 'foreign'],
      ['foreign source side', d => d.provenance.find(p => p.evidence_id === f.parent.evidenceId).side = 'gallery'],
      ['missing native source membership', d => d.operation.observed_pair.shopify.assets = d.operation.observed_pair.shopify.assets.filter(a => a.key !== 'a')],
      ['duplicate native source membership', d => d.operation.observed_pair.shopify.assets.push(structuredClone(d.operation.observed_pair.shopify.assets.find(a => a.key === 'a')))],
    ]) await t.test(name, async () => { const d = structuredClone(discovery); mutate(d); await assert.rejects(capture(context, d), /MEDIA_IMPORT_LINEAGE_REQUIRED/); });
    for (const [name, mutate] of [
      ['stale baseline version', c => c.stateVersion++],
      ['missing exact baseline photo', c => c.baselines.shopify.assets = c.baselines.shopify.assets.filter(a => a.key !== 'a')],
      ['wrong baseline evidence', c => c.baselines.shopify.assets.find(a => a.key === 'a').evidenceId = 'foreign'],
    ]) await t.test(name, async () => { const c = structuredClone(context); mutate(c); await assert.rejects(capture(c, discovery), /MEDIA_IMPORT_LINEAGE_REQUIRED/); });
    await t.test('a denied baseline parent still prevents ALT inheritance', async () => {
      await assert.rejects(capture(context, discovery, { assertNotDeniedMedia: (url, hash) => guard.assertNotDeniedMedia(url, hash,
        { items: [], deniedUrls: [f.parent.proof.url], deniedSha256: [] }) }), /MEDIA_REVIEW_REJECTED/);
    });
    const captured = await capture(context, discovery);
    core.verifyMediaReadback(discovery.operation.plan, captured.pair);
    const imported = captured.proofs.find(p => p.side === 'shopify' && p.key === 'a');
    assert.equal(imported.proof.sourceEvidenceId, f.parent.evidenceId); assert.equal(imported.proof.decodedSha256, f.artifact.decodedSha256);
    await f.register(captured.proofs);
    assert.equal((await f.rpc('accept_toptik_media_final_readback', [f.product, f.owner, f.op, 0, randomUUID(), captured.pair,
      { sourceFingerprint: core.mediaSnapshotFingerprint(captured.pair.gallery), target: f.raw, observedAt: new Date().toISOString() }])).status, 'verified');
    assert.equal((await f.rpc('commit_toptik_media_operation', [f.product, f.owner, f.op, randomUUID(), captured.pair])).status, 'verified');
  } finally { await database.db.close(); }
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
