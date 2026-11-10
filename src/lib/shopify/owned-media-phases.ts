import type { OwnedMediaPlan } from "./owned-media-plan";
import type { GroupMediaSnapshot } from "./group-media-policy";
import { buildGroupMediaPhase, type GroupMediaPhaseInput, type GroupMediaPhaseRequest, type GroupOwnedMediaReceipt, type GroupStagedMediaSource } from "./group-media-transport";

/** Immutable logical steps. An upload placeholder is resolved only from a verified recovered file. */
export type OwnedMediaPhaseSpec =
  | { kind: "create_owned"; uploadKey: string; source: GroupStagedMediaSource; alt: string }
  | { kind: "product_attach"; uploadKey: string }
  | { kind: "variant_append"; variantId: string; mediaRefs: string[] }
  | { kind: "variant_cover"; variantId: string; mediaRef: string }
  | { kind: "variant_detach"; variantId: string; mediaRefs: string[]; removalIntentId: string }
  | { kind: "product_detach"; mediaRef: string; protectedRefs: string[]; removalIntentId: string }
  | { kind: "reorder"; mediaRefs: string[]; protectedRefs: string[] };
export type OwnedMediaVerifiedArtifact = { uploadKey?: string; owned?: GroupOwnedMediaReceipt; mediaId?: string; [key: string]: unknown };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isUpload = (ref: string) => ref.startsWith("upload:");

export function buildOwnedMediaPhaseSpecs(plan: OwnedMediaPlan, before: GroupMediaSnapshot,
  staged: Record<string, GroupStagedMediaSource>): OwnedMediaPhaseSpec[] {
  // An approved display map does not imply that all its photos were historically
  // appended to each native variant. A no-op must not migrate that association graph.
  if (plan.noop) return [];
  if (!Array.isArray(plan.impactedItemIds) || new Set(plan.impactedItemIds).size !== plan.impactedItemIds.length ||
      plan.impactedItemIds.some(id => !before.binding.variants.some(variant => variant.itemId === id))) {
    throw new Error("GROUP_MEDIA_IMPACTED_IDENTITY_INVALID");
  }
  const impacted = plan.desiredManifest.variants.filter(variant => plan.impactedItemIds.includes(variant.itemId));
  const steps: OwnedMediaPhaseSpec[] = [];
  for (const upload of plan.uploads) {
    const source = staged[upload.key];
    if (!source || source.itemId !== plan.itemId) throw new Error("GROUP_MEDIA_STAGED_PROOF_REQUIRED");
    steps.push({ kind: "create_owned", uploadKey: upload.key, source: structuredClone(source), alt: upload.alt });
    steps.push({ kind: "product_attach", uploadKey: upload.key });
  }
  // Shopify supports one native image per variant. The private reviewed map owns
  // the additional angles; never append those images as native associations.
  // Bulk-update replaces the primary association when the cover actually changes.
  for (const target of impacted) {
    const native = before.variants.find(v => v.variantGid === target.variantGid);
    if (!native) throw new Error("GROUP_MEDIA_IDENTITY_CONFLICT");
    const photo = before.media.find(m => m.mediaId === target.coverMediaId);
    if (isUpload(target.coverMediaId) || !photo || native.image?.url !== photo.image?.url) {
      steps.push({ kind: "variant_cover", variantId: target.variantGid, mediaRef: target.coverMediaId });
    }
  }
  for (const mediaId of plan.productDetachMediaIds) steps.push({ kind: "product_detach", mediaRef: mediaId,
    protectedRefs: [...plan.protectedMediaIds], removalIntentId: plan.requestId });
  if (plan.uploads.length || plan.productDetachMediaIds.length || !same(plan.desiredManifest.globalOrder, before.media.map(m => m.mediaId))) {
    steps.push({ kind: "reorder", mediaRefs: [...plan.desiredManifest.globalOrder], protectedRefs: [...plan.protectedMediaIds] });
  }
  return steps;
}

/** Read only verified artifacts supplied by the private journal, never raw browser receipts. */
export function ownedMediaCreatedIds(artifacts: readonly OwnedMediaVerifiedArtifact[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const artifact of artifacts) {
    if (!artifact.uploadKey) continue;
    if (!artifact.owned || artifact.mediaId !== artifact.owned.media.mediaId || !isUpload(artifact.uploadKey) ||
        (result[artifact.uploadKey] && result[artifact.uploadKey] !== artifact.mediaId)) throw new Error("GROUP_MEDIA_ARTIFACT_INVALID");
    result[artifact.uploadKey] = artifact.mediaId;
  }
  return result;
}
export function resolveOwnedMediaPhase(spec: OwnedMediaPhaseSpec, operationId: string, phaseIndex: number,
  before: GroupMediaSnapshot, artifacts: readonly OwnedMediaVerifiedArtifact[]): GroupMediaPhaseRequest {
  const created = ownedMediaCreatedIds(artifacts);
  const id = (ref: string) => {
    if (!isUpload(ref)) return ref;
    if (!created[ref]) throw new Error("GROUP_MEDIA_VERIFIED_UPLOAD_REQUIRED");
    return created[ref];
  };
  let phase: GroupMediaPhaseInput;
  if (spec.kind === "create_owned") phase = { kind: spec.kind, source: spec.source, alt: spec.alt };
  else if (spec.kind === "product_attach") {
    const owned = artifacts.find(a => a.uploadKey === spec.uploadKey)?.owned;
    if (!owned) throw new Error("GROUP_MEDIA_VERIFIED_UPLOAD_REQUIRED");
    phase = { kind: spec.kind, owned };
  } else if (spec.kind === "variant_cover") {
    const mediaId = id(spec.mediaRef);
    phase = { kind: spec.kind, variantId: spec.variantId, mediaId };
  } else if (spec.kind === "product_detach") phase = { kind: spec.kind, mediaId: id(spec.mediaRef),
    protectedMediaIds: spec.protectedRefs.map(id), removalIntentId: spec.removalIntentId };
  else if (spec.kind === "reorder") {
    const mediaIds = spec.mediaRefs.map(id);
    phase = { kind: spec.kind, mediaIds, protectedMediaIds: spec.protectedRefs.map(id) };
  } else {
    phase = spec.kind === "variant_append" ? { kind: spec.kind, variantId: spec.variantId, mediaIds: spec.mediaRefs.map(id) } :
      { kind: spec.kind, variantId: spec.variantId, mediaIds: spec.mediaRefs.map(id), removalIntentId: spec.removalIntentId };
  }
  return buildGroupMediaPhase({ operationId, phaseIndex, before, phase });
}
