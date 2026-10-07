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
    // Durable terminal review/failure may advance independent pending items.
    // Busy/no-progress still stops; pending-only continuation cannot spin on failures.
    const deadline = Date.now() + 40000;
    for (let round = 0; round < 10 && Date.now() + 12000 < deadline; round++) {
      const result = await drainMediaWork(deadline);
      if (!result.continuationNeeded) break;
    }
    // Durable pending work resumes on the next independent cron tick.
  } catch (error) { report(error); } });
}
