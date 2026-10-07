import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { MediaIdentity, MediaSnapshot } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";
import type { MediaRpcGuard } from "./media-transport-rpc";
import type { MediaTransportReference } from "./media-transport-worker";

type Row = Record<string, unknown>;
export type GalleryMediaRef = { role: "cover" | "angle"; angleId: string | null; key: string; evidenceId: string };
export type GalleryMediaRaw = { identity: MediaIdentity; item: Row & { id: string; catalog_number: string; title: string; cover_image_path: string; cover_image_alt: string | null; is_active: true };
  angles: Array<Row & { id: string; item_id: string; angle_key: string; image_path: string; angle_order: number; image_alt: string | null }>;
  version: number; revision: string };
export type GalleryMediaObservation = { raw: GalleryMediaRaw; refs: GalleryMediaRef[]; snapshot: MediaSnapshot };
export type GalleryMediaProvenance = { evidenceId: string; key: string; side: "gallery"; contentId: string; proof: { url: string; [key: string]: unknown } };
type Options = { client?: Pick<SupabaseClient, "rpc">; now?: () => number; maxRpcMs?: number };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function fail(code: string): never { throw new Error(code); }
function row(value: unknown): Row { if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_GALLERY_RESPONSE_INVALID"); return value as Row; }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value); }
function uuid(value: unknown): asserts value is string { if (typeof value !== "string" || !UUID.test(value)) fail("MEDIA_GALLERY_ID_INVALID"); }
function identity(id: MediaIdentity) { mediaSnapshotFingerprint({ identity: id, side: "gallery", complete: true, revision: "identity", assets: [] }); }
function same(a: unknown, b: unknown): boolean {
  const stable = (x: unknown): string => Array.isArray(x) ? `[${x.map(stable).join(",")}]` : x && typeof x === "object"
    ? `{${Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}` : JSON.stringify(x);
  return stable(a) === stable(b);
}
/** PostgreSQL error classes that are only returned after the server rolled the
 * statement's transaction back. Anything else (no SQLSTATE, gateway/PostgREST
 * codes, timeouts, aborted or unparsable responses) is an UNKNOWN outcome. */
const ROLLED_BACK: Record<string, string> = { "55P03": "MEDIA_GALLERY_CAS_LOCK_TIMEOUT", "57014": "MEDIA_GALLERY_CAS_STATEMENT_CANCELED",
  "40001": "MEDIA_GALLERY_CAS_SERIALIZATION_FAILURE", "40P01": "MEDIA_GALLERY_CAS_DEADLOCK", "23505": "MEDIA_GALLERY_CAS_UNIQUE_VIOLATION" };
const REJECTED = Symbol("galleryCasRejected");
/** Exact reason when the database definitively rejected (and rolled back) the
 * call; null when the outcome is unknown and only the commit receipt decides. */
export function galleryCasRejection(error: unknown): string | null {
  const value = error && typeof error === "object" ? (error as { [REJECTED]?: unknown })[REJECTED] : undefined;
  return typeof value === "string" ? value : null;
}
function rejection(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = "code" in error ? String(error.code) : "", message = "message" in error ? String(error.message) : "";
  if (code === "P0001") return /^(MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(message) ? message : "MEDIA_GALLERY_CAS_SQL_REJECTED";
  return Object.hasOwn(ROLLED_BACK, code) ? ROLLED_BACK[code] : null;
}
function cloned<T>(x: T): T { const encoded = JSON.stringify(x); if (!encoded || Buffer.byteLength(encoded) > 2_000_000) fail("MEDIA_GALLERY_RESPONSE_TOO_LARGE"); return JSON.parse(encoded) as T; }
function safeImageUrl(value: unknown): value is string {
  if (!text(value, 4096) || /[\s\\#]/.test(value)) return false;
  try { const u = new URL(value); return u.protocol === "https:" && !u.port && !u.username && !u.password && !/%(?:2e|2f|5c)/i.test(u.pathname) &&
    ((u.hostname === "cdn.shopify.com" && u.pathname.startsWith("/s/files/")) ||
      (u.hostname === "ekgpaoavsavrtbhlbwdg.supabase.co" && u.pathname.startsWith("/storage/v1/object/public/carousel-media/"))); } catch { return false; }
}
/** A raw DB observation, not decoded-image evidence or a write permit. SQL owns its opaque revision. */
export function parseGalleryMediaRaw(input: unknown, expected: MediaIdentity): GalleryMediaRaw {
  identity(expected); const value = row(cloned(input)), item = row(value.item);
  if (!same(value.identity, expected) || item.id !== expected.itemId || item.catalog_number !== expected.exactGallerySku || item.is_active !== true ||
      !text(item.title, 512) || !safeImageUrl(item.cover_image_path) || !(item.cover_image_alt === null || text(item.cover_image_alt, 512)) ||
      !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.revision !== "string" || !HASH.test(value.revision) ||
      !Array.isArray(value.angles) || value.angles.length > 30) fail("MEDIA_GALLERY_RAW_INVALID");
  const ids = new Set<string>(); let previous: { order: number; id: string } | null = null;
  for (const entry of value.angles) {
    const angle = row(entry); uuid(angle.id);
    if (ids.has(angle.id) || angle.item_id !== expected.itemId || !text(angle.angle_key, 32) || !angle.angle_key || !safeImageUrl(angle.image_path) ||
        !(angle.image_alt === null || text(angle.image_alt, 512)) || !Number.isInteger(angle.angle_order) || Number(angle.angle_order) < 1 || Number(angle.angle_order) > 50 ||
        (previous && (Number(angle.angle_order) < previous.order || (angle.angle_order === previous.order && angle.id < previous.id)))) fail("MEDIA_GALLERY_RAW_INVALID");
    ids.add(angle.id); previous = { order: Number(angle.angle_order), id: angle.id };
  }
  return value as GalleryMediaRaw;
}
function refsFor(raw: GalleryMediaRaw, input: unknown): GalleryMediaRef[] {
  if (!Array.isArray(input) || input.length !== raw.angles.length + 1) fail("MEDIA_GALLERY_REFERENCES_INCOMPLETE");
  return input.map((x, n) => { const r = row(x);
    if (Object.keys(r).sort().join() !== "angleId,evidenceId,key,role" || !KEY.test(String(r.key)) || !KEY.test(String(r.evidenceId)) ||
        (n === 0 ? r.role !== "cover" || r.angleId !== null : r.role !== "angle" || r.angleId !== raw.angles[n - 1].id)) fail("MEDIA_GALLERY_REFERENCE_INVALID");
    return structuredClone(r) as GalleryMediaRef;
  });
}
/** Bootstrap/read mapper. Proofs must be decoded and server-owned before registration.
 * This function never invents cross-system keys from filenames, URLs or positions. */
export function galleryRawToSnapshot(input: GalleryMediaRaw, inputRefs: GalleryMediaRef[], proofs: GalleryMediaProvenance[]): MediaSnapshot {
  const raw = parseGalleryMediaRaw(input, input.identity), refs = refsFor(raw, inputRefs);
  if (!Array.isArray(proofs) || proofs.length > 500) fail("MEDIA_GALLERY_PROVENANCE_MISMATCH");
  const mapped = refs.map((ref, n) => {
    const matches = proofs.filter(p => p.evidenceId === ref.evidenceId && p.key === ref.key && p.side === "gallery");
    const p = matches[0], path = n === 0 ? raw.item.cover_image_path : raw.angles[n - 1].image_path;
    if (matches.length !== 1 || !HASH.test(p.contentId) || p.proof?.url !== path) fail("MEDIA_GALLERY_PROVENANCE_MISMATCH");
    return { key: ref.key, contentId: p.contentId, evidenceId: ref.evidenceId,
      alt: (n === 0 ? raw.item.cover_image_alt : raw.angles[n - 1].image_alt) ?? raw.item.title };
  });
  const [cover, ...angles] = mapped;
  if (new Set(angles.map(a => a.key)).size !== angles.length) fail("MEDIA_GALLERY_DUPLICATE_ANGLE_KEY");
  const alias = angles.find(a => a.key === cover.key);
  if (alias && !same(alias, cover)) fail("MEDIA_GALLERY_COVER_ALIAS_CONFLICT");
  const snapshot: MediaSnapshot = { identity: structuredClone(raw.identity), side: "gallery", complete: true, revision: raw.revision, assets: alias ? angles : [cover, ...angles] };
  mediaSnapshotFingerprint(snapshot); return snapshot;
}
function observation(value: unknown, expected: MediaIdentity): GalleryMediaObservation {
  const r = row(value), raw = parseGalleryMediaRaw(r.raw, expected), refs = refsFor(raw, r.refs), snapshot = cloned(r.snapshot) as MediaSnapshot;
  mediaSnapshotFingerprint(snapshot);
  if (snapshot.side !== "gallery" || !same(snapshot.identity, expected) || snapshot.revision !== raw.revision ||
      new Set(refs.map(r => r.key)).size !== snapshot.assets.length || snapshot.assets.some(a => !refs.some(r => r.key === a.key && r.evidenceId === a.evidenceId))) fail("MEDIA_GALLERY_OBSERVATION_INVALID");
  return { raw, refs, snapshot };
}
export function buildGalleryMediaCasIntent(expectedRevision: string, desiredSemanticSha256: string) {
  if (!HASH.test(expectedRevision) || !HASH.test(desiredSemanticSha256)) fail("MEDIA_GALLERY_REQUEST_INVALID");
  return { mutationSha256: createHash("sha256").update(JSON.stringify(["apply_toptik_gallery_media_cas/v1", expectedRevision, desiredSemanticSha256])).digest("hex"), expectedRevision, desiredSemanticSha256 };
}

/** Service-only; no generic table mutation. Uploads use media-storage-transport
 * after gallery_upload permission. This port handles only exact atomic DB CAS. */
export function createGalleryMediaTransport(expected: MediaIdentity, options: Options = {}) {
  identity(expected); const id = structuredClone(expected), now = options.now ?? Date.now, maxMs = options.maxRpcMs ?? 5000;
  if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 10_000) fail("MEDIA_GALLERY_OPTIONS_INVALID");
  let client = options.client;
  async function call(name: string, args: Row, deadline: number) {
    const ms = Math.min(maxMs, deadline - now()); if (!Number.isFinite(deadline) || ms <= 0) fail("MEDIA_GALLERY_TIME_BUDGET");
    const frozen = cloned(args), controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, answered: unknown = null;
    try {
      client ??= createSupabaseServiceRoleClient();
      const q = client.rpc(name, frozen), response = await Promise.race([Promise.resolve(q.abortSignal(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("MEDIA_GALLERY_TIME_BUDGET")); }, ms);
      })]);
      if (now() >= deadline) fail("MEDIA_GALLERY_TIME_BUDGET");
      if (response?.error) { answered = response.error; throw response.error; }
      if (!response) fail("MEDIA_GALLERY_RESPONSE_INVALID"); return cloned(response.data);
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
      const masked = new Error(/^(MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(message) ? message : "MEDIA_GALLERY_RPC_FAILED");
      // Only an error object the server actually returned can prove a rollback.
      const reason = answered === error ? rejection(error) : null;
      if (reason) Object.defineProperty(masked, REJECTED, { value: reason });
      throw masked;
    }
    finally { if (timer) clearTimeout(timer); }
  }
  const args = (owner: string) => { uuid(owner); return { p_product_gid: id.productId, p_lease_owner: owner }; };
  const reference = (ref: MediaTransportReference) => { uuid(ref.operationId); if (!Number.isInteger(ref.step) || ref.step < 0 || ref.step > 1000 || !Number.isInteger(ref.phaseIndex) || ref.phaseIndex < 0 || ref.phaseIndex > 10) fail("MEDIA_TRANSPORT_REFERENCE_INVALID");
    return { p_operation_id: ref.operationId, p_step_index: ref.step, p_phase_index: ref.phaseIndex }; };
  return {
    async snapshot(deadline: number) {
      const result = await call("read_toptik_gallery_media_snapshot", { p_product_gid: id.productId }, deadline) as MediaSnapshot;
      mediaSnapshotFingerprint(result); if (result.side !== "gallery" || !same(result.identity, id)) fail("MEDIA_GALLERY_IDENTITY_CHANGED"); return result;
    },
    async read(owner: string, deadline: number) { return parseGalleryMediaRaw(await call("read_toptik_gallery_media", args(owner), deadline), id); },
    async observe(owner: string, raw: GalleryMediaRaw, refs: GalleryMediaRef[], deadline: number) {
      const checked = parseGalleryMediaRaw(raw, id); refsFor(checked, refs);
      const value = observation(await call("observe_toptik_gallery_media", { ...args(owner), p_expected_revision: checked.revision, p_refs: refs }, deadline), id);
      if (!same(value.raw, checked) || !same(value.refs, refs)) fail("MEDIA_GALLERY_OBSERVATION_INVALID"); return value;
    },
    async apply(ref: MediaTransportReference, owner: string, attemptId: string, requestId: string, requestHash: string, guard: MediaRpcGuard, deadline: number) {
      uuid(attemptId); uuid(requestId); if (!HASH.test(requestHash) || !guard || !HASH.test(guard.sourceFingerprint) || guard.target.side !== "gallery" ||
          !same(guard.target.identity, id) || !Number.isFinite(Date.parse(guard.observedAt)) || Date.parse(guard.observedAt) < now() - 30_000 || Date.parse(guard.observedAt) > now() + 5000) fail("MEDIA_GALLERY_GUARD_INVALID");
      mediaSnapshotFingerprint(guard.target as MediaSnapshot);
      if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") fail("MEDIA_GALLERY_DISABLED");
      const result = row(await call("apply_toptik_gallery_media_cas", { ...args(owner), ...reference(ref), p_attempt_id: attemptId, p_request_id: requestId, p_request_hash: requestHash, p_fresh_guard: guard }, deadline));
      if (result.applied !== true || typeof result.replayed !== "boolean") fail("MEDIA_GALLERY_RESPONSE_INVALID");
      return { ...observation(result, id), applied: true as const, replayed: result.replayed };
    },
    async recover(ref: MediaTransportReference, owner: string, deadline: number) {
      const result = await call("read_toptik_gallery_media_commit", { ...args(owner), ...reference(ref) }, deadline); if (result === null) return null;
      const r = row(result); if (r.applied !== true || typeof r.readbackMatches !== "boolean") fail("MEDIA_GALLERY_RESPONSE_INVALID"); uuid(r.requestId); uuid(r.attemptId);
      if (!HASH.test(String(r.requestHash))) fail("MEDIA_GALLERY_RESPONSE_INVALID");
      const saved = observation(r, id), currentRaw = parseGalleryMediaRaw(r.currentRaw, id);
      if (r.readbackMatches !== same(currentRaw, saved.raw)) fail("MEDIA_GALLERY_RECOVERY_INVALID");
      return { ...saved, currentRaw, readbackMatches: r.readbackMatches, requestId: r.requestId, attemptId: r.attemptId, requestHash: String(r.requestHash) };
    },
  };
}

/** Read-only, no lease acquisition and no provenance creation during observation. */
export async function readGalleryMediaSnapshot(identity: MediaIdentity, deadline: number, options: Options = {}): Promise<MediaSnapshot> {
  return createGalleryMediaTransport(identity, options).snapshot(deadline);
}
