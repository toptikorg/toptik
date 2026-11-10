import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ownedFamilyForItem } from "./owned-edit-service";
import { readGroupMediaSnapshot } from "./group-media-read";
import type { GroupMediaBinding, GroupMediaSnapshot } from "./group-media-policy";
import type { GroupMediaJournalAttempt, GroupMediaJournalPort } from "./group-media-journal";
import { buildOwnedMediaPhaseSpecs, runOwnedMediaOperationPhases, type OwnedMediaPhaseOperation } from "./group-media-operation";
import { assertOwnedMediaManifest, ownedMediaBinding, ownedMediaHash, planOwnedMediaChange, planOwnedMediaObservation,
  resolveOwnedMediaPlan, type OwnedMediaCommand, type OwnedMediaManifest } from "./owned-media-plan";
import { readOwnedMediaRegistry, readOwnedMediaReceipt, prepareOwnedMediaOperation, readOwnedMediaOperation,
  recordOwnedMediaPhase, commitOwnedMediaOperation, type OwnedMediaActor, type OwnedMediaOperation,
  type OwnedMediaRegistryContext } from "./owned-media-registry";
import { readOwnedMediaProjectionEntries } from "./owned-media-projection";
import { stageOwnedMediaUpload } from "./owned-media-upload";
import type { OwnedMediaEditorCommand, OwnedMediaEditorData, OwnedMediaEditorResult } from "./owned-media-editor-state";

export type OwnedMediaExecutionContext = {
  owner: string; deadline: number;
  actor: { actorType: "supabase_user" | "admin_panel_token" | "session_admin" | "admin_token" | "system"; actorId: string };
};
export type OwnedMediaServiceResult = OwnedMediaEditorResult & { checkpoint: string };
type Dependencies = {
  registry?: typeof readOwnedMediaRegistry; receipt?: typeof readOwnedMediaReceipt; read?: typeof readGroupMediaSnapshot;
  prepare?: typeof prepareOwnedMediaOperation; run?: typeof runOwnedMediaOperationPhases;
  entries?: typeof readOwnedMediaProjectionEntries; commit?: typeof commitOwnedMediaOperation; stage?: typeof stageOwnedMediaUpload;
  journal?: (db: SupabaseClient) => GroupMediaJournalPort;
  environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string }; now?: () => number;
};
function fail(code: string): never { throw new Error(code); }
const enabled = (dependencies: Dependencies) => {
  const env = dependencies.environment ?? process.env;
  return env.VERCEL_ENV === "production" && env.SHOPIFY_MEDIA_SYNC === "enabled_v1";
};
function bindingForItem(itemId: string): GroupMediaBinding {
  const family = ownedFamilyForItem(itemId);
  const binding = family && ownedMediaBinding(family.productGid);
  if (!binding) fail("OWNED_MEDIA_ITEM_UNKNOWN");
  return binding;
}
function verifyContext(context: OwnedMediaRegistryContext, binding: GroupMediaBinding) {
  const sorted = (value: GroupMediaBinding) => ({ ...value, variants: [...value.variants].sort((a, b) => a.itemId.localeCompare(b.itemId)) });
  if (!context || !context.binding || ownedMediaHash(sorted(context.binding)) !== ownedMediaHash(sorted(binding)) || !Array.isArray(context.cards)) fail("OWNED_MEDIA_REGISTRY_INVALID");
  if (context.registered && (!context.snapshot || !context.manifest || !context.sourceFingerprint || context.mapVersion < 1)) fail("OWNED_MEDIA_REGISTRY_INVALID");
}
function ensureVisible(context: OwnedMediaRegistryContext, itemId: string) {
  if (!context.cards.some(card => card.itemId === itemId && card.isActive)) fail("OWNED_MEDIA_REMOVED_OR_HIDDEN");
}
function actor(input: OwnedMediaExecutionContext["actor"]): OwnedMediaActor {
  return { actorType: input.actorType === "supabase_user" ? "session_admin" : input.actorType === "admin_panel_token" ? "admin_token" : input.actorType,
    actorId: input.actorId };
}
function commandOnly(input: OwnedMediaEditorCommand): OwnedMediaCommand {
  return { requestId: input.requestId, itemId: input.itemId, expectedMapVersion: input.expectedMapVersion,
    expectedSourceFingerprint: input.expectedSourceFingerprint, desiredImages: structuredClone(input.desiredImages),
    ...(input.assignments ? { assignments: structuredClone(input.assignments) } : {}) };
}
function result(status: OwnedMediaEditorResult["status"], operation: Pick<OwnedMediaOperation, "id" | "nextPhase" | "mapVersion">, message: string): OwnedMediaServiceResult {
  return { status, requestId: operation.id, message, checkpoint: `${operation.id}:${operation.mapVersion}:${operation.nextPhase}:${status}` };
}

async function verifyDeliveredContext(db: SupabaseClient, operation: OwnedMediaOperation, execution: OwnedMediaExecutionContext,
  dependencies: Dependencies, committed?: OwnedMediaRegistryContext): Promise<OwnedMediaServiceResult> {
  const binding = operation.cursor.binding;
  const saved = committed ?? await (dependencies.registry ?? readOwnedMediaRegistry)(db, binding.productGid, execution.deadline);
  verifyContext(saved, binding);
  if (!saved.registered || !saved.manifest || !saved.snapshot || saved.operation) {
    return result("review", operation, "הפעולה נשמרה, אך יש כעת פעולה או שינוי נוסף שדורשים אימות. לא נשלחה כתיבה חוזרת.");
  }
  // This read occurs AFTER the atomic Gallery commit. A graph fingerprint deliberately
  // excludes copy fields, so read their actual forward projections again as well.
  const source = await (dependencies.read ?? readGroupMediaSnapshot)(binding, execution.deadline);
  if (source.fingerprint !== saved.sourceFingerprint) return result("review", operation,
    "הפעולה נשמרה, אך התמונות בחנות השתנו בזמן האימות האחרון. נדרשת בדיקת סנכרון; לא נשלחה כתיבה חוזרת.");
  const entries = await (dependencies.entries ?? readOwnedMediaProjectionEntries)(db, binding, source, saved.manifest, saved.cards, execution.deadline);
  const active = saved.cards.filter(card => card.isActive);
  if (entries.length !== active.length || entries.some(entry => {
    const card = active.find(row => row.itemId === entry.itemId);
    return !card || ownedMediaHash(card.projection) !== ownedMediaHash(entry.projection);
  })) return result("review", operation,
    "הפעולה נשמרה, אך הכותרת, התיאור או שדות ה-SEO השתנו בזמן האימות האחרון. לא נשלחה כתיבה חוזרת.");
  return result("done", { ...operation, mapVersion: saved.mapVersion }, committed
    ? "התמונות, הסדר והתמונה הראשית אומתו בחנות ובגלריה." : "הפעולה הזאת כבר הושלמה, והמצב הנוכחי בחנות ובגלריה נבדק שוב. לא נשלחה כתיבה חוזרת.");
}

/** SQL owns permits and cursor advancement. Browser receipts never enter this adapter. */
export function createOwnedMediaJournal(db: SupabaseClient): GroupMediaJournalPort {
  return {
    async read(ref, deadline) {
      const value = await readOwnedMediaOperation(db, { productGid: ref.productGid, operationId: ref.operationId, phaseIndex: ref.phaseIndex, owner: ref.owner }, deadline);
      if (!["prepared", "started", "uncertain", "verified", "review"].includes(String(value.status)) || typeof value.leaseExpiresAt !== "string" ||
        !value.before || !Object.hasOwn(value, "request")) fail("OWNED_MEDIA_JOURNAL_INVALID");
      return value as GroupMediaJournalAttempt;
    },
    async record(ref, record, deadline) {
      return recordOwnedMediaPhase(db, { productGid: ref.productGid, owner: ref.owner, operationId: ref.operationId, phaseIndex: ref.phaseIndex,
        attemptId: record.attemptId, action: record.action, requestHash: record.requestHash,
        requestJson: record.requestJson as unknown as Record<string, unknown>, observedGraph: record.observedGraph, artifact: record.artifact }, deadline);
    },
  };
}

/** Narrow authenticated audit read for the two known products, using the same
 * pinned API as the worker. It grants no map adoption or mutation authority. */
export async function readOwnedMediaAdoptionSource(itemId: string, deadline: number, dependencies: Dependencies = {}) {
  const binding = bindingForItem(itemId);
  const source = await (dependencies.read ?? readGroupMediaSnapshot)(binding, deadline);
  return { kind: "owned_media_adoption_source_read_only", readOnly: true, apiVersion: "2026-07", observedAt: new Date().toISOString(), source };
}

/** Lazy, read-only editor data. Native additions without a color are exposed as a choice, never guessed. */
export async function readOwnedMediaEditor(db: SupabaseClient, itemId: string, deadline: number, dependencies: Dependencies = {}): Promise<OwnedMediaEditorData> {
  const binding = bindingForItem(itemId);
  const context = await (dependencies.registry ?? readOwnedMediaRegistry)(db, binding.productGid, deadline);
  verifyContext(context, binding); ensureVisible(context, itemId);
  const source = await (dependencies.read ?? readGroupMediaSnapshot)(binding, deadline);
  const labels = ownedFamilyForItem(itemId)!.variants;
  const variants = binding.variants.map(variant => ({ itemId: variant.itemId, sku: variant.sku, label: labels.find(row => row.itemId === variant.itemId)!.color }));
  const base: OwnedMediaEditorData = { itemId, mapVersion: context.mapVersion, sourceFingerprint: source.fingerprint,
    enabled: false, images: [], variants, unassigned: [], pending: null };
  if (!context.registered || !context.manifest || !context.snapshot) {
    return { ...base, reason: "שיוך התמונות של הצבעים עדיין לא אומץ. אין שינוי בחנות או בגלריה." };
  }
  let manifest = context.manifest, displayed = context.snapshot;
  if (!context.operation) {
    const observation = planOwnedMediaObservation(context.snapshot, context.manifest, source);
    manifest = observation.candidateManifest; displayed = source;
    base.unassigned = observation.unassigned.map(image => ({ mediaId: image.mediaId, url: image.image!.url, alt: image.alt?.trim() ?? "" }));
  }
  const color = manifest.variants.find(variant => variant.itemId === itemId)!;
  const ordered = [color.coverMediaId, ...color.orderedMediaIds.filter(id => id !== color.coverMediaId)];
  base.images = ordered.map(id => {
    const media = displayed.media.find(image => image.mediaId === id);
    if (!media?.image) fail("OWNED_MEDIA_REGISTRY_INVALID");
    return { key: id, mediaId: id, url: media.image.url, alt: media.alt?.trim() ?? "" };
  });
  if (context.operation) {
    base.pending = { requestId: context.operation.id, status: context.operation.status === "review" ? "review" : "pending",
      message: context.operation.status === "review" ? "פעולה קודמת דורשת בדיקה. לא תישלח פעולה חדשה." : "פעולה קודמת ממתינה לאימות ולהשלמת הסנכרון." };
  }
  base.enabled = enabled(dependencies) && !context.operation && source.product.status === "ACTIVE" && source.product.publishedOnPublication;
  if (!enabled(dependencies)) base.reason = "שמירת תמונות בחנות עדיין אינה מופעלת בסביבה הזאת.";
  else if (source.product.status !== "ACTIVE" || !source.product.publishedOnPublication) base.reason = "המוצר אינו מפורסם בחנות. לא יישלחו שינויים.";
  return base;
}

/** Complete only new unassigned native media. Existing memberships cannot be reassigned via a forged choice. */
function resolveObservationAssignments(source: GroupMediaSnapshot, candidate: OwnedMediaManifest,
  unassigned: readonly { mediaId: string }[], command: OwnedMediaCommand, context: OwnedMediaRegistryContext): OwnedMediaManifest {
  const manifest = structuredClone(candidate), unknown = new Set(unassigned.map(image => image.mediaId)), seen = new Set<string>();
  for (const assignment of command.assignments ?? []) {
    if (!unknown.has(assignment.mediaId) || seen.has(assignment.mediaId) || !assignment.itemIds.length ||
      new Set(assignment.itemIds).size !== assignment.itemIds.length || assignment.itemIds.some(itemId => !context.cards.some(card => card.itemId === itemId && card.isActive))) fail("OWNED_MEDIA_ASSIGNMENT_INVALID");
    seen.add(assignment.mediaId);
    for (const itemId of assignment.itemIds) {
      const variant = manifest.variants.find(row => row.itemId === itemId);
      if (!variant) fail("OWNED_MEDIA_ASSIGNMENT_INVALID");
      variant.orderedMediaIds.push(assignment.mediaId);
    }
  }
  if ([...unknown].some(id => !seen.has(id))) fail("OWNED_MEDIA_UNASSIGNED_REVIEW_REQUIRED");
  for (const variant of manifest.variants) variant.orderedMediaIds = manifest.globalOrder.filter(id => variant.orderedMediaIds.includes(id));
  assertOwnedMediaManifest(source.binding, source, manifest);
  return manifest;
}

async function finishOperation(db: SupabaseClient, operation: OwnedMediaOperation, execution: OwnedMediaExecutionContext,
  dependencies: Dependencies): Promise<OwnedMediaServiceResult> {
  if (operation.status === "review" || operation.status === "cancelled") return result("review", operation, "הפעולה דורשת בדיקה. לא נשלחה שוב בקשת שינוי.");
  if (operation.status === "verified") return verifyDeliveredContext(db, operation, execution, dependencies);
  if (!enabled(dependencies)) return result("pending", operation, "הפעולה נשמרה, אבל רכיב סנכרון התמונות אינו מופעל כרגע.");
  const run = await (dependencies.run ?? runOwnedMediaOperationPhases)(operation as unknown as OwnedMediaPhaseOperation,
    execution.owner, execution.deadline, { journal: (dependencies.journal ?? createOwnedMediaJournal)(db), environment: dependencies.environment });
  const progressed = { ...operation, nextPhase: run.nextPhase };
  if (run.status !== "phases_verified") return result(run.status === "review" ? "review" : "pending", progressed,
    run.status === "review" ? "נמצא שינוי מקביל או פער באימות התמונות. הפעולה נשמרה לבדיקה." : "הפעולה ממתינה לקריאה חוזרת ולהשלמה. אין צורך ליצור אותה שוב.");
  const binding = operation.cursor.binding;
  const source = await (dependencies.read ?? readGroupMediaSnapshot)(binding, execution.deadline);
  if (source.fingerprint !== run.cursor.fingerprint) fail("OWNED_MEDIA_SOURCE_CHANGED");
  const manifest = resolveOwnedMediaPlan(operation.plan, run.createdMediaIdsByUploadKey, source);
  const entries = await (dependencies.entries ?? readOwnedMediaProjectionEntries)(db, binding, source, manifest, operation.expectedCards, execution.deadline);
  const saved = await (dependencies.commit ?? commitOwnedMediaOperation)(db, { productGid: binding.productGid, owner: execution.owner,
    operationId: operation.id, source, manifest, entries }, execution.deadline);
  verifyContext(saved, binding);
  if (!saved.registered || saved.sourceFingerprint !== source.fingerprint || ownedMediaHash(saved.manifest) !== ownedMediaHash(manifest)) fail("OWNED_MEDIA_COMMIT_READBACK_MISMATCH");
  return verifyDeliveredContext(db, progressed, execution, dependencies, saved);
}

/** Caller must hold the exact product reconciliation lease. No Shopify mutation before durable prepare. */
export async function applyOwnedMediaEdit(db: SupabaseClient, input: OwnedMediaEditorCommand, execution: OwnedMediaExecutionContext,
  dependencies: Dependencies = {}): Promise<OwnedMediaServiceResult> {
  const command = commandOnly(input), binding = bindingForItem(command.itemId);
  const previous = await (dependencies.receipt ?? readOwnedMediaReceipt)(db, { productGid: binding.productGid, requestId: command.requestId }, execution.deadline);
  if (previous.operation) {
    if (previous.operation.command.itemId !== command.itemId || ownedMediaHash(previous.operation.command) !== ownedMediaHash(command)) fail("OWNED_MEDIA_REQUEST_CONFLICT");
    return finishOperation(db, previous.operation, execution, dependencies);
  }
  if (!enabled(dependencies)) fail("OWNED_MEDIA_DISABLED");
  const context = await (dependencies.registry ?? readOwnedMediaRegistry)(db, binding.productGid, execution.deadline);
  verifyContext(context, binding); ensureVisible(context, command.itemId);
  if (!context.registered || !context.manifest || !context.snapshot) fail("OWNED_MEDIA_BASELINE_REQUIRED");
  if (context.operation) fail("OWNED_MEDIA_OPERATION_BUSY");
  if (context.mapVersion !== command.expectedMapVersion) fail("OWNED_MEDIA_STALE_SOURCE");
  const source = await (dependencies.read ?? readGroupMediaSnapshot)(binding, execution.deadline);
  if (source.product.status !== "ACTIVE" || !source.product.publishedOnPublication) fail("OWNED_MEDIA_SOURCE_UNPUBLISHED");
  if (source.fingerprint !== command.expectedSourceFingerprint) fail("OWNED_MEDIA_STALE_SOURCE");
  const observation = planOwnedMediaObservation(context.snapshot, context.manifest, source);
  const beforeManifest = resolveObservationAssignments(source, observation.candidateManifest, observation.unassigned, command, context);
  const plan = planOwnedMediaChange(source, beforeManifest, command);
  const staged: Parameters<typeof buildOwnedMediaPhaseSpecs>[2] = {};
  for (const upload of plan.uploads) staged[upload.key] = await (dependencies.stage ?? stageOwnedMediaUpload)(db, binding, command.itemId, upload.uploadUrl, execution.deadline);
  // Upload/decode can take time. Refuse a stale source before reserving any native write.
  const fresh = await (dependencies.read ?? readGroupMediaSnapshot)(binding, execution.deadline);
  if (fresh.fingerprint !== source.fingerprint) fail("OWNED_MEDIA_STALE_SOURCE");
  const phases = buildOwnedMediaPhaseSpecs(plan, source, staged);
  const observed = context.sourceFingerprint !== source.fingerprint;
  const observedEntries = observed ? await (dependencies.entries ?? readOwnedMediaProjectionEntries)(db, binding, source, beforeManifest, context.cards, execution.deadline) : undefined;
  const operation = await (dependencies.prepare ?? prepareOwnedMediaOperation)(db, { productGid: binding.productGid, owner: execution.owner,
    requestId: command.requestId, actor: actor(execution.actor), expectedMapVersion: command.expectedMapVersion,
    expectedSourceFingerprint: source.fingerprint, source, command, plan, phases: phases as unknown as Record<string, unknown>[],
    ...(observed ? { observedManifest: beforeManifest, observedEntries } : {}) }, execution.deadline);
  return finishOperation(db, operation, execution, dependencies);
}

/** Recovery reads the immutable operation, not a resubmitted desired image list. */
export async function resumeOwnedMediaEdit(db: SupabaseClient, input: { itemId: string; requestId: string }, execution: OwnedMediaExecutionContext,
  dependencies: Dependencies = {}): Promise<OwnedMediaServiceResult> {
  const binding = bindingForItem(input.itemId);
  const receipt = await (dependencies.receipt ?? readOwnedMediaReceipt)(db, { productGid: binding.productGid, requestId: input.requestId }, execution.deadline);
  if (!receipt.operation) return { status: "review", requestId: input.requestId, notRecorded: true, checkpoint: `${input.requestId}:not_recorded`,
    message: "לא נמצא רישום לפעולה הזאת. הטיוטה נשמרה במסך. יש לבדוק את המצב העדכני בחנות לפני שמירה חדשה." };
  if (receipt.operation.command.itemId !== input.itemId) fail("OWNED_MEDIA_OPERATION_UNKNOWN");
  return finishOperation(db, receipt.operation, execution, dependencies);
}
