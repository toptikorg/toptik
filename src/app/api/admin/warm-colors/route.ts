import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";

export const runtime = "nodejs";

/** Legacy warming uploaded random-UUID images before its review guard, so a
 * rejected assignment still consumed storage. Keep this route held before
 * scraping, uploads or reset/recolor writes. Restoring it requires a reviewed
 * replacement; query parameters and a cron/admin token cannot lift the hold. */
export async function POST(req: NextRequest) {
  const denied = requireAdminToken(req, { allowQueryToken: true, allowCron: true });
  if (denied) return denied;
  return NextResponse.json({
    error: "MEDIA_REVIEW_REQUIRED",
    held: true,
    reason: "Legacy color warming is paused before storage and catalog mutations.",
  }, { status: 409 });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
