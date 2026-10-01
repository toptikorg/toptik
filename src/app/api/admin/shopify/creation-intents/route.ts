import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { galleryDraftCreationMode } from "@/lib/shopify/creation-runtime";
import { creationIntentInputSchema, assessCreationIntent } from "@/lib/shopify/creation-intent";
import { loadCreationIntent, promoteCreationIntent, savePendingCreationIntent } from "@/lib/shopify/creation-intent-runtime";
import { scheduleGalleryDraftCreation } from "@/lib/shopify/schedule-creation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const saveSchema = z.object({ input: creationIntentInputSchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
const promoteSchema = z.object({ id: z.string().uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
async function body(request: NextRequest, deadline: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader || Number(request.headers.get("content-length") ?? 0) > 400000) throw new Error("SYNC_CREATION_BODY_TOO_LARGE");
  const parts: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Error("SYNC_CREATION_INTENT_TIME_BUDGET")); void reader.cancel().catch(() => {});
  }, Math.max(1, deadline - Date.now())); });
  try { while (true) { const { value, done } = await Promise.race([reader.read(), expired]); if (done) break;
    size += value.byteLength; if (size > 400000) throw new Error("SYNC_CREATION_BODY_TOO_LARGE"); parts.push(value);
  } return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { if (timer) clearTimeout(timer); }
}
function failure(error: unknown) {
  const code = error instanceof Error && /^SYNC_CREATION_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_CREATION_INTENT_REQUEST_INVALID";
  return NextResponse.json({ error: code }, { status: code.endsWith("BODY_TOO_LARGE") ? 413 : 409, headers });
}
function configured(write = false) {
  return hasSupabaseAdminEnv() && (!write || Boolean(galleryDraftCreationMode()));
}
export async function GET(request: NextRequest) {
  const denied = await requireGalleryAdmin(request); if (denied) return denied;
  if (!configured()) return NextResponse.json({ error: "SYNC_CREATION_INTENT_NOT_CONFIGURED" }, { status: 503, headers });
  try {
    const db = createSupabaseServiceRoleClient(), raw = request.nextUrl.searchParams.get("id");
    if (raw) {
      const id = z.string().uuid().parse(raw), item = await loadCreationIntent(db, id);
      const { data: creation, error } = await db.from("shopify_gallery_creation_drafts").select("id,stage,last_error,updated_at,product_gid,variant_gid")
        .eq("id", id).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
      if (error) throw new Error("SYNC_CREATION_INTENT_STATUS_FAILED");
      const { data: sourceImport, error: sourceError } = await db.from("shopify_gallery_creation_imports")
        .select("raw_source,source_hash,created_at").eq("intent_id", id).abortSignal(AbortSignal.timeout(3000)).maybeSingle();
      if (sourceError) throw new Error("SYNC_CREATION_IMPORT_READ_FAILED");
      return NextResponse.json({ enabled: Boolean(galleryDraftCreationMode()), item,
        readiness: item ? assessCreationIntent(item.record) : null, creation, sourceImport }, { headers });
    }
    const { data, error } = await db.from("shopify_gallery_creation_intents")
      .select("id,revision,frozen_at,updated_at,title:record->input->copy->>title,sku:record->input->>shopifySku")
      .order("updated_at", { ascending: false }).limit(100).abortSignal(AbortSignal.timeout(5000));
    if (error) throw new Error("SYNC_CREATION_INTENT_READ_FAILED");
    return NextResponse.json({ enabled: Boolean(galleryDraftCreationMode()), items: data }, { headers });
  } catch (error) { return failure(error); }
}
export async function PUT(request: NextRequest) {
  const started = Date.now();
  const denied = await requireGalleryAdmin(request); if (denied) return denied;
  if (!configured(true)) return NextResponse.json({ error: "SYNC_CREATION_INTENT_NOT_ENABLED" }, { status: 503, headers });
  try {
    const data = saveSchema.parse(await body(request, started + 9000));
    const result = await savePendingCreationIntent(createSupabaseServiceRoleClient(), data.input, data.expectedRevision, started + 9000);
    if (result.creation) scheduleGalleryDraftCreation(result.creation.id, 0, started + 55000);
    return NextResponse.json({ saved: true, ...result, published: false }, { status: result.creation ? 202 : 200, headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const started = Date.now();
  const denied = await requireGalleryAdmin(request); if (denied) return denied;
  if (!configured(true)) return NextResponse.json({ error: "SYNC_CREATION_INTENT_NOT_ENABLED" }, { status: 503, headers });
  try {
    const data = promoteSchema.parse(await body(request, started + 9000));
    const result = await promoteCreationIntent(createSupabaseServiceRoleClient(), data.id, data.expectedRevision, started + 9000);
    scheduleGalleryDraftCreation(result.id, 0, started + 55000);
    return NextResponse.json({ accepted: true, ...result, published: false }, { status: 202, headers });
  } catch (error) { return failure(error); }
}
