import "server-only";
import { after } from "next/server";
import { drainMediaWork, mediaSyncEnabled } from "./media-work-queue";

const URL = "https://landing.toptik.co.il/api/admin/shopify/media/worker";
export const MAX_MEDIA_HOPS = 250;
export function validMediaHop(value: string | null) { return value && /^(?:0|[1-9]\d{0,2})$/.test(value) && Number(value) <= MAX_MEDIA_HOPS ? Number(value) : null; }
export async function dispatchMediaSync(hop = 0): Promise<void> {
  if (!mediaSyncEnabled()) return;
  if (!Number.isSafeInteger(hop) || hop < 0 || hop > MAX_MEDIA_HOPS) throw new Error("MEDIA_CONTINUATION_INVALID");
  const token = process.env.ADMIN_PANEL_TOKEN; if (!token) throw new Error("MEDIA_CONTINUATION_AUTH_UNAVAILABLE");
  const response = await fetch(`${URL}?hop=${hop}`, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000), headers: { "x-admin-token": token } });
  try { if (response.status !== 202 || response.redirected) throw new Error(`MEDIA_CONTINUATION_NOT_ACCEPTED_HTTP_${response.status}`); }
  finally { await response.body?.cancel(); }
}
function report(error: unknown) { console.error("Media synchronization pending", { code: error instanceof Error && /^MEDIA_[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "MEDIA_BACKGROUND_FAILED" }); }
/** Short wakeup only; never adds a second long worker to an existing request. */
export function scheduleMediaSyncWakeup(): void { if (mediaSyncEnabled()) after(async () => { try { await dispatchMediaSync(); } catch (e) { report(e); } }); }
export function scheduleMediaSync(hop = 0): void {
  if (!mediaSyncEnabled()) return;
  if (!Number.isSafeInteger(hop) || hop < 0 || hop > MAX_MEDIA_HOPS) throw new Error("MEDIA_CONTINUATION_INVALID");
  after(async () => { try {
    // Reuse one fixed deadline across the batch, never reset the time budget.
    // Each identity is claimed at most once in this invocation. A busy or
    // blocked identity cannot stop other pending work or cause a retry loop.
    // The budget sits inside the route's maxDuration with headroom for the
    // final finish/continuation calls.
    const deadline = Date.now() + 240000;
    const visited = new Set<string>();
    let processed = 0, morePending = false;
    for (let round = 0; round < 10 && Date.now() + 12000 < deadline; round++) {
      const result = await drainMediaWork(deadline, undefined, undefined, undefined, [...visited]);
      if (!result.claimedProductId) { morePending = false; break; }
      if (visited.has(result.claimedProductId)) throw new Error("MEDIA_QUEUE_BATCH_REPEATED");
      visited.add(result.claimedProductId);
      processed += result.processed;
      morePending = result.continuationNeeded;
      if (!result.continuationNeeded) break;
    }
    // A deep backlog continues in a FRESH invocation (its own budget) instead of
    // waiting for the next cron tick. Strictly bounded: it chains only while this
    // invocation finished real work (a batch of holds, failures or in-flight waits
    // stops and falls back to the cron cadence), only while durable unvisited work
    // remains, and never past MAX_MEDIA_HOPS. Claims, leases, exclusions and every
    // safety gate are exactly the per-invocation ones.
    if (processed > 0 && morePending && hop < MAX_MEDIA_HOPS) await dispatchMediaSync(hop + 1);
  } catch (error) { report(error); } });
}
