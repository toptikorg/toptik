import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { commercialPublicationMode } from "@/lib/shopify/commerce-mode";
import { commerceCode, commerceEditSchema, commerceStatus, saveCommerceEdit } from "@/lib/shopify/commerce-runtime";
import { COMMERCE_MAX_HOPS, scheduleCommercialPublication } from "@/lib/shopify/commerce-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
function failure(error: unknown) { return NextResponse.json({ error: commerceCode(error) }, { status: 409, headers }); }
async function body(request: NextRequest, deadline: number): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > 8192 || !request.body) throw new Error("FINALIZE_BODY_INVALID");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("FINALIZE_TIME_BUDGET")); void reader.cancel().catch(() => {}); }, Math.max(1, deadline - Date.now())); });
  try { while (true) { const { value, done } = await Promise.race([reader.read(), timeout]); if (done) break;
    size += value.length; if (size > 8192) throw new Error("FINALIZE_BODY_INVALID"); chunks.push(value);
  } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  finally { if (timer) clearTimeout(timer); await reader.cancel().catch(() => {}); }
}
export async function GET(request: NextRequest) {
  const auth = await authorizeGalleryAdmin(request); if (!auth.ok) return auth.response;
  if (!hasSupabaseAdminEnv()) return NextResponse.json({ error: "FINALIZE_NOT_CONFIGURED" }, { status: 503, headers });
  try { return NextResponse.json(await commerceStatus(createSupabaseServiceRoleClient(), request.nextUrl.searchParams.get("itemId") ?? undefined), { headers }); }
  catch (error) { return failure(error); }
}
export async function PUT(request: NextRequest) {
  const start = Date.now(), auth = await authorizeGalleryAdmin(request); if (!auth.ok) return auth.response;
  if (!hasSupabaseAdminEnv() || !commercialPublicationMode(process.env)) return NextResponse.json({ error: "FINALIZE_NOT_ENABLED" }, { status: 503, headers });
  try {
    const edit = commerceEditSchema.parse(await body(request, start + 9000));
    const intent = await saveCommerceEdit(createSupabaseServiceRoleClient(), edit, start + 9000, auth.actorId);
    scheduleCommercialPublication(edit.itemId, 0, start + 55000);
    return NextResponse.json({ saved: true, revision: intent.revision, status: "pending", published: false }, { status: 202, headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const start = Date.now(), auth = await authorizeGalleryAdmin(request); if (!auth.ok) return auth.response;
  if (!hasSupabaseAdminEnv() || !commercialPublicationMode(process.env)) return NextResponse.json({ error: "FINALIZE_NOT_ENABLED" }, { status: 503, headers });
  try {
    const rawHop = request.nextUrl.searchParams.get("continue"), hop = rawHop === null ? 0 : Number(rawHop);
    if ((rawHop !== null && !/^[1-9][0-9]*$/.test(rawHop)) || !Number.isSafeInteger(hop) || hop < 0 || hop > COMMERCE_MAX_HOPS) throw new Error("FINALIZE_HOP_INVALID");
    const data = z.object({ itemId: z.string().uuid() }).strict().parse(await body(request, start + 9000));
    scheduleCommercialPublication(data.itemId, hop, start + 55000);
    return NextResponse.json({ accepted: true, published: false }, { status: 202, headers });
  } catch (error) { return failure(error); }
}
