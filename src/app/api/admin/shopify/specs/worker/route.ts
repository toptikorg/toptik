import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { typedSpecSyncEnabled } from "@/lib/shopify/typed-spec-worker";
import { scheduleTypedSpecSync, validTypedSpecHop } from "@/lib/shopify/schedule-typed-spec-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Internal bounded wakeup; it accepts no product edits or caller-selected destination. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request); if (denied) return denied;
  const hop = validTypedSpecHop(request.nextUrl.searchParams.get("hop"));
  if (hop === null) return NextResponse.json({ error: "SPEC_CONTINUATION_INVALID" }, { status: 400 });
  if (!typedSpecSyncEnabled() || !hasSupabaseAdminEnv() || !isShopifySyncConfigured()) {
    return NextResponse.json({ error: "SPEC_DISABLED" }, { status: 503 });
  }
  scheduleTypedSpecSync(hop);
  return NextResponse.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
