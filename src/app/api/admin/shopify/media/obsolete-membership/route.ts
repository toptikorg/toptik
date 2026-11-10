import { NextResponse, type NextRequest } from "next/server";
import { authorizeGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { handleObsoleteMembership, parseObsoleteMembershipCommand } from "@/lib/shopify/media-obsolete-membership";
import { scheduleMediaSyncWakeup } from "@/lib/shopify/media-schedule";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "syd1";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  const auth = await authorizeGalleryAdmin(request, { sessionMutation: true });
  if (!auth.ok) return auth.response;
  const deadline = Date.now() + 55000;
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
      return reply({ error: "MEDIA_OBSOLETE_INPUT_INVALID" }, 415);
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024)) return reply({ error: "MEDIA_OBSOLETE_INPUT_LIMIT" }, 413);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "MEDIA_OBSOLETE_INPUT_INVALID" }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error("MEDIA_OBSOLETE_TIME_BUDGET");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("MEDIA_OBSOLETE_TIME_BUDGET")), ms);
        })]).finally(() => { if (timer) clearTimeout(timer); });
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024) throw new Error("MEDIA_OBSOLETE_INPUT_LIMIT");
        chunks.push(part.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("MEDIA_OBSOLETE_INPUT_INVALID"); }
    const input = parseObsoleteMembershipCommand(value);
    const result = await handleObsoleteMembership(createSupabaseServiceRoleClient(), input, auth.authMethod === "session"
      ? { actorType: "supabase_user", actorId: auth.actorId }
      : { actorType: "admin_panel_token", actorId: "configured-admin-panel" }, deadline);
    if (result.decisionRecorded) scheduleMediaSyncWakeup();
    return reply(result);
  } catch (error) {
    const code = error instanceof Error && /^(?:MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "MEDIA_OBSOLETE_FAILED";
    return reply({ error: code, syncVerified: false }, code === "MEDIA_OBSOLETE_INPUT_LIMIT" ? 413 : code.includes("INPUT") ? 400 : 409);
  }
}
