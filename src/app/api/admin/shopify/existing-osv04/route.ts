import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { admitExistingOsv04 } from "@/lib/shopify/osv04-admission";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request); if (denied) return denied;
  try { return NextResponse.json(await admitExistingOsv04(Date.now() + 45000), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { const message = error instanceof Error && /^SYNC_OSV04_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_OSV04_ADMISSION_FAILED";
    return NextResponse.json({ error: message }, { status: 409, headers: { "Cache-Control": "no-store" } }); }
}
