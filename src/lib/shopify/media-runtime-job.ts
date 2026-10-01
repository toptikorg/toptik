import "server-only";
import type { MediaAsset, MediaIdentity, MediaPair } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";
import { assertMediaTransportRead, parseTransportMedia, type ShopifyMediaTransportRead, type TransportMedia } from "./media-transport-read";
import { buildOwnedMediaCreate, buildOwnedMediaAssociate, buildMediaVariantReassign, buildMediaReferenceDetach,
  buildMediaReorder, ownedMediaFilename, stagedMediaUrl, type MediaTransportContext, type MediaTransportRequest,
  type StagedMediaSource, type OwnedMediaReceipt } from "./media-transport-requests";
import { buildMediaJournalIntent } from "./media-transport-journal-intent";
import { discoverMediaTransportOperation, type MediaOperationDiscovery } from "./media-transport-rpc";
import { readOwnedShopifyMediaNode, type ShopifyMediaExecutionEvidence } from "./media-shopify-transport";
import type { MediaTransportPhaseJob, MediaTransportReference } from "./media-transport-worker";

type Row = Record<string, unknown>;
type Environment = { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string };
/** Obtained from the fixed-shop Admin API by the server, never from an HTTP body. */
export type MediaRuntimeScopes = { shopDomain: "toptikcoil.myshopify.com"; apiVersion: "2026-07";
  publicationId: "gid://shopify/Publication/79538258170"; scopes: string[]; observedAt: string };
export type MediaRuntimeJobResult =
  | { status: "disabled" | "scope_missing" | "verified" | "conflict"; identity: MediaIdentity }
  | { status: "ready"; identity: MediaIdentity; job: MediaTransportPhaseJob; evidence: ShopifyMediaExecutionEvidence;
      intent: Row; recovery: boolean; previousAttemptId: string | null; requestHash: string | null; expectedContentId: string | null };
export type MediaRuntimeJobOptions = { environment?: Environment; now?: number; scopes?: MediaRuntimeScopes;
  /** Only needed for an owned file not yet present in the immutable before snapshot. */
  ownedMedia?: { media: TransportMedia; observedAt: string } };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MEDIA_ID = /^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function fail(code: string): never { throw new Error(code); }
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_JOB_RECORD_INVALID");
  return value as Row;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }
function text(value: unknown, pattern: RegExp, code = "MEDIA_JOB_RECORD_INVALID"): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code); return value;
}
function fresh(stamp: string, now: number) {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) ||
      !Number.isFinite(Date.parse(stamp)) || Date.parse(stamp) < now - 30_000 || Date.parse(stamp) > now + 5000) fail("MEDIA_JOB_FRESH_EVIDENCE_REQUIRED");
}
function asset(pair: MediaPair, key: string, side: "gallery" | "shopify"): MediaAsset {
  const found = pair[side].assets.filter(a => a.key === key);
  if (found.length !== 1) fail("MEDIA_JOB_ASSET_MISSING"); return found[0];
}
function proof(discovery: MediaOperationDiscovery, evidenceId: string, expected?: MediaAsset) {
  const matches = discovery.provenance.filter(p => p.evidence_id === evidenceId);
  if (matches.length !== 1) fail("MEDIA_JOB_PROVENANCE_MISSING");
  const entry = matches[0];
  if (entry.product_gid !== discovery.identity.productId || !["gallery", "shopify"].includes(String(entry.side)) ||
      (expected && (entry.asset_key !== expected.key || entry.content_id !== expected.contentId))) fail("MEDIA_JOB_PROVENANCE_MISMATCH");
  return row(entry.proof);
}
function scopeAvailable(phase: string, input: MediaRuntimeScopes | undefined, now: number) {
  if (!input || input.shopDomain !== "toptikcoil.myshopify.com" || input.apiVersion !== "2026-07" ||
      input.publicationId !== "gid://shopify/Publication/79538258170" || !Array.isArray(input.scopes) || input.scopes.length > 100 ||
      input.scopes.some(s => typeof s !== "string" || !/^[a-z][a-z0-9_]{1,99}$/.test(s))) fail("MEDIA_JOB_SCOPE_EVIDENCE_REQUIRED");
  fresh(input.observedAt, now);
  const alternatives = phase === "create_owned" ? ["write_files", "write_themes", "write_images"] :
    ["associate", "detach_old"].includes(phase) ? ["write_files", "write_themes"] : ["write_products"];
  return alternatives.some(s => input.scopes.includes(s));
}
function trustedInputs(ref: MediaTransportReference, discovery: MediaOperationDiscovery) {
  if (!UUID.test(ref.operationId) || !Number.isInteger(ref.step) || ref.step < 0 || ref.step > 1000 ||
      !Number.isInteger(ref.phaseIndex) || ref.phaseIndex < 0 || ref.phaseIndex > 10) fail("MEDIA_TRANSPORT_REFERENCE_INVALID");
  const d = structuredClone(discovery), op = row(d.operation), step = row(d.step), identity = d.identity;
  if (op.id !== ref.operationId || op.product_gid !== identity.productId || step.operation_id !== ref.operationId || step.step_index !== ref.step ||
      typeof d.enabled !== "boolean" || !Array.isArray(d.provenance) || d.provenance.length > 1000) fail("MEDIA_JOB_IDENTITY_CHANGED");
  const observed = row(op.observed_pair) as MediaPair, expected = row(step.expected_pair) as MediaPair;
  for (const pair of [observed, expected]) for (const side of ["gallery", "shopify"] as const) {
    mediaSnapshotFingerprint(pair[side]);
    if (pair[side].side !== side || !same(pair[side].identity, identity)) fail("MEDIA_JOB_IDENTITY_CHANGED");
  }
  const body = row(step.body), transport = d.transport;
  if (body.target !== "shopify") fail("MEDIA_JOB_NON_SHOPIFY_PHASE");
  if (!["attach", "replace_reference", "alt", "detach_reference", "reorder"].includes(String(body.kind))) fail("MEDIA_JOB_LOGICAL_STEP_INVALID");
  if (!Array.isArray(transport.attempts) || !Array.isArray(transport.artifacts) || transport.attempts.length > 11 || transport.artifacts.length > 11) fail("MEDIA_JOB_JOURNAL_INVALID");
  const chain = row(transport.chain);
  if (chain.operation_id !== ref.operationId || chain.step_index !== ref.step || !Array.isArray(chain.phases) ||
      chain.phases.length > 11 || !Number.isInteger(chain.next_phase) || Number(chain.next_phase) < 0 || Number(chain.next_phase) > chain.phases.length) fail("MEDIA_JOB_JOURNAL_INVALID");
  const phases = chain.phases as string[], effective = phases[0] === "stage_source" ? phases.slice(1) : phases;
  const permitted = body.kind === "attach" ? [["create_owned", "associate", "reorder"]] :
    ["replace_reference", "alt"].includes(String(body.kind)) ? [["create_owned", "associate", "detach_old", "reorder"], ["create_owned", "associate", "variant_reassign", "detach_old", "reorder"]] :
    body.kind === "detach_reference" ? [["detach_old"]] : [["reorder"]];
  if (!permitted.some(p => same(p, effective)) || (phases[0] === "stage_source" && !["attach", "replace_reference", "alt"].includes(String(body.kind)))) fail("MEDIA_JOB_PHASE_SEQUENCE_INVALID");
  if (ref.phaseIndex >= phases.length) fail("MEDIA_JOB_PHASE_INDEX_INVALID");
  const checkRows = (rows: Row[]) => {
    if (new Set(rows.map(a => a.phase_index)).size !== rows.length) fail("MEDIA_JOB_JOURNAL_INVALID");
    for (const a of rows) if (a.operation_id !== ref.operationId || a.step_index !== ref.step || !Number.isInteger(a.phase_index) ||
        Number(a.phase_index) < 0 || Number(a.phase_index) >= phases.length) fail("MEDIA_JOB_JOURNAL_INVALID");
  };
  checkRows(transport.attempts); checkRows(transport.artifacts);
  for (const a of transport.attempts) if (a.phase !== phases[Number(a.phase_index)] || !UUID.test(String(a.attempt_id)) || !HASH.test(String(a.request_hash))) fail("MEDIA_JOB_JOURNAL_INVALID");
  for (const a of transport.artifacts) if (!transport.attempts.some(t => t.phase_index === a.phase_index && t.status === "verified")) fail("MEDIA_JOB_ARTIFACT_NOT_VERIFIED");
  const attempt = transport.attempts.find(a => a.phase_index === ref.phaseIndex);
  return { d, op, step, identity, observed, expected, body, chain, phases, attempt };
}

/** Pure assembly from a service-only discovery. Does not confer any mutation permit. */
export function assembleMediaRuntimeJob(reference: MediaTransportReference, discovery: MediaOperationDiscovery,
  options: MediaRuntimeJobOptions = {}): MediaRuntimeJobResult {
  const env = options.environment ?? process.env, now = options.now ?? Date.now();
  // Disabled reads need no historical artifacts, scope calls or manufactured placeholder request.
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1" || discovery.enabled !== true) {
    return { status: "disabled", identity: structuredClone(discovery.identity) };
  }
  const ref = structuredClone(reference), { d, op, step, identity, observed, expected, body, chain, phases, attempt } = trustedInputs(ref, discovery);
  if (op.status === "conflict" || step.status === "conflict" || chain.status === "conflict" || attempt?.status === "conflict") return { status: "conflict", identity };
  if (op.status === "verified" || step.status === "verified" || attempt?.status === "verified") return { status: "verified", identity };
  if (!["running", "uncertain"].includes(String(op.status)) || !["started", "uncertain"].includes(String(step.status)) ||
      !["ready", "running", "uncertain"].includes(String(chain.status)) || Number(chain.next_phase) !== ref.phaseIndex ||
      (attempt && !["started", "uncertain"].includes(String(attempt.status)))) fail("MEDIA_JOB_OUT_OF_ORDER");
  const phase = phases[ref.phaseIndex];
  if (phase === "stage_source") fail("MEDIA_JOB_STORAGE_PHASE_REQUIRED");
  if (!scopeAvailable(phase, options.scopes, now)) return { status: "scope_missing", identity };
  for (let n = 0; n < ref.phaseIndex; n++) if (!d.transport.attempts.some(a => a.phase_index === n && a.status === "verified")) fail("MEDIA_JOB_PRIOR_PHASE_NOT_VERIFIED");
  // Recovery MUST use the immutable old guard/request, not the latest chain observation.
  const guard = row(attempt ? attempt.before_guard : chain.current_guard), before = row(guard.target) as ShopifyMediaTransportRead;
  assertMediaTransportRead(before);
  if (!same(before.identity, identity) || guard.sourceFingerprint !== mediaSnapshotFingerprint(observed.gallery)) fail("MEDIA_JOB_GUARD_CHANGED");
  const context: MediaTransportContext = { identity, operationId: ref.operationId, step: ref.step,
    sourceFingerprint: text(guard.sourceFingerprint, HASH), targetRevision: before.revision };
  const key = body.kind === "reorder" ? null : text(body.key, KEY), desired = key === null || body.kind === "detach_reference" ? null : asset(expected, key, "shopify");
  const prior = d.transport.artifacts.filter(a => Number(a.phase_index) < ref.phaseIndex).sort((a, b) => Number(a.phase_index) - Number(b.phase_index));
  const ownedRow = prior.find(a => Object.hasOwn(row(a.artifact), "mediaGid"));
  const oldMediaId = () => text(proof(d, asset(observed, key!, "shopify").evidenceId, asset(observed, key!, "shopify")).platformRef, MEDIA_ID);
  const createAttempt = d.transport.attempts.find(a => a.phase === "create_owned" && Number(a.phase_index) < ref.phaseIndex && a.status === "verified");
  const makeOwned = (): OwnedMediaReceipt => {
    if (!ownedRow || !createAttempt || ownedRow.phase_index !== createAttempt.phase_index || !desired) fail("MEDIA_JOB_OWNED_ARTIFACT_REQUIRED");
    const artifact = row(ownedRow.artifact), createIntent = row(createAttempt.request);
    const sourceId = text(createIntent.sourceEvidenceId, KEY), source = proof(d, sourceId, desired);
    const sourceSha = text(source.decodedSha256, HASH), mime = source.mime as StagedMediaSource["mime"];
    const filename = ownedMediaFilename(context, sourceSha, mime), mediaId = text(artifact.mediaGid, MEDIA_ID);
    if (artifact.contentId !== desired.contentId || artifact.ready !== true || artifact.filename !== filename || createIntent.filename !== filename ||
        !HASH.test(String(artifact.decodedSha256)) || !Number.isSafeInteger(artifact.byteLength) || Number(artifact.byteLength) < 1 || Number(artifact.byteLength) > 8388608) fail("MEDIA_JOB_OWNED_ARTIFACT_INVALID");
    // Later phases reuse the exact media record in their frozen before guard.
    // For associate it is not there yet: a fresh exact MediaImage node is required.
    const stored = before.media.find(m => m.mediaId === mediaId);
    if (!stored && !options.ownedMedia) fail("MEDIA_JOB_OWNED_NODE_REQUIRED");
    if (!stored) fresh(options.ownedMedia!.observedAt, now);
    const raw = stored ?? options.ownedMedia!.media, media = parseTransportMedia({ ...raw, id: raw.mediaId });
    if (media.mediaId !== mediaId || media.status !== "READY" || media.fileStatus !== "READY" || !media.image ||
        media.image.url !== artifact.url || media.image.width !== artifact.width || media.image.height !== artifact.height || (media.alt ?? "") !== desired.alt) fail("MEDIA_JOB_OWNED_NODE_CHANGED");
    return { identity, operationId: ref.operationId, step: ref.step, sourceFingerprint: context.sourceFingerprint,
      filename, sourceSha256: sourceSha, mime, alt: desired.alt, media, decodedSha256: String(artifact.decodedSha256),
      decodedByteLength: Number(artifact.byteLength), receiptId: text(createAttempt.attempt_id, UUID) };
  };
  let request: MediaTransportRequest, evidence: ShopifyMediaExecutionEvidence, sourceEvidenceId: string | undefined;
  switch (phase) {
    case "create_owned": {
      if (!desired) fail("MEDIA_JOB_ASSET_MISSING");
      sourceEvidenceId = attempt ? text(row(attempt.request).sourceEvidenceId, KEY) : desired.evidenceId;
      const sourceProof = proof(d, sourceEvidenceId, desired), hash = text(sourceProof.decodedSha256, HASH), mime = sourceProof.mime as StagedMediaSource["mime"];
      const url = stagedMediaUrl(identity, hash, mime), stage = prior.find(a => Object.hasOwn(row(a.artifact), "storagePath"));
      const p = stage ? row(stage.artifact) : sourceProof;
      if (p.url !== url || p.decodedSha256 !== hash || (stage ? p.ready !== true || p.contentId !== desired.contentId : p.ownership !== "owned_storage") ||
          (stage && (p.mime !== mime || p.width !== sourceProof.width || p.height !== sourceProof.height || p.byteLength !== sourceProof.byteLength))) fail("MEDIA_JOB_STAGED_SOURCE_REQUIRED");
      const source: StagedMediaSource = { identity, contentSha256: hash, mime, byteLength: Number(p.byteLength), width: Number(p.width),
        height: Number(p.height), url, receiptId: sourceEvidenceId };
      request = buildOwnedMediaCreate(context, source, desired.alt); evidence = { phase, before, source, alt: desired.alt }; break;
    }
    case "associate": { const owned = makeOwned(); request = buildOwnedMediaAssociate(context, before, owned); evidence = { phase, before, owned }; break; }
    case "variant_reassign": { const owned = makeOwned(), old = oldMediaId(); request = buildMediaVariantReassign(context, before, old, owned); evidence = { phase, before, owned, oldMediaId: old }; break; }
    case "detach_old": { const old = oldMediaId(), kind = body.kind === "detach_reference" ? "detach_reference" : "detach_old";
      request = buildMediaReferenceDetach(context, before, old, kind); evidence = { phase: kind, before, oldMediaId: old }; break; }
    case "reorder": {
      const desiredIds = expected.shopify.assets.map(a => a.key === key && ownedRow ? text(row(ownedRow.artifact).mediaGid, MEDIA_ID) :
        text(proof(d, asset(observed, a.key, "shopify").evidenceId, asset(observed, a.key, "shopify")).platformRef, MEDIA_ID));
      request = buildMediaReorder(context, before, desiredIds, true); evidence = { phase, before, desiredIds }; break;
    }
    default: return fail("MEDIA_JOB_PHASE_UNSUPPORTED");
  }
  const intent = buildMediaJournalIntent(request, before, sourceEvidenceId);
  if (attempt && !same(intent, attempt.request)) fail("MEDIA_JOB_IMMUTABLE_REQUEST_CHANGED");
  return { status: "ready", identity, job: { request, before, ...(sourceEvidenceId ? { sourceEvidenceId } : {}), enabled: true, scopes: [...options.scopes!.scopes] },
    evidence, intent, recovery: !!attempt, previousAttemptId: attempt ? String(attempt.attempt_id) : null, requestHash: attempt ? String(attempt.request_hash) : null,
    expectedContentId: phase === "create_owned" ? desired!.contentId : null };
}

type LoadDependencies = {
  /** Actual server-owned currentAppInstallation.accessScopes read, with fixed-shop identity. */
  readScopes(deadline: number): Promise<MediaRuntimeScopes>;
  discover?: typeof discoverMediaTransportOperation;
  readOwnedMedia?: typeof readOwnedShopifyMediaNode;
  now?: () => number;
  environment?: Environment;
};
async function bounded<T>(run: () => Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = Math.min(8000, deadline - now());
  if (!Number.isFinite(deadline) || remaining <= 0) fail("MEDIA_JOB_TIME_BUDGET");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { const value = await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MEDIA_JOB_TIME_BUDGET")), remaining); })]);
    if (now() >= deadline) fail("MEDIA_JOB_TIME_BUDGET"); return value;
  } finally { if (timer) clearTimeout(timer); }
}

/** Bounded read-only loader. Fixed adapters must honor the same absolute deadline. */
export async function loadMediaRuntimeJob(reference: MediaTransportReference, deadline: number, deps: LoadDependencies): Promise<MediaRuntimeJobResult> {
  const now = deps.now ?? Date.now, stopAt = Math.min(deadline, now() + 8000);
  const discovery = await bounded(() => (deps.discover ?? discoverMediaTransportOperation)(reference, stopAt), stopAt, now);
  const options: MediaRuntimeJobOptions = { environment: deps.environment, now: now() };
  const env = deps.environment ?? process.env;
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1" || !discovery.enabled) return assembleMediaRuntimeJob(reference, discovery, options);
  options.scopes = await bounded(() => deps.readScopes(stopAt), stopAt, now); options.now = now();
  try { return assembleMediaRuntimeJob(reference, discovery, options); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "MEDIA_JOB_OWNED_NODE_REQUIRED") throw error;
    // Locate only the exact already-verified create artifact; never infer a file ID from URL/name.
    const rows = discovery.transport.artifacts.filter(a => Number(a.phase_index) < reference.phaseIndex && Object.hasOwn(row(a.artifact), "mediaGid"));
    if (rows.length !== 1) fail("MEDIA_JOB_OWNED_ARTIFACT_REQUIRED");
    const mediaId = text(row(rows[0].artifact).mediaGid, MEDIA_ID);
    const media = await bounded(() => (deps.readOwnedMedia ?? readOwnedShopifyMediaNode)(mediaId, stopAt), stopAt, now);
    if (!media) fail("MEDIA_JOB_OWNED_NODE_REQUIRED");
    options.now = now(); options.ownedMedia = { media, observedAt: new Date(now()).toISOString() };
    return assembleMediaRuntimeJob(reference, discovery, options);
  }
}
