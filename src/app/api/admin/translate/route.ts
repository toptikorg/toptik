import { NextRequest, NextResponse } from "next/server";
import { supabaseEnv } from "@/lib/supabase/env";

// GAL-009: unattended translation is retired; manual editing/import remain.
export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(req: NextRequest) {
  const token = req.headers.get("x-admin-token");
  return Boolean(token && supabaseEnv.adminToken && token === supabaseEnv.adminToken);
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    error: "התרגום האוטומטי הושבת. יש לערוך תיאור מקצועי לפי מפרט היצרן והמק״ט המדויק.",
  }, { status: 410 });
}
