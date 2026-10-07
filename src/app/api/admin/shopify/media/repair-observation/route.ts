import { NextResponse, type NextRequest } from "next/server";
import { requireGalleryAdmin } from "@/lib/admin/gallery-access";
import { createMediaTransportRpc, discoverMediaTransportOperation } from "@/lib/shopify/media-transport-rpc";
import { createMediaRuntimeObserver } from "@/lib/shopify/media-runtime-observation";
import { assertReviewedPersistedMedia } from "@/lib/shopify/reviewed-media-policy";

export const runtime = "nodejs";
export const preferredRegion = "syd1";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Administrator-only observation for a database operator's exact repair review.
 * Never authorizes a repair, uploads, advances a phase or resets a journal.
 * The temporary read lease is released before returning; the operator must
 * acquire a separate lease and SQL must validate this genuine fresh guard. */
export async function GET(req: NextRequest) {
  const denied = await requireGalleryAdmin(req); if (denied) return denied;
  const stop = Date.now() + 45000;
  let rpc: ReturnType<typeof createMediaTransportRpc> | undefined;
  let owner: string | undefined;
  try {
    const q = req.nextUrl.searchParams;
    if ([...q.keys()].sort().join() !== "operationId,step" || !/^[a-f0-9-]{36}$/i.test(q.get("operationId") ?? "") ||
        !/^(0|[1-9]\d{0,2}|1000)$/.test(q.get("step") ?? "")) throw new Error("MEDIA_REPAIR_OBSERVATION_INPUT_INVALID");
    const ref = { operationId: q.get("operationId")!, step: Number(q.get("step")), phaseIndex: 0 };
    const first = await discoverMediaTransportOperation(ref, stop);
    rpc = createMediaTransportRpc(first.identity.productId);
    const lease = await rpc.acquire(stop);
    if (!lease) throw new Error("MEDIA_REPAIR_OBSERVATION_LEASE_BUSY");
    owner = lease.owner;
    const d = await discoverMediaTransportOperation(ref, stop);
    if (!d.enabled || d.identity.productId !== first.identity.productId) throw new Error("MEDIA_REPAIR_OBSERVATION_DISABLED");
    await assertReviewedPersistedMedia(d, stop);
    const a = d.transport.attempts.find(x => x.phase_index === 0);
    const body = d.step.body as { target?: string };
    if (!a || !["started", "uncertain"].includes(String(a.status)) ||
        !["gallery_upload", "stage_source"].includes(String(a.phase)) ||
        !["gallery", "shopify"].includes(String(body?.target))) throw new Error("MEDIA_REPAIR_OBSERVATION_NOT_PENDING");
    const guard = await createMediaRuntimeObserver(d)(d.identity, body.target as "gallery" | "shopify", stop);
    const request = a.request as Record<string, unknown>;
    const proof = d.provenance.find(p => p.evidence_id === request.sourceEvidenceId)?.proof as Record<string, unknown> | undefined;
    if (!proof) throw new Error("MEDIA_REPAIR_OBSERVATION_PROOF_MISSING");
    return NextResponse.json({ identity: d.identity, reference: ref, originalAttemptId: a.attempt_id,
      originalRequestHash: a.request_hash, storagePath: request.storagePath,
      sourceSha256: proof.decodedSha256, sourceEvidenceId: request.sourceEvidenceId,
      guard, approved: false, mayExecute: false }, { headers });
  } catch (error) {
    const code = error instanceof Error && /^(MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(error.message)
      ? error.message : "MEDIA_REPAIR_OBSERVATION_FAILED";
    return NextResponse.json({ error: code, approved: false, mayExecute: false }, { status: 409, headers });
  } finally {
    if (rpc && owner) try { await rpc.release(owner, Date.now() + 3000); } catch { /* bounded read lease expires */ }
  }
}
