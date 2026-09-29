import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";

// GAL-009: unattended translation is retired; manual editing/import remain.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const denied = requireAdminToken(req);
  if (denied) return denied;

  return NextResponse.json({
    error: "התרגום האוטומטי הושבת. יש לערוך תיאור מקצועי לפי מפרט היצרן והמק״ט המדויק.",
  }, { status: 410 });
}
