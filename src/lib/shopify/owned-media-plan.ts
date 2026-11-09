import { createHash } from "node:crypto";
import { assertGroupMediaBinding, assertGroupMediaReady, groupMediaFingerprint, type GroupMediaBinding, type GroupMediaSnapshot } from "./group-media-policy";
import { FZT73_PRODUCT_GID, FZT73_PRODUCT_HANDLE, FZT73_VARIANTS, MD20_PRODUCT_GID, MD20_PRODUCT_HANDLE, MD20_VARIANTS } from "./variant-source-policy";

export type OwnedMediaManifest = { schemaVersion: 1; productGid: string; handle: string; globalOrder: string[];
  variants: { itemId: string; variantGid: string; sku: string; orderedMediaIds: string[]; coverMediaId: string }[];
  /** Explicit reviewed exclusions, not a guess that an unassigned photo belongs to a color. */
  ignoredMediaIds: string[] };
export type OwnedMediaCommand = { requestId: string; itemId: string; expectedMapVersion: number; expectedSourceFingerprint: string;
  desiredImages: { mediaId: string | null; uploadUrl?: string; alt: string }[];
  assignments?: { mediaId: string; itemIds: string[] }[] };
export type OwnedMediaPlan = { schemaVersion: 1; requestId: string; itemId: string; beforeFingerprint: string;
  beforeManifest: OwnedMediaManifest; desiredManifest: OwnedMediaManifest;
  uploads: { key: string; uploadUrl: string; alt: string }[];
  removedReferences: { itemId: string; variantGid: string; mediaId: string }[];
  addedReferences: { itemId: string; variantGid: string; mediaId: string }[];
  productDetachMediaIds: string[]; protectedMediaIds: string[]; impactedItemIds: string[]; noop: boolean };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MEDIA = /^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/;
function fail(code: string): never { throw new Error(code); }
export function stableOwnedMedia(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableOwnedMedia).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k,v]) => `${JSON.stringify(k)}:${stableOwnedMedia(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const ownedMediaHash = (value: unknown) => createHash("sha256").update(stableOwnedMedia(value)).digest("hex");
const equal = (a: unknown,b: unknown) => stableOwnedMedia(a) === stableOwnedMedia(b);
const unique = (values: string[]) => new Set(values).size === values.length;
export function ownedMediaBinding(productGid: string): GroupMediaBinding | null {
  const rows = productGid === FZT73_PRODUCT_GID ? FZT73_VARIANTS : productGid === MD20_PRODUCT_GID ? MD20_VARIANTS : null;
  if (!rows) return null;
  return { productGid, handle: productGid === FZT73_PRODUCT_GID ? FZT73_PRODUCT_HANDLE : MD20_PRODUCT_HANDLE,
    variants: rows.map(v => ({ itemId:v.itemId,variantGid:`gid://shopify/ProductVariant/${v.variantId}`,sku:v.sku })) };
}
export function assertOwnedMediaSource(binding: GroupMediaBinding, source: GroupMediaSnapshot): void {
  assertGroupMediaBinding(binding); assertGroupMediaReady(source);
  const { fingerprint, ...rest } = source;
  if (!equal(binding,source.binding) || groupMediaFingerprint(rest) !== fingerprint) fail("OWNED_MEDIA_SOURCE_INVALID");
}
/** Pure exact-identity map. No filename, ALT token, dimension or color-label inference. */
export function assertOwnedMediaManifest(binding: GroupMediaBinding, source: GroupMediaSnapshot, manifest: OwnedMediaManifest, options: {allowUnassigned?:boolean} = {}): void {
  assertOwnedMediaSource(binding,source);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.productGid !== binding.productGid || manifest.handle !== binding.handle ||
      !equal(manifest.globalOrder,source.media.map(m => m.mediaId)) || !Array.isArray(manifest.variants) ||
      manifest.variants.length !== binding.variants.length || !Array.isArray(manifest.ignoredMediaIds) || !unique(manifest.ignoredMediaIds) ||
      !unique(manifest.variants.map(v => v.itemId))) fail("OWNED_MEDIA_MANIFEST_INVALID");
  const assigned = new Set<string>();
  for (const bound of binding.variants) {
    const row = manifest.variants.find(v => v.itemId === bound.itemId);
    if (!row || row.variantGid !== bound.variantGid || row.sku !== bound.sku || !Array.isArray(row.orderedMediaIds) ||
        !row.orderedMediaIds.length || row.orderedMediaIds.length > 20 || !unique(row.orderedMediaIds) ||
        !row.orderedMediaIds.includes(row.coverMediaId) || row.orderedMediaIds.some(id => !MEDIA.test(id) || !manifest.globalOrder.includes(id))) {
      fail("OWNED_MEDIA_MANIFEST_INVALID");
    }
    row.orderedMediaIds.forEach(id => assigned.add(id));
  }
  if (manifest.ignoredMediaIds.some(id => !manifest.globalOrder.includes(id) || assigned.has(id)) ||
      (!options.allowUnassigned && manifest.globalOrder.some(id => !assigned.has(id) && !manifest.ignoredMediaIds.includes(id)))) fail("OWNED_MEDIA_UNASSIGNED_REVIEW_REQUIRED");
}
/** Observation is not adoption. Exact native associations may extend a map; unknown photos stay visible for review. */
export function planOwnedMediaObservation(previous: GroupMediaSnapshot, manifest: OwnedMediaManifest, source: GroupMediaSnapshot) {
  assertOwnedMediaManifest(previous.binding,previous,manifest); assertOwnedMediaSource(previous.binding,source);
  const globalOrder=source.media.map(m=>m.mediaId), previousIds=new Set(previous.media.map(m=>m.mediaId));
  const candidateManifest=structuredClone(manifest); candidateManifest.globalOrder=globalOrder;
  candidateManifest.ignoredMediaIds=manifest.ignoredMediaIds.filter(id=>globalOrder.includes(id));
  for(const row of candidateManifest.variants){
    const oldNative=previous.variants.find(v=>v.variantGid===row.variantGid)!, native=source.variants.find(v=>v.variantGid===row.variantGid)!;
    const oldIds=new Set(oldNative.mediaIds), nextIds=new Set(native.mediaIds);
    const ids=row.orderedMediaIds.filter(id=>globalOrder.includes(id)&&(!oldIds.has(id)||nextIds.has(id)));
    for(const id of native.mediaIds)if(!oldIds.has(id)&&!ids.includes(id)&&!candidateManifest.ignoredMediaIds.includes(id))ids.push(id);
    row.orderedMediaIds=globalOrder.filter(id=>ids.includes(id));
    if(!row.orderedMediaIds.length)fail("OWNED_MEDIA_LAST_IMAGE_REQUIRED");
    const nativeCover=source.media.find(m=>m.image?.url===native.image?.url)?.mediaId;
    if(nativeCover&&row.orderedMediaIds.includes(nativeCover)&&native.image?.url!==oldNative.image?.url)row.coverMediaId=nativeCover;
    if(!row.orderedMediaIds.includes(row.coverMediaId))row.coverMediaId=row.orderedMediaIds[0];
  }
  const assigned=new Set(candidateManifest.variants.flatMap(v=>v.orderedMediaIds));
  candidateManifest.ignoredMediaIds=candidateManifest.ignoredMediaIds.filter(id=>!assigned.has(id));
  const unassigned=source.media.filter(m=>!assigned.has(m.mediaId)&&!candidateManifest.ignoredMediaIds.includes(m.mediaId));
  assertOwnedMediaManifest(source.binding,source,candidateManifest,{allowUnassigned:true});
  return {candidateManifest,unassigned,addedMediaIds:globalOrder.filter(id=>!previousIds.has(id))};
}
export function ownedMediaProjection(source: GroupMediaSnapshot, manifest: OwnedMediaManifest, itemId: string) {
  assertOwnedMediaManifest(source.binding,source,manifest);
  const row = manifest.variants.find(v => v.itemId === itemId);
  if (!row) fail("OWNED_MEDIA_ITEM_UNKNOWN");
  const image = (id: string) => source.media.find(m => m.mediaId === id)!;
  return { cover_image_path: image(row.coverMediaId).image!.url, cover_image_alt: image(row.coverMediaId).alt?.trim() || null,
    angles: row.orderedMediaIds.map((id,i) => ({ angle_key:String(i+1),angle_order:i+1,image_path:image(id).image!.url,image_alt:image(id).alt?.trim() || null })) };
}
function upload(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const u = new URL(value); return u.origin === "https://ekgpaoavsavrtbhlbwdg.supabase.co" && !u.username && !u.password && !u.hash &&
    u.pathname.startsWith("/storage/v1/object/public/carousel-media/") && !/%(?:2f|5c|2e)/i.test(u.pathname); } catch { return false; }
}
/** Intent only. Upload URLs still need server decode/provenance before any native request is reserved. */
export function planOwnedMediaChange(source: GroupMediaSnapshot, manifest: OwnedMediaManifest, command: OwnedMediaCommand): OwnedMediaPlan {
  assertOwnedMediaManifest(source.binding,source,manifest,{allowUnassigned:true});
  if (!command || !UUID.test(command.requestId) || !Number.isSafeInteger(command.expectedMapVersion) || command.expectedMapVersion < 1 ||
      !HASH.test(command.expectedSourceFingerprint) || command.expectedSourceFingerprint !== source.fingerprint ||
      !Array.isArray(command.desiredImages) || !command.desiredImages.length || command.desiredImages.length > 20) fail("OWNED_MEDIA_COMMAND_INVALID");
  const current = manifest.variants.find(v => v.itemId === command.itemId);
  if (!current) fail("OWNED_MEDIA_ITEM_UNKNOWN");
  const desired = structuredClone(manifest), target = desired.variants.find(v => v.itemId === command.itemId)!;
  const uploads: OwnedMediaPlan["uploads"] = [];
  const ids = command.desiredImages.map((image,i) => {
    if (!image || typeof image.alt !== "string" || image.alt !== image.alt.trim() || image.alt.length > 512 || /[\u0000-\u001f\u007f]/.test(image.alt)) fail("OWNED_MEDIA_ALT_INVALID");
    if (image.mediaId !== null) {
      const existing = source.media.find(m => m.mediaId === image.mediaId);
      if (!existing || image.uploadUrl !== undefined) fail("OWNED_MEDIA_COMMAND_INVALID");
      if ((existing.alt?.trim() || "") !== image.alt) fail("OWNED_MEDIA_ALT_REQUIRES_COPY_EDITOR");
      return image.mediaId;
    }
    if (!image.alt || !upload(image.uploadUrl)) fail("OWNED_MEDIA_UPLOAD_INVALID");
    const key = `upload:${command.requestId}:${i}`;
    uploads.push({key,uploadUrl:image.uploadUrl,alt:image.alt}); return key;
  });
  if (!unique(ids) || new Set(uploads.map(u => u.uploadUrl)).size !== uploads.length) fail("OWNED_MEDIA_DUPLICATE_IMAGE");
  const assigned = new Set<string>();
  for (const assignment of command.assignments ?? []) {
    if (!assignment || !MEDIA.test(assignment.mediaId) || !source.media.some(m => m.mediaId === assignment.mediaId) || assigned.has(assignment.mediaId) ||
        !Array.isArray(assignment.itemIds) || !unique(assignment.itemIds) || assignment.itemIds.some(id => !source.binding.variants.some(v => v.itemId === id))) fail("OWNED_MEDIA_ASSIGNMENT_INVALID");
    assigned.add(assignment.mediaId);
    if(assignment.itemIds.includes(command.itemId)!==ids.includes(assignment.mediaId))fail("OWNED_MEDIA_TARGET_ASSIGNMENT_CONFLICT");
    if(!assignment.itemIds.length&&!manifest.ignoredMediaIds.includes(assignment.mediaId))fail("OWNED_MEDIA_UNASSIGNED_REVIEW_REQUIRED");
    for (const row of desired.variants) {
      const has = assignment.itemIds.includes(row.itemId), present = row.orderedMediaIds.includes(assignment.mediaId);
      if (has && !present) row.orderedMediaIds.push(assignment.mediaId);
      if (!has && present) row.orderedMediaIds = row.orderedMediaIds.filter(id => id !== assignment.mediaId);
      if (!row.orderedMediaIds.includes(row.coverMediaId)) row.coverMediaId = row.orderedMediaIds[0];
    }
    desired.ignoredMediaIds = desired.ignoredMediaIds.filter(id => id !== assignment.mediaId);
  }
  target.orderedMediaIds = ids; target.coverMediaId = ids[0];
  if (desired.variants.some(v => !v.orderedMediaIds.length || v.orderedMediaIds.length > 20)) fail("OWNED_MEDIA_LAST_IMAGE_REQUIRED");
  const bound = new Set(source.binding.variants.map(v => v.variantGid));
  const nativeProtected = source.variants.filter(v => !bound.has(v.variantGid)).flatMap(v => [...v.mediaIds,...source.media.filter(m => m.image?.id === v.image?.id).map(m => m.mediaId)]);
  const removedReferences = manifest.variants.flatMap(v => v.orderedMediaIds.filter(id => !desired.variants.find(d => d.itemId === v.itemId)!.orderedMediaIds.includes(id))
    .map(mediaId => ({itemId:v.itemId,variantGid:v.variantGid,mediaId})));
  const addedReferences = desired.variants.flatMap(v => v.orderedMediaIds.filter(id => !manifest.variants.find(d => d.itemId === v.itemId)!.orderedMediaIds.includes(id))
    .map(mediaId => ({itemId:v.itemId,variantGid:v.variantGid,mediaId})));
  const used = new Set(desired.variants.flatMap(v => v.orderedMediaIds));
  const productDetachMediaIds = [...new Set(removedReferences.map(r => r.mediaId))].filter(id => !used.has(id) && !nativeProtected.includes(id) && !manifest.ignoredMediaIds.includes(id));
  for (const id of manifest.globalOrder) if (!used.has(id) && !productDetachMediaIds.includes(id) && !desired.ignoredMediaIds.includes(id) && manifest.variants.some(v=>v.orderedMediaIds.includes(id))) desired.ignoredMediaIds.push(id);
  desired.ignoredMediaIds = desired.ignoredMediaIds.filter(id => !used.has(id));
  if(manifest.globalOrder.some(id=>!used.has(id)&&!productDetachMediaIds.includes(id)&&!desired.ignoredMediaIds.includes(id)))fail("OWNED_MEDIA_UNASSIGNED_REVIEW_REQUIRED");
  // Move the explicit target sequence as a block; every non-target photo keeps its relative order.
  const touched = new Set([...current.orderedMediaIds,...ids]);
  const first = manifest.globalOrder.findIndex(id => touched.has(id));
  const untouched = manifest.globalOrder.filter(id => !touched.has(id) && !productDetachMediaIds.includes(id));
  const anchor = manifest.globalOrder.slice(0,Math.max(0,first)).filter(id => !touched.has(id) && !productDetachMediaIds.includes(id)).length;
  const remainingTouched = manifest.globalOrder.filter(id => touched.has(id) && !ids.includes(id) && !productDetachMediaIds.includes(id));
  desired.globalOrder = [...untouched.slice(0,anchor),...ids,...remainingTouched,...untouched.slice(anchor)];
  for(const row of desired.variants.filter(v=>v.itemId!==command.itemId)){
    const protectedIds=new Set(row.orderedMediaIds);
    if(!equal(manifest.globalOrder.filter(id=>protectedIds.has(id)),desired.globalOrder.filter(id=>protectedIds.has(id))))fail("OWNED_MEDIA_SHARED_ORDER_REVIEW_REQUIRED");
  }
  for(const native of source.variants.filter(v=>!bound.has(v.variantGid))){
    if(!equal(manifest.globalOrder.filter(id=>native.mediaIds.includes(id)),desired.globalOrder.filter(id=>native.mediaIds.includes(id))))fail("OWNED_MEDIA_SHARED_ORDER_REVIEW_REQUIRED");
  }
  const impactedItemIds = desired.variants.filter(v => !equal(v,manifest.variants.find(b => b.itemId === v.itemId))).map(v => v.itemId);
  return {schemaVersion:1,requestId:command.requestId,itemId:command.itemId,beforeFingerprint:source.fingerprint,beforeManifest:structuredClone(manifest),desiredManifest:desired,
    uploads,removedReferences,addedReferences,productDetachMediaIds,protectedMediaIds:[...new Set([...nativeProtected,...desired.ignoredMediaIds,...desired.variants.filter(v=>v.itemId!==command.itemId).flatMap(v=>v.orderedMediaIds)])],
    impactedItemIds,noop:!uploads.length && equal(desired,manifest)};
}
export function resolveOwnedMediaPlan(plan: OwnedMediaPlan, created: Record<string,string>, fresh: GroupMediaSnapshot): OwnedMediaManifest {
  const replace = (id: string) => id.startsWith("upload:") ? created[id] ?? fail("OWNED_MEDIA_UPLOAD_RECEIPT_REQUIRED") : id;
  if (Object.keys(created).length !== plan.uploads.length || !unique(Object.values(created)) || plan.uploads.some(u => !MEDIA.test(created[u.key] ?? ""))) fail("OWNED_MEDIA_UPLOAD_RECEIPT_REQUIRED");
  const manifest: OwnedMediaManifest = {...structuredClone(plan.desiredManifest),globalOrder:plan.desiredManifest.globalOrder.map(replace),
    variants:plan.desiredManifest.variants.map(v=>({...v,orderedMediaIds:v.orderedMediaIds.map(replace),coverMediaId:replace(v.coverMediaId)}))};
  assertOwnedMediaManifest(fresh.binding,fresh,manifest); return manifest;
}
