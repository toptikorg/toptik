import { NextRequest, NextResponse } from "next/server";
import { supabaseEnv } from "@/lib/supabase/env";
import { approvedSourceUrl } from "@/lib/catalog-source/source-allowlist";
import { safeSourceFetch } from "@/lib/catalog-source/safe-fetch";
import { scrapeDiagnostics } from "@/lib/catalog-source/scrape-diagnostics";

// Admin-only scrape diagnostics (GAL-026). Requires the admin token and only
// reaches approved manufacturer HTTPS sources through safeSourceFetch.
// Read-only: it never writes to the database.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest) {
  const token = req.headers.get("x-admin-token");
  return Boolean(token && supabaseEnv.adminToken && token === supabaseEnv.adminToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.searchParams.get("url");
  if (!approvedSourceUrl(url)) {
    return NextResponse.json({ error: "source_not_approved" }, { status: 400 });
  }
  const result = await scrapeDiagnostics(url!, (target, init) => safeSourceFetch(target, init));
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
