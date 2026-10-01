import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { galleryDraftCreationMode, reserveGalleryDraft } from "@/lib/shopify/creation-runtime";
import { galleryCreationDraftSchema } from "@/lib/shopify/creation-policy";
import { MAX_CREATION_HOPS, scheduleGalleryDraftCreation } from "@/lib/shopify/schedule-creation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const saveSchema = z.object({ draft: galleryCreationDraftSchema }).strict();
const runSchema = z.object({ id: z.string().uuid(), hop: z.number().int().min(0).max(MAX_CREATION_HOPS).default(0) }).strict();
const LIMIT = 400000;
const headers = { "Cache-Control": "no-store" };

async function boundedJson(request: NextRequest, deadline: number): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > LIMIT) throw new Error("SYNC_CREATION_BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("SYNC_CREATION_REQUEST_INVALID");
  const parts: Uint8Array[] = []; let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Error("SYNC_CREATION_TIME_BUDGET")); void reader.cancel().catch(() => {});
  }, Math.max(1, deadline - Date.now())); });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired]); if (done) break;
      length += value.byteLength;
      if (length > LIMIT) throw new Error("SYNC_CREATION_BODY_TOO_LARGE");
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { if (timer) clearTimeout(timer); }
}
function enabled() { return galleryDraftCreationMode() && hasSupabaseAdminEnv() && isShopifySyncConfigured(); }
function errorResponse(error: unknown) {
  const code = error instanceof Error && /^SYNC_CREATION_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_CREATION_REQUEST_INVALID";
  return NextResponse.json({ error: code }, { status: code.endsWith("BODY_TOO_LARGE") ? 413 : 409, headers });
}

/** Explicit NEW-only private save. Existing editor/copy/outbox paths are unchanged. */
export async function POST(request: NextRequest) {
  const started = Date.now();
  const denied = requireAdminToken(request); if (denied) return denied;
  if (!enabled()) return NextResponse.json({ error: "SYNC_CREATION_NOT_ENABLED" }, { status: 503, headers });
  try {
    const parsed = saveSchema.safeParse(await boundedJson(request, started + 9000));
    if (!parsed.success) throw new Error("SYNC_CREATION_REQUEST_INVALID");
    if ((parsed.data.draft.manufacturerSku !== null && parsed.data.draft.manufacturerSku !== parsed.data.draft.shopifySku)
      || parsed.data.draft.identityMapping !== null) throw new Error("SYNC_CREATION_USE_VERIFIED_INTENT");
    const record = await reserveGalleryDraft(createSupabaseServiceRoleClient(), parsed.data.draft, started + 9000);
    scheduleGalleryDraftCreation(record.id, 0, started + 55000);
    return NextResponse.json({ id: record.id, stage: record.stage, version: record.version, published: false }, { status: 202, headers });
  } catch (error) { return errorResponse(error); }
}

/** Resume exact durable intent; no unbounded queue scan or client evidence. */
export async function PATCH(request: NextRequest) {
  const started = Date.now();
  const denied = requireAdminToken(request); if (denied) return denied;
  if (!enabled()) return NextResponse.json({ error: "SYNC_CREATION_NOT_ENABLED" }, { status: 503, headers });
  try {
    const parsed = runSchema.safeParse(await boundedJson(request, started + 9000));
    if (!parsed.success) throw new Error("SYNC_CREATION_REQUEST_INVALID");
    scheduleGalleryDraftCreation(parsed.data.id, parsed.data.hop, started + 55000);
    return NextResponse.json({ accepted: true, id: parsed.data.id }, { status: 202, headers });
  } catch (error) { return errorResponse(error); }
}

/** Read status even while disabled; never return private commerce/source bodies. */
export async function GET(request: NextRequest) {
  const denied = requireAdminToken(request); if (denied) return denied;
  const parsed = z.string().uuid().safeParse(request.nextUrl.searchParams.get("id"));
  if (!parsed.success) return NextResponse.json({ error: "SYNC_CREATION_ID_INVALID" }, { status: 400, headers });
  if (!hasSupabaseAdminEnv()) return NextResponse.json({ error: "SYNC_CREATION_NOT_CONFIGURED" }, { status: 503, headers });
  const { data, error } = await createSupabaseServiceRoleClient().from("shopify_gallery_creation_drafts")
    .select("id,catalog_key,stage,version,last_error,created_at,updated_at,product_gid:receipt->>productGid,variant_gid:receipt->>variantGid").eq("id", parsed.data).maybeSingle();
  if (error) return NextResponse.json({ error: "SYNC_CREATION_STATUS_UNAVAILABLE" }, { status: 503, headers });
  return NextResponse.json({ enabled: Boolean(galleryDraftCreationMode()), draft: data }, { headers });
}
