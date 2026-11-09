import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { ownedFamilyForItem } from "@/lib/shopify/owned-edit-service";
import { applyOwnedMediaEdit, readOwnedMediaEditor, readOwnedMediaAdoptionSource, resumeOwnedMediaEdit } from "@/lib/shopify/owned-media-service";
import { scheduleMediaSyncWakeup } from "@/lib/shopify/media-schedule";

export const runtime = "nodejs";
export const maxDuration = 60;
const uuid = z.string().uuid();
const mediaId = z.string().regex(/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/);
const alt = z.string().min(1).max(512).refine(value => value === value.trim());
const image = z.union([
  z.object({ mediaId, alt: z.string().max(512).refine(value => value === value.trim()) }).strict(),
  z.object({ mediaId: z.null(), uploadUrl: z.string().url().max(4096), alt }).strict(),
]);
const edit = z.object({ action: z.literal("edit"), requestId: uuid, itemId: uuid,
  expectedMapVersion: z.number().int().positive(), expectedSourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  desiredImages: z.array(image).min(1).max(20),
  assignments: z.array(z.object({ mediaId, itemIds: z.array(uuid).min(1).max(50) }).strict()).max(50).optional(),
}).strict();
const resume = z.object({ action: z.literal("resume"), requestId: uuid, itemId: uuid }).strict();
const schema = z.discriminatedUnion("action", [edit, resume]);
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const message = "בדיקת התמונות לא הושלמה. העריכה לא נזרקה. יש לבדוק את אותה פעולה לפני שינוי נוסף.";
const safeCode = (error: unknown) => error instanceof Error && /^(?:GROUP_MEDIA_|OWNED_MEDIA_|MEDIA_|SYNC_)[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "OWNED_MEDIA_REQUEST_FAILED";

export async function GET(request: NextRequest) {
  const auth = await authorizeGalleryAdmin(request);
  if (!auth.ok) return auth.response;
  const id = uuid.safeParse(request.nextUrl.searchParams.get("itemId"));
  if (!id.success || !ownedFamilyForItem(id.data)) return reply({ error: "OWNED_MEDIA_ITEM_UNKNOWN", message: "הכרטיס לא נמצא." }, 404);
  try {
    if (request.nextUrl.searchParams.get("view") === "source") return reply(await readOwnedMediaAdoptionSource(id.data, Date.now() + 50_000));
    return reply(await readOwnedMediaEditor(createSupabaseServiceRoleClient(), id.data, Date.now() + 50_000));
  }
  catch (error) { return reply({ error: safeCode(error), message }, 409); }
}

export async function POST(request: NextRequest) {
  const requestDeadline = Date.now() + 55_000;
  const auth = await authorizeGalleryAdmin(request, { sessionMutation: true });
  if (!auth.ok) return auth.response;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return reply({ error: "OWNED_MEDIA_REQUEST_INVALID", message: "יש לשלוח בקשת JSON." }, 415);
  }
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 120_000) return reply({ error: "OWNED_MEDIA_REQUEST_TOO_LARGE", message: "הבקשה גדולה מדי." }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reply({ error: "OWNED_MEDIA_REQUEST_INVALID", message: "הבקשה אינה תקינה." }, 400); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return reply({ error: "OWNED_MEDIA_REQUEST_INVALID", message: "הבקשה אינה תקינה." }, 400);
    const input = parsed.data, family = ownedFamilyForItem(input.itemId);
    if (!family) return reply({ error: "OWNED_MEDIA_ITEM_UNKNOWN", message: "הכרטיס לא נמצא." }, 404);
    const db = createSupabaseServiceRoleClient(), owner = randomUUID(), deadline = requestDeadline - 5000;
    async function leaseCall(name: string, args: Record<string, unknown>, stop: number) {
      const ms = Math.min(4000, stop - Date.now());
      if (ms <= 0) throw new Error("OWNED_MEDIA_TIME_BUDGET");
      let query = db.rpc(name, args);
      if (typeof query.abortSignal === "function") query = query.abortSignal(AbortSignal.timeout(ms));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([Promise.resolve(query), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("OWNED_MEDIA_TIME_BUDGET")), ms);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    const { data, error } = await leaseCall("acquire_shopify_reconciliation_lease", { p_product_gid: family.productGid, p_owner: owner }, deadline);
    if (error || data !== true) return reply({ error: "SYNC_RECONCILIATION_BUSY", message: "המוצר מתעדכן כרגע. לא נשלח שינוי חדש." }, 409);
    try {
      const actor = { actorType: auth.authMethod === "session" ? "supabase_user" as const : "admin_panel_token" as const, actorId: auth.actorId };
      const result = input.action === "edit"
        ? await applyOwnedMediaEdit(db, input, { owner, actor, deadline })
        : await resumeOwnedMediaEdit(db, input, { owner, actor, deadline });
      return reply(result, result.status === "pending" ? 202 : 200);
    } finally {
      try {
        const released = await leaseCall("release_shopify_reconciliation_lease", { p_product_gid: family.productGid, p_owner: owner }, requestDeadline);
        if (released.error) console.error("Owned media lease release failed");
      } catch { console.error("Owned media lease release unavailable; lease will expire"); }
      // A durable operation may have been prepared even if the HTTP response was
      // lost. Wake the existing worker; its periodic cron is the recovery fallback.
      try { scheduleMediaSyncWakeup(); } catch { console.error("Owned media wakeup registration failed"); }
    }
  } catch (error) { return reply({ error: safeCode(error), message }, 409); }
}
