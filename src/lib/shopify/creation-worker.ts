import { assertCreatedDraftReadback, assertOwnedGalleryDraft, buildGalleryDraftCreateVariables,
  buildGalleryDraftVariantVariables, galleryDraftCommercialFingerprint, GALLERY_CREATION_POLICY,
  type DraftMediaReadback, type GalleryCreationDraft, type GalleryCreationReceipt,
  type GalleryCreationStage, type OwnedDraftSnapshot, type ReadyGalleryDraft } from "./creation-policy";

export type GalleryCreationRecord = {
  id: string; source: GalleryCreationDraft; catalogKey: string; stage: GalleryCreationStage;
  version: number; readyProof: ReadyGalleryDraft | null; receipt: GalleryCreationReceipt | null; replayed?: boolean;
};
export type CreationWorkerPorts = {
  mode: string | undefined;
  claim(id: string, owner: string): Promise<GalleryCreationRecord | null>;
  advance(record: GalleryCreationRecord, owner: string, patch: { readyProof?: ReadyGalleryDraft; receipt: GalleryCreationReceipt;
    freshReadyProof?: ReadyGalleryDraft; readbackProof?: { snapshot: OwnedDraftSnapshot; media: DraftMediaReadback[]; verifiedAt: string } }): Promise<GalleryCreationRecord>;
  release(id: string, owner: string): Promise<void>;
  recordFailure(id: string, owner: string, code: string): Promise<void>;
  prepare(source: GalleryCreationDraft, recovery?: { receipt: GalleryCreationReceipt; snapshot: OwnedDraftSnapshot }): Promise<ReadyGalleryDraft>;
  lookup(ready: ReadyGalleryDraft): Promise<OwnedDraftSnapshot | null>;
  create(ready: ReadyGalleryDraft): Promise<OwnedDraftSnapshot>;
  configure(variables: ReturnType<typeof buildGalleryDraftVariantVariables>): Promise<void>;
  media(ready: ReadyGalleryDraft, snapshot: OwnedDraftSnapshot): Promise<DraftMediaReadback[]>;
  beforeWrite(): void;
  now(): number;
};
export type CreationWorkerResult = { id: string; stage: GalleryCreationStage | "busy"; pending: boolean; code?: string };

function codeOf(error: unknown) {
  if (error instanceof Error && error.message === "SPEC_TIME_BUDGET") return "SYNC_CREATION_TIME_BUDGET";
  return error instanceof Error && /^(SYNC_CREATION_|SHOPIFY_)[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_CREATION_OPERATION_UNCERTAIN";
}

/** Durable creation orchestration with injected I/O. Every send is preceded by
 * an atomic source-CAS + owned lease + started receipt. A replay is read-only.
 */
export async function runGalleryDraftCreation(id: string, owner: string, ports: CreationWorkerPorts): Promise<CreationWorkerResult> {
  if (ports.mode !== "draft_only") throw new Error("SYNC_CREATION_NOT_ENABLED");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(id) || !uuid.test(owner)) throw new Error("SYNC_CREATION_ID_INVALID");
  let record = await ports.claim(id, owner);
  if (!record) return { id, stage: "busy", pending: true };
  const advance = async (receipt: GalleryCreationReceipt, readyProof?: ReadyGalleryDraft,
    readbackProof?: { snapshot: OwnedDraftSnapshot; media: DraftMediaReadback[]; verifiedAt: string }, freshReadyProof?: ReadyGalleryDraft) => {
    record = await ports.advance(record!, owner, { receipt, ...(readyProof ? { readyProof } : {}),
      ...(readbackProof ? { readbackProof } : {}), ...(freshReadyProof ? { freshReadyProof } : {}) });
    return record;
  };
  try {
    if (record.stage === "review" || record.stage === "draft_ready") return { id, stage: record.stage, pending: false };
    if (!record.readyProof) {
      if (record.stage !== "reserved" || record.receipt) throw new Error("SYNC_CREATION_RECEIPT_INVALID");
      const ready = await ports.prepare(record.source);
      await advance({ policyVersion: GALLERY_CREATION_POLICY, galleryItemId: id, sourceFingerprint: ready.sourceFingerprint,
        customId: ready.customId, stage: "reserved", productGid: null, variantGid: null, shopifyUpdatedAt: null,
        commercialFingerprint: null, initialCommercial: null }, ready);
    }
    const ready = record.readyProof!, receipt = record.receipt!;
    buildGalleryDraftCreateVariables(ready);
    if (!receipt || receipt.stage !== record.stage || ready.draft.galleryItemId !== id) throw new Error("SYNC_CREATION_RECEIPT_INVALID");
    let snapshot = await ports.lookup(ready);
    if (snapshot) assertOwnedGalleryDraft(ready, snapshot);
    if (record.stage === "reserved") {
      if (snapshot) throw new Error("SYNC_CREATION_PREEXISTING_CUSTOM_ID");
      const fresh = await ports.prepare(record.source);
      if (fresh.sourceFingerprint !== ready.sourceFingerprint) throw new Error("SYNC_CREATION_SOURCE_CHANGED");
      ports.beforeWrite();
      await advance({ ...receipt, stage: "create_started" }, undefined, undefined, fresh);
      if (record.replayed) return { id, stage: record.stage, pending: true };
      try { snapshot = await ports.create(ready); }
      catch (error) {
        await advance({ ...record.receipt!, stage: "uncertain" });
        await ports.recordFailure(id, owner, codeOf(error)).catch(() => {});
        return { id, stage: "uncertain", pending: true, code: codeOf(error) };
      }
      assertOwnedGalleryDraft(ready, snapshot);
      // This immutable baseline is captured from the actual mutation response.
      await advance({ ...record.receipt!, stage: "draft_found", productGid: snapshot.productGid,
        variantGid: snapshot.variantGid, shopifyUpdatedAt: snapshot.updatedAt,
        initialCommercial: snapshot.commercial, commercialFingerprint: galleryDraftCommercialFingerprint(snapshot.commercial) });
    }
    if (!snapshot) return { id, stage: record.stage, pending: true, code: "SYNC_CREATION_LOOKUP_PENDING" };
    const currentReceipt = record.receipt!;
    if (currentReceipt.productGid !== snapshot.productGid || currentReceipt.variantGid !== snapshot.variantGid ||
        !currentReceipt.initialCommercial || !currentReceipt.commercialFingerprint) {
      // The create committed but its response was lost: identity can be recovered;
      // the initial commercial state cannot be reconstructed without guessing.
      await advance({ ...currentReceipt, stage: "review" });
      await ports.recordFailure(id, owner, "SYNC_CREATION_INITIAL_RESPONSE_UNAVAILABLE").catch(() => {});
      return { id, stage: "review", pending: false, code: "SYNC_CREATION_INITIAL_RESPONSE_UNAVAILABLE" };
    }
    if (record.stage === "draft_found") {
      const fresh = await ports.prepare(record.source, { receipt: currentReceipt, snapshot });
      if (fresh.sourceFingerprint !== ready.sourceFingerprint) throw new Error("SYNC_CREATION_SOURCE_CHANGED");
      snapshot = await ports.lookup(ready);
      if (!snapshot) throw new Error("SYNC_CREATION_DRAFT_MISSING");
      const variables = buildGalleryDraftVariantVariables(ready, snapshot, currentReceipt.shopifyUpdatedAt!, currentReceipt.commercialFingerprint);
      ports.beforeWrite();
      await advance({ ...currentReceipt, stage: "variant_started" }, undefined, undefined, fresh);
      if (record.replayed) return { id, stage: record.stage, pending: true };
      try { await ports.configure(variables); }
      catch (error) {
        await advance({ ...record.receipt!, stage: "uncertain" });
        await ports.recordFailure(id, owner, codeOf(error)).catch(() => {});
        return { id, stage: "uncertain", pending: true, code: codeOf(error) };
      }
    }
    // Never resend configure after an interrupted/uncertain response.
    snapshot = await ports.lookup(ready);
    if (!snapshot) return { id, stage: record.stage, pending: true, code: "SYNC_CREATION_LOOKUP_PENDING" };
    const media = await ports.media(ready, snapshot);
    assertCreatedDraftReadback(ready, snapshot, media, ports.now(), record.receipt!.initialCommercial!);
    await advance({ ...record.receipt!, stage: "draft_ready", shopifyUpdatedAt: snapshot.updatedAt }, undefined, { snapshot, media, verifiedAt: new Date(ports.now()).toISOString() });
    return { id, stage: "draft_ready", pending: false };
  } catch (error) {
    const code = codeOf(error);
    const retryable = /TIME_BUDGET|MEDIA_PENDING|LOOKUP_PENDING|LEASE|SOURCE_CAS|TRANSACTION|OPERATION_UNCERTAIN|THROTTLED|SHOPIFY_API_HTTP_429|SHOPIFY_API_HTTP_5\d\d/.test(code);
    if (!retryable && record?.receipt && record.stage !== "review" && record.stage !== "draft_ready") {
      try { await advance({ ...record.receipt, stage: "review" }); } catch { /* A changed source/lease cannot be overwritten. */ }
    }
    await ports.recordFailure(id, owner, code).catch(() => {});
    return { id, stage: record!.stage, pending: retryable, code };
  } finally {
    await ports.release(id, owner).catch(() => {});
  }
}
