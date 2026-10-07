import { createHash } from "node:crypto";

/** Pure reconciliation only. Network adapters must enforce ownership, leases and readback. */
export type MediaSide = "gallery" | "shopify";
export type MediaIdentity = {
  productId: string; variantId: string; itemId: string;
  exactGallerySku: string; exactShopifySku: string; productHandle: string;
};
export type MediaAsset = {
  /** Server-owned immutable cross-system mapping; never a filename/array index. */
  key: string;
  /** Original decoded bytes digest or an explicit import-receipt lineage digest. */
  contentId: string;
  alt: string;
  /** The server adapter retains the original URL, decode evidence and platform IDs privately. */
  evidenceId: string;
};
export type MediaSnapshot = {
  identity: MediaIdentity; side: MediaSide; revision: string;
  complete: true; assets: MediaAsset[];
};
export type MediaPair = Record<MediaSide, MediaSnapshot>;
export type RemovalEvidence = {
  side: MediaSide; key: string; requestId: string;
  kind: "authenticated_editor" | "signed_shopify_event";
  expectedBaselineFingerprint: string;
};
/** Trusted private journal/readback only; never accepted from editor/browser JSON. */
export type DetachReceipt = {
  source: MediaSide; target: MediaSide; key: string; operationId: string; sourceIntentId: string;
  sourceBaselineFingerprint: string; targetBaselineFingerprint: string; targetAbsentReadbackRevision: string;
};
export type MediaConflict = { key: string; field: "membership" | "content" | "alt" | "order"; code: string };
export type MediaPatch = { source: MediaSide; target: MediaSide; key: string } & (
  { kind: "attach"; value: MediaAsset } | { kind: "detach_reference" } |
  { kind: "replace_reference"; value: Pick<MediaAsset, "contentId" | "evidenceId"> } |
  { kind: "alt"; value: string }
);
export type MediaPlan = {
  identity: MediaIdentity;
  preconditions: Record<MediaSide, { revision: string; fingerprint: string }>;
  patches: MediaPatch[];
  orders: Array<{ target: MediaSide; keys: string[] }>;
  conflicts: MediaConflict[];
  /** Baselines may advance only after adapters verify actual readback, never from this projection. */
  projected: Record<MediaSide, MediaAsset[]>;
};

const SIDES: MediaSide[] = ["gallery", "shopify"];
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_ASSETS = 250;
function fail(code: string): never { throw new Error(code); }
function other(side: MediaSide): MediaSide { return side === "gallery" ? "shopify" : "gallery"; }
function clone<T>(value: T): T { return structuredClone(value); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function identityTuple(value: MediaIdentity) {
  return [value.productId, value.variantId, value.itemId, value.exactGallerySku, value.exactShopifySku, value.productHandle];
}
function assertIdentity(value: MediaIdentity) {
  if (!value || !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(value.productId) ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(value.variantId) || !UUID.test(value.itemId) ||
      [value.exactGallerySku, value.exactShopifySku, value.productHandle].some(x => typeof x !== "string" || !x.trim() || x !== x.trim() || x.length > 255)) {
    fail("MEDIA_IDENTITY_INVALID");
  }
}
function assertSnapshot(snapshot: MediaSnapshot, side: MediaSide, identity: MediaIdentity) {
  if (!snapshot || snapshot.side !== side || snapshot.complete !== true || typeof snapshot.revision !== "string" ||
      !snapshot.revision.trim() || snapshot.revision.length > 512) fail("MEDIA_COMPLETE_SNAPSHOT_REQUIRED");
  assertIdentity(snapshot.identity);
  if (!same(identityTuple(snapshot.identity), identityTuple(identity))) fail("MEDIA_IDENTITY_DRIFT");
  if (!Array.isArray(snapshot.assets) || snapshot.assets.length > MAX_ASSETS) fail("MEDIA_ASSET_LIMIT");
  const keys = new Set<string>();
  for (const asset of snapshot.assets) {
    if (!asset || typeof asset.key !== "string" || !KEY.test(asset.key) || keys.has(asset.key) ||
        typeof asset.contentId !== "string" || !HASH.test(asset.contentId) || typeof asset.alt !== "string" ||
        asset.alt.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(asset.alt) ||
        typeof asset.evidenceId !== "string" || !KEY.test(asset.evidenceId)) fail("MEDIA_ASSET_INVALID");
    keys.add(asset.key);
  }
}
function assetMap(snapshot: MediaSnapshot): Map<string, MediaAsset> { return new Map(snapshot.assets.map(a => [a.key, a])); }
function semantic(asset: MediaAsset | undefined) { return asset ? [asset.contentId, asset.alt] : null; }
export function mediaSnapshotFingerprint(snapshot: MediaSnapshot): string {
  assertSnapshot(snapshot, snapshot.side, snapshot.identity);
  return createHash("sha256").update(JSON.stringify({ identity: identityTuple(snapshot.identity), side: snapshot.side,
    revision: snapshot.revision, assets: snapshot.assets.map(a => [a.key, a.contentId, a.alt, a.evidenceId]) })).digest("hex");
}

/** Preserve target-only images in their relative order while inserting at unambiguous source anchors. */
function insertionIndex(target: MediaAsset[], source: MediaAsset[], key: string): number | null {
  const position = source.findIndex(a => a.key === key);
  const targetKeys = target.map(a => a.key);
  const before = source.slice(0, position).reverse().find(a => targetKeys.includes(a.key));
  const after = source.slice(position + 1).find(a => targetKeys.includes(a.key));
  const left = before ? targetKeys.indexOf(before.key) : -1;
  const right = after ? targetKeys.indexOf(after.key) : target.length;
  if (left >= right) return null;
  return after ? right : left + 1;
}

function repositioned(baseline: MediaSnapshot, current: MediaSnapshot, key: string): boolean {
  const oldKeys = baseline.assets.map(a => a.key), newKeys = current.assets.map(a => a.key);
  const oldIndex = oldKeys.indexOf(key), newIndex = newKeys.indexOf(key);
  if (oldIndex < 0 || newIndex < 0) return false;
  return oldKeys.some((candidate, index) => candidate !== key && newKeys.includes(candidate) &&
    (index < oldIndex) !== (newKeys.indexOf(candidate) < newIndex));
}

/** A side-local ALT edit on an existing INDEPENDENT image (no counterpart on the
 * other side, ever, under this key or by content). Everything except ALT must be
 * byte-for-byte unchanged and the image must keep its place. This is a local
 * acknowledgement only: it creates no patch, no counterpart and no mapping, and
 * the baseline still advances only through the ordinary reserved operation and
 * a fresh verified readback commit. Any doubt keeps MEDIA_TARGET_MAPPING_REQUIRED. */
function independentLocalAlt(baseline: MediaPair, current: MediaPair, source: MediaSide, key: string, removalKeys: ReadonlySet<string>): boolean {
  const target = other(source);
  const before = baseline[source].assets.find(a => a.key === key), now = current[source].assets.find(a => a.key === key);
  if (!before || !now || before.alt === now.alt) return false;
  // Field-by-field: key, content and source evidence are unchanged, and no other field exists (order-independent).
  const fields = (a: MediaAsset) => Object.keys(a).sort().join(",");
  if (fields(before) !== "alt,contentId,evidenceId,key" || fields(now) !== fields(before) ||
      before.key !== now.key || before.contentId !== now.contentId || before.evidenceId !== now.evidenceId) return false;
  // Never on the other side, before or now; no removal/detach history for this key on either side.
  if ([baseline[target], current[target]].some(s => s.assets.some(a => a.key === key)) ||
      SIDES.some(side => removalKeys.has(`${side}:${key}`))) return false;
  // No possible counterpart or alternate key: the same bytes or source proof under any other key, on either side.
  // Only exception: a same-side duplicate that existed in this side's baseline alone, was removed with explicit
  // removal evidence, and is gone from every current snapshot (e.g. a deleted duplicate angle). It is history,
  // not a counterpart; a twin that still exists anywhere, or one removed without evidence, keeps the hold.
  const removedDuplicate = (snapshot: MediaSnapshot, a: MediaAsset) => snapshot === baseline[source] &&
    removalKeys.has(`${source}:${a.key}`) && !baseline[target].assets.some(x => x.key === a.key) &&
    !current.gallery.assets.some(x => x.key === a.key) && !current.shopify.assets.some(x => x.key === a.key);
  for (const snapshot of [baseline.gallery, baseline.shopify, current.gallery, current.shopify]) {
    if (snapshot.assets.some(a => a.key !== key && (a.contentId === now.contentId || a.evidenceId === now.evidenceId) &&
        !removedDuplicate(snapshot, a))) return false;
  }
  // Membership and relative order of this image are unchanged.
  return !repositioned(baseline[source], current[source], key);
}

/** A newly referenced copy on `source` of an image the target already had in the
 * baseline. It is adopted, and only the target's ALT edit is propagated to it, when
 * the copy is PROVEN equal to the target's baseline state: same bytes and the same
 * ALT as before the target edit. The target changed nothing but ALT (bytes and source
 * evidence unchanged), the image kept its place, no removal history exists, and no
 * other key on either side, before or now, has the same bytes or source proof.
 * Concurrent edits or uncertain identity keep MEDIA_EXISTING_TARGET_DIFFERENT. */
function adoptedCopyOfTargetBaseline(baseline: MediaPair, current: MediaPair, source: MediaSide, key: string, removalKeys: ReadonlySet<string>): boolean {
  const target = other(source);
  const copy = current[source].assets.find(a => a.key === key), before = baseline[target].assets.find(a => a.key === key),
    now = current[target].assets.find(a => a.key === key);
  // Narrow scope: only a gallery copy of a Shopify baseline image (the Shopify-side write path is heavier).
  if (source !== "gallery" || !copy || !before || !now || baseline[source].assets.some(a => a.key === key)) return false;
  const fields = (a: MediaAsset) => Object.keys(a).sort().join(",");
  if ([copy, before, now].some(a => fields(a) !== "alt,contentId,evidenceId,key")) return false;
  if (copy.contentId !== before.contentId || now.contentId !== before.contentId || now.evidenceId !== before.evidenceId) return false;
  if (copy.alt !== before.alt || now.alt === before.alt) return false;
  if (SIDES.some(side => removalKeys.has(`${side}:${key}`))) return false;
  for (const snapshot of [baseline.gallery, baseline.shopify, current.gallery, current.shopify]) {
    if (snapshot.assets.some(a => a.key !== key && (a.contentId === copy.contentId || a.evidenceId === copy.evidenceId || a.evidenceId === now.evidenceId))) return false;
  }
  return !repositioned(baseline[target], current[target], key);
}

/** Audit view of the local-only ALT acknowledgements a plan relies on. Reported
 * separately from cross-site synchronization; the reserved plan shape is fixed. */
export function independentLocalAltChanges(baseline: MediaPair, current: MediaPair, removals: RemovalEvidence[] = [], detached: DetachReceipt[] = []):
  Array<{ side: MediaSide; key: string; previousAlt: string; currentAlt: string }> {
  const plan = reconcileMedia(baseline, current, removals, detached);
  if (plan.conflicts.length) return [];
  const removalKeys = new Set([...removals.map(r => `${r.side}:${r.key}`), ...detached.map(d => `${d.target}:${d.key}`)]);
  const result: Array<{ side: MediaSide; key: string; previousAlt: string; currentAlt: string }> = [];
  for (const side of SIDES) for (const asset of current[side].assets) {
    if (!independentLocalAlt(baseline, current, side, asset.key, removalKeys)) continue;
    result.push({ side, key: asset.key, previousAlt: baseline[side].assets.find(a => a.key === asset.key)!.alt, currentAlt: asset.alt });
  }
  return result;
}

/** An empty/error/incomplete read is not a deletion. Explicit removal evidence is mandatory. */
export function reconcileMedia(baseline: MediaPair, current: MediaPair, removals: RemovalEvidence[] = [], detached: DetachReceipt[] = []): MediaPlan {
  const identity = current.gallery.identity;
  assertIdentity(identity);
  for (const side of SIDES) { assertSnapshot(baseline[side], side, identity); assertSnapshot(current[side], side, identity); }
  if (!Array.isArray(removals) || removals.length > MAX_ASSETS * 2) fail("MEDIA_REMOVAL_EVIDENCE_INVALID");
  const removalKeys = new Set<string>();
  for (const evidence of removals) {
    if (!evidence || !SIDES.includes(evidence.side) || !KEY.test(evidence.key) || !UUID.test(evidence.requestId) ||
        evidence.kind !== (evidence.side === "gallery" ? "authenticated_editor" : "signed_shopify_event") ||
        evidence.expectedBaselineFingerprint !== mediaSnapshotFingerprint(baseline[evidence.side])) fail("MEDIA_REMOVAL_EVIDENCE_INVALID");
    const key = `${evidence.side}:${evidence.key}`;
    if (removalKeys.has(key)) fail("MEDIA_REMOVAL_EVIDENCE_DUPLICATE");
    removalKeys.add(key);
  }
  if (!Array.isArray(detached) || detached.length > MAX_ASSETS * 2) fail("MEDIA_DETACH_RECEIPT_INVALID");
  // An independent removal intent on the target and the transport's verified
  // receipt can attest the same absence. Only repeated receipts are duplicates.
  const detachReceiptKeys = new Set<string>();
  for (const receipt of detached) {
    if (!receipt || !SIDES.includes(receipt.source) || receipt.target !== other(receipt.source) || !KEY.test(receipt.key) ||
        !UUID.test(receipt.operationId) || !UUID.test(receipt.sourceIntentId) ||
        receipt.sourceBaselineFingerprint !== mediaSnapshotFingerprint(baseline[receipt.source]) ||
        receipt.targetBaselineFingerprint !== mediaSnapshotFingerprint(baseline[receipt.target]) ||
        receipt.targetAbsentReadbackRevision !== current[receipt.target].revision ||
        current[receipt.target].assets.some(a => a.key === receipt.key) || current[receipt.source].assets.some(a => a.key === receipt.key) ||
        !removals.some(r => r.side === receipt.source && r.key === receipt.key && r.requestId === receipt.sourceIntentId)) {
      fail("MEDIA_DETACH_RECEIPT_INVALID");
    }
    const key = `${receipt.target}:${receipt.key}`;
    if (detachReceiptKeys.has(key)) fail("MEDIA_DETACH_RECEIPT_DUPLICATE");
    detachReceiptKeys.add(key);
    removalKeys.add(key);
  }
  const plan: MediaPlan = { identity: clone(identity), preconditions: {
    gallery: { revision: current.gallery.revision, fingerprint: mediaSnapshotFingerprint(current.gallery) },
    shopify: { revision: current.shopify.revision, fingerprint: mediaSnapshotFingerprint(current.shopify) },
  }, patches: [], orders: [], conflicts: [], projected: { gallery: clone(current.gallery.assets), shopify: clone(current.shopify.assets) } };
  const b = { gallery: assetMap(baseline.gallery), shopify: assetMap(baseline.shopify) };
  const c = { gallery: assetMap(current.gallery), shopify: assetMap(current.shopify) };
  const keys = [...new Set([...baseline.gallery.assets, ...baseline.shopify.assets, ...current.gallery.assets, ...current.shopify.assets].map(a => a.key))];
  const conflict = (key: string, field: MediaConflict["field"], code: string) => plan.conflicts.push({ key, field, code });
  const replace = (target: MediaSide, key: string, update: Partial<MediaAsset>) => {
    const index = plan.projected[target].findIndex(a => a.key === key);
    if (index < 0) fail("MEDIA_INTERNAL_TARGET_MISSING");
    plan.projected[target][index] = { ...plan.projected[target][index], ...update };
  };
  // Apply shared order BEFORE membership insertions, so newly attached images
  // use their source anchors in the final sequence. A newly added asset already
  // on BOTH sides participates too: incompatible placements must not be silently
  // lost while the older shared images are reordered around it.
  const heldMembership = new Set(keys.filter(key => SIDES.every(side => c[side].has(key)) &&
    SIDES.some(side => !b[side].has(key)) && !same(semantic(c.gallery.get(key)), semantic(c.shopify.get(key)))));
  const common = new Set(keys.filter(key => !heldMembership.has(key) && SIDES.every(side => c[side].has(key))));
  const order = (snapshot: MediaSnapshot) => snapshot.assets.filter(a => common.has(a.key)).map(a => a.key);
  const changed = { gallery: !same(order(baseline.gallery), order(current.gallery)), shopify: !same(order(baseline.shopify), order(current.shopify)) };
  if (changed.gallery && changed.shopify && !same(order(current.gallery), order(current.shopify))) conflict("collection", "order", "MEDIA_CONCURRENT_ORDER");
  else if (changed.gallery !== changed.shopify) {
    const source: MediaSide = changed.gallery ? "gallery" : "shopify", target = other(source);
    const desired = order(current[source]);
    const targetMap = new Map(plan.projected[target].map(a => [a.key, a]));
    let next = 0;
    const proposed = plan.projected[target].map(a => common.has(a.key) ? targetMap.get(desired[next++])! : a);
    if ([...heldMembership].some(key => repositioned(current[target], { ...current[target], assets: proposed }, key))) {
      conflict("collection", "order", "MEDIA_ORDER_TOUCHES_HELD_MEMBERSHIP");
    } else plan.projected[target] = proposed;
  }
  for (const key of keys) {
    const membership = { gallery: c.gallery.has(key) !== b.gallery.has(key), shopify: c.shopify.has(key) !== b.shopify.has(key) };
    const unjustifiedRemoval = SIDES.some(side => b[side].has(key) && !c[side].has(key) && !removalKeys.has(`${side}:${key}`));
    if (unjustifiedRemoval) { conflict(key, "membership", "MEDIA_REMOVAL_INTENT_REQUIRED"); continue; }
    if (membership.gallery || membership.shopify) {
      if (membership.gallery && membership.shopify) {
        if (!same(semantic(c.gallery.get(key)), semantic(c.shopify.get(key)))) conflict(key, "membership", "MEDIA_CONCURRENT_MEMBERSHIP");
        continue;
      }
      const source: MediaSide = membership.gallery ? "gallery" : "shopify";
      const target = other(source), sourceAsset = c[source].get(key), targetAsset = c[target].get(key);
      if (!sourceAsset) {
        if (!removalKeys.has(`${source}:${key}`)) { conflict(key, "membership", "MEDIA_REMOVAL_INTENT_REQUIRED"); continue; }
        if (!same(semantic(targetAsset), semantic(b[target].get(key))) || repositioned(baseline[target], current[target], key)) {
          conflict(key, "membership", "MEDIA_REMOVE_VS_EDIT"); continue;
        }
        if (!targetAsset) continue;
        if (plan.projected[target].length <= 1) { conflict(key, "membership", "MEDIA_LAST_IMAGE_PROTECTED"); continue; }
        plan.patches.push({ source, target, key, kind: "detach_reference" });
        plan.projected[target] = plan.projected[target].filter(a => a.key !== key);
      } else if (!targetAsset) {
        if (plan.projected[target].length >= MAX_ASSETS) { conflict(key, "membership", "MEDIA_TARGET_LIMIT"); continue; }
        const index = insertionIndex(plan.projected[target], current[source].assets, key);
        if (index === null) { conflict(key, "membership", "MEDIA_AMBIGUOUS_INSERT_ORDER"); continue; }
        plan.patches.push({ source, target, key, kind: "attach", value: clone(sourceAsset) });
        plan.projected[target].splice(index, 0, clone(sourceAsset));
      } else if (!same(semantic(sourceAsset), semantic(targetAsset))) {
        // A pre-existing target reference cannot be replaced just because source membership changed.
        // Only a copy proven equal to the target's baseline receives the target's ALT edit.
        if (adoptedCopyOfTargetBaseline(baseline, current, source, key, removalKeys)) {
          plan.patches.push({ source: target, target: source, key, kind: "alt", value: targetAsset.alt });
          replace(source, key, { alt: targetAsset.alt });
        } else conflict(key, "membership", "MEDIA_EXISTING_TARGET_DIFFERENT");
      }
      continue;
    }
    if (!c.gallery.has(key) || !c.shopify.has(key)) {
      for (const source of SIDES) if (!same(semantic(c[source].get(key)), semantic(b[source].get(key))) &&
          !independentLocalAlt(baseline, current, source, key, removalKeys)) {
        conflict(key, "membership", "MEDIA_TARGET_MAPPING_REQUIRED");
      }
      continue;
    }
    for (const field of ["contentId", "alt"] as const) {
      const g = c.gallery.get(key)!, s = c.shopify.get(key)!;
      const changedG = g[field] !== b.gallery.get(key)?.[field], changedS = s[field] !== b.shopify.get(key)?.[field];
      if (!changedG && !changedS) continue;
      if (g[field] === s[field]) continue;
      const label = field === "alt" ? "alt" : "content";
      if (changedG && changedS) { conflict(key, label, "MEDIA_CONCURRENT_FIELD"); continue; }
      const source: MediaSide = changedG ? "gallery" : "shopify", target = other(source), value = c[source].get(key)!;
      if (field === "alt") {
        plan.patches.push({ source, target, key, kind: "alt", value: value.alt });
        replace(target, key, { alt: value.alt });
      } else {
        // Allocate/attach an owned replacement, not mutate shared file bytes globally.
        plan.patches.push({ source, target, key, kind: "replace_reference", value: { contentId: value.contentId, evidenceId: value.evidenceId } });
        replace(target, key, { contentId: value.contentId, evidenceId: value.evidenceId });
      }
    }
  }
  // Concurrent new images in the same gap have no user-defined cross-source
  // order. Merge each side's sequence with a deterministic key tie-break, rather
  // than creating two opposite orders and a synthetic conflict on the next run.
  // Newly shared (and held) references are real positional anchors too.
  const anchors = new Set(keys.filter(key => SIDES.every(side => c[side].has(key))));
  const gaps = new Map<string, Record<MediaSide, string[]>>();
  for (const source of SIDES) {
    const sourceKeys = current[source].assets.map(a => a.key);
    for (const [index, key] of sourceKeys.entries()) {
      if (b[source].has(key) || c[other(source)].has(key) ||
          !plan.patches.some(p => p.key === key && p.source === source && p.kind === "attach")) continue;
      const left = sourceKeys.slice(0, index).reverse().find(k => anchors.has(k)) ?? null;
      const right = sourceKeys.slice(index + 1).find(k => anchors.has(k)) ?? null;
      const gapKey = JSON.stringify([left, right]);
      if (!gaps.has(gapKey)) gaps.set(gapKey, { gallery: [], shopify: [] });
      gaps.get(gapKey)![source].push(key);
    }
  }
  for (const gap of gaps.values()) {
    if (!gap.gallery.length || !gap.shopify.length) continue;
    const queues = { gallery: [...gap.gallery], shopify: [...gap.shopify] }, merged: string[] = [];
    while (queues.gallery.length || queues.shopify.length) {
      const side: MediaSide = !queues.shopify.length || (queues.gallery.length > 0 && queues.gallery[0] < queues.shopify[0]) ? "gallery" : "shopify";
      merged.push(queues[side].shift()!);
    }
    const group = new Set(merged);
    const proposals: Record<MediaSide, MediaAsset[]> = { gallery: [], shopify: [] };
    for (const target of SIDES) {
      const targetMap = new Map(plan.projected[target].map(a => [a.key, a]));
      if (merged.some(key => !targetMap.has(key))) fail("MEDIA_INTERNAL_INSERTION_MISSING");
      let position = 0;
      proposals[target] = plan.projected[target].map(a => group.has(a.key) ? targetMap.get(merged[position++])! : a);
    }
    const crossesExistingReference = SIDES.some(side => {
      const oldKeys = plan.projected[side].map(a => a.key), newKeys = proposals[side].map(a => a.key);
      return merged.some(key => oldKeys.some(anchor => !group.has(anchor) &&
        (oldKeys.indexOf(key) < oldKeys.indexOf(anchor)) !== (newKeys.indexOf(key) < newKeys.indexOf(anchor))));
    });
    if (crossesExistingReference) {
      conflict("collection", "order", "MEDIA_CONCURRENT_INSERTION_ANCHORS");
    } else {
      for (const side of SIDES) plan.projected[side] = proposals[side];
    }
  }
  for (const side of SIDES) {
    const projectedOrder = plan.projected[side].map(a => a.key), currentOrder = current[side].assets.map(a => a.key);
    if (!same(projectedOrder, currentOrder)) plan.orders.push({ target: side, keys: projectedOrder });
  }
  return plan;
}

/** Mandatory immediate pre-write re-read guard; Shopify media has no compareDigest input. */
export function assertMediaPreconditions(plan: MediaPlan, fresh: MediaPair): void {
  for (const side of SIDES) {
    assertSnapshot(fresh[side], side, plan.identity);
    if (fresh[side].revision !== plan.preconditions[side].revision ||
        mediaSnapshotFingerprint(fresh[side]) !== plan.preconditions[side].fingerprint) fail("MEDIA_SOURCE_OR_TARGET_CHANGED");
  }
}

/** Readback must preserve every untouched field/image as well as every planned change. */
export function verifyMediaReadback(plan: MediaPlan, observed: MediaPair): void {
  for (const side of SIDES) {
    assertSnapshot(observed[side], side, plan.identity);
    const summary = (assets: MediaAsset[]) => assets.map(a => [a.key, a.contentId, a.alt]);
    if (!same(summary(observed[side].assets), summary(plan.projected[side]))) fail("MEDIA_READBACK_MISMATCH");
  }
}
