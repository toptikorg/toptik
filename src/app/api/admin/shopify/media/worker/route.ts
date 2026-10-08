import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { mediaSyncEnabled } from "@/lib/shopify/media-work-queue";
import { scheduleMediaSync, validMediaHop } from "@/lib/shopify/media-schedule";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request); if (denied) return denied;
  const hop = validMediaHop(request.nextUrl.searchParams.get("hop"));
  if (hop === null) return NextResponse.json({ error: "MEDIA_CONTINUATION_INVALID" }, { status: 400 });
  if (!mediaSyncEnabled()) return NextResponse.json({ error: "MEDIA_DISABLED" }, { status: 409 });
  scheduleMediaSync(hop);
  return NextResponse.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
