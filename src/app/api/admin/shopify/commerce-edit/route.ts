import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { readExistingCommerce, editExistingCommerce } from "@/lib/shopify/commerce-existing-runtime";
import { commerceCode } from "@/lib/shopify/commerce-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
export async function GET(request: NextRequest) {
  const auth = await authorizeGalleryAdmin(request); if (!auth.ok) return auth.response;
  if (!hasSupabaseAdminEnv()) return NextResponse.json({ error: "FINALIZE_NOT_CONFIGURED" }, { status: 503, headers });
  try { const id = z.string().uuid().parse(request.nextUrl.searchParams.get("itemId"));
    return NextResponse.json(await readExistingCommerce(createSupabaseServiceRoleClient(), id), { headers });
  } catch (error) { return NextResponse.json({ error: commerceCode(error) }, { status: 409, headers }); }
}
export async function PATCH(request: NextRequest) {
  const start = Date.now(), auth = await authorizeGalleryAdmin(request); if (!auth.ok) return auth.response;
  if (!hasSupabaseAdminEnv()) return NextResponse.json({ error: "FINALIZE_NOT_CONFIGURED" }, { status: 503, headers });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = request.body?.getReader();
  try {
    if (!reader || Number(request.headers.get("content-length") ?? 0) > 8192) throw new Error("FINALIZE_BODY_INVALID");
    const parts: Uint8Array[] = []; let length = 0;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("FINALIZE_TIME_BUDGET")); void reader.cancel().catch(() => {}); }, Math.max(1, start + 5000 - Date.now())); });
    while (true) { const { value, done } = await Promise.race([reader.read(), expired]); if (done) break;
      length += value.length; if (length > 8192) throw new Error("FINALIZE_BODY_INVALID"); parts.push(value); }
    if (timer) clearTimeout(timer);
    const result = await editExistingCommerce(createSupabaseServiceRoleClient(), JSON.parse(Buffer.concat(parts).toString("utf8")), auth.actorId, start + 45000);
    return NextResponse.json(result, { status: result.status === "pending" ? 202 : 200, headers });
  } catch (error) { return NextResponse.json({ error: commerceCode(error) }, { status: 409, headers }); }
  finally { if (timer) clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}
