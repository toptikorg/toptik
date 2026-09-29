import { NextResponse } from "next/server";

// GAL-026: this public route used to fetch any URL it was given (an open
// server-side proxy). It is closed. The diagnostics now live behind admin
// authentication at /api/admin/debug-scrape and use the guarded fetcher.
const NOT_FOUND = () =>
  NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export const GET = NOT_FOUND;
export const POST = NOT_FOUND;
