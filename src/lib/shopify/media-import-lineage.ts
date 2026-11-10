import "server-only";
import { createHash } from "node:crypto";
import type { MediaIdentity } from "./media-sync-core";
import type { ShopifyMediaRead } from "./media-read-adapter";
import type { CapturedMediaBytes } from "./media-source-bytes";
import type { MediaOperationDiscovery } from "./media-transport-rpc";
import type { MediaPlanningContext, MediaRegisteredProof } from "./media-planning-rpc";
import { assertMediaTransportRead } from "./media-transport-read";
import { assertNotDeniedMedia } from "./reviewed-media-guard";

type Row = Record<string, unknown>;
type Bytes = Pick<CapturedMediaBytes, "sha256" | "mime" | "width" | "height" | "byteLength">;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(): never { throw new Error("MEDIA_IMPORT_LINEAGE_REQUIRED"); }
const row = (v: unknown): Row => !v || typeof v !== "object" || Array.isArray(v) ? fail() : v as Row;
const sameIdentity = (a: MediaIdentity, b: MediaIdentity) => {
  if (["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"].some(k =>
    a[k as keyof MediaIdentity] !== b[k as keyof MediaIdentity])) fail();
};
const exactlyOne = <T>(values: T[]): T => values.length === 1 ? values[0] : fail();

/** Private verified transport is the authority, never a filename, equal bytes or a browser operation ID.
 * The caller must subsequently run the normal review-parent guard and register RPC under its product lease.
 * No row/baseline is written here. Current native pixels must match the independently decoded create receipt.
 */
export function verifiedNativeImportProofs(discovery: MediaOperationDiscovery, identity: MediaIdentity, current: ShopifyMediaRead,
  captured: ReadonlyMap<string, Bytes>, now: number, authority?: Pick<MediaPlanningContext, "stateVersion" | "baselines">): MediaRegisteredProof[] {
  const d = structuredClone(discovery), op = row(d.operation), step = row(d.step), chain = row(d.transport.chain);
  const body = row(step.body);
  sameIdentity(d.identity, identity); sameIdentity(current.identity, identity);
  if (body.target !== "shopify" || !["attach", "replace_reference", "alt"].includes(String(body.kind))) return [];
  if (!d.enabled || !UUID.test(String(op.id)) || op.product_gid !== identity.productId ||
      !["running", "uncertain"].includes(String(op.status)) || step.operation_id !== op.id ||
      !Number.isInteger(step.step_index) || !["started", "uncertain"].includes(String(step.status)) ||
      chain.operation_id !== op.id || chain.step_index !== step.step_index || chain.status !== "verified" ||
      !Array.isArray(chain.phases) || chain.next_phase !== chain.phases.length || !Number.isFinite(now)) fail();
  const phases = chain.phases as string[], effective = phases[0] === "stage_source" ? phases.slice(1) : phases;
  const allowed = body.kind === "attach" ? [["create_owned", "associate", "reorder"]] :
    [["create_owned", "associate", "detach_old", "reorder"], ["create_owned", "associate", "variant_reassign", "detach_old", "reorder"]];
  if (!allowed.some(p => JSON.stringify(p) === JSON.stringify(effective))) fail();
  if (d.transport.attempts.length !== phases.length || new Set(d.transport.attempts.map(a => a.phase_index)).size !== phases.length) fail();
  for (const [index, phase] of phases.entries()) {
    const a = exactlyOne(d.transport.attempts.filter(a => a.phase_index === index));
    if (a.operation_id !== op.id || a.step_index !== step.step_index || a.phase !== phase || a.status !== "verified" ||
        !UUID.test(String(a.attempt_id)) || !HASH.test(String(a.request_hash))) fail();
  }
  const create = exactlyOne(d.transport.attempts.filter(a => a.phase === "create_owned")), request = row(create.request);
  const association = exactlyOne(d.transport.attempts.filter(a => a.phase === "associate")), associated = row(association.request);
  const artifact = row(exactlyOne(d.transport.artifacts.filter(a => a.operation_id === op.id &&
    a.step_index === step.step_index && a.phase_index === create.phase_index)).artifact);
  const expected = row(row(step.expected_pair).shopify);
  sameIdentity(expected.identity as MediaIdentity, identity);
  if (expected.side !== "shopify" || !Array.isArray(expected.assets)) fail();
  const desired = row(exactlyOne(expected.assets.filter(a => row(a).key === body.key)));
  const parent = exactlyOne(d.provenance.filter(p => p.product_gid === identity.productId &&
    p.asset_key === body.key && p.evidence_id === request.sourceEvidenceId && p.content_id === desired.contentId));
  if (!["gallery", "shopify"].includes(String(parent.side)) || (body.kind !== "alt" && parent.side !== "gallery")) fail();
  // ALT plans retain the existing native evidence when only target ALT changes. Its real parent
  // can therefore be Shopify even though the edit originated in the Gallery. Never infer the side.
  const sourceSnapshot = row(row(op.observed_pair)[String(parent.side)]);
  sameIdentity(sourceSnapshot.identity as MediaIdentity, identity);
  if (sourceSnapshot.side !== parent.side || !Array.isArray(sourceSnapshot.assets)) fail();
  const sourceAsset = row(exactlyOne(sourceSnapshot.assets.filter(a => row(a).key === body.key)));
  if (sourceAsset.evidenceId !== parent.evidence_id || sourceAsset.contentId !== desired.contentId) fail();
  if (body.kind === "alt") {
    if (!authority || !Number.isSafeInteger(authority.stateVersion) || authority.stateVersion !== op.state_version) fail();
    const baseline = authority.baselines[parent.side as "gallery" | "shopify"];
    sameIdentity(baseline.identity, identity);
    const original = exactlyOne(baseline.assets.filter(a => a.key === body.key));
    if (baseline.side !== parent.side || original.evidenceId !== parent.evidence_id || original.contentId !== desired.contentId) fail();
  }
  if (desired.evidenceId !== parent.evidence_id || artifact.contentId !== desired.contentId || !HASH.test(String(desired.contentId)) ||
      artifact.ready !== true || !HASH.test(String(artifact.decodedSha256)) || artifact.filename !== request.filename ||
      associated.productGid !== identity.productId || associated.mediaGid !== artifact.mediaGid ||
      !/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(String(artifact.mediaGid))) fail();
  const guard = row(association.after_guard);
  const target = guard.target as Parameters<typeof assertMediaTransportRead>[0];
  assertMediaTransportRead(target); sameIdentity(target.identity, identity);
  const associatedMedia = exactlyOne(target.media.filter(m => m.mediaId === artifact.mediaGid));
  const native = exactlyOne(current.images.filter(m => m.mediaId === artifact.mediaGid));
  const bytes = captured.get(native.url);
  if (!bytes || associatedMedia.status !== "READY" || associatedMedia.fileStatus !== "READY" || !associatedMedia.image ||
      associatedMedia.image.url !== artifact.url || associatedMedia.image.width !== artifact.width || associatedMedia.image.height !== artifact.height ||
      (associatedMedia.alt ?? "") !== desired.alt || native.url !== artifact.url || native.width !== artifact.width || native.height !== artifact.height ||
      (native.alt ?? "") !== desired.alt || bytes.sha256 !== artifact.decodedSha256 || bytes.mime !== artifact.mime ||
      bytes.width !== artifact.width || bytes.height !== artifact.height || bytes.byteLength !== artifact.byteLength) fail();
  assertNotDeniedMedia(native.url, bytes.sha256);
  const evidenceId = "s:" + createHash("sha256").update(JSON.stringify([identity.productId, body.key, native.mediaId, native.url, bytes.sha256])).digest("hex");
  const proof = { platformRef: native.mediaId, url: native.url, decodedSha256: bytes.sha256, mime: bytes.mime,
    width: bytes.width, height: bytes.height, byteLength: bytes.byteLength, verifiedAt: new Date(now).toISOString(),
    ownership: "reference_only", operationId: String(op.id), sourceEvidenceId: String(parent.evidence_id) };
  const prior = d.provenance.filter(p => p.side === "shopify" && row(p.proof).platformRef === native.mediaId);
  if (prior.some(p => p.asset_key !== body.key || p.content_id !== desired.contentId)) fail();
  const existing = prior.filter(p => p.evidence_id === evidenceId);
  if (existing.length) {
    const p = exactlyOne(existing), previous = row(p.proof);
    if (Object.keys(proof).some(k => k !== "verifiedAt" && previous[k] !== proof[k as keyof typeof proof])) fail();
    return [{ key: String(body.key), side: "shopify", contentId: String(desired.contentId), evidenceId, proof: previous }];
  }
  if (prior.length) fail();
  return [{ key: String(body.key), side: "shopify", contentId: String(desired.contentId), evidenceId, proof }];
}
