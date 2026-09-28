import { NextRequest, NextResponse } from "next/server";
import { supabaseEnv } from "@/lib/supabase/env";
export async function POST(req: NextRequest) {
  if (!supabaseEnv.adminToken || req.headers.get("x-admin-token") !== supabaseEnv.adminToken)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ error: "התרגום האוטומטי בוטל. יש לערוך תוכן מקצועי במסך תוכן ו-SEO." }, { status: 410 });
}
