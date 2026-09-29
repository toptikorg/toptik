import { NextResponse } from "next/server";

// This public diagnostic route listed the title, id and colour grouping of
// every active gallery item. Nothing in the gallery, the admin tools or the
// tests consumes it, so it is closed and answers 404 like the retired
// /api/debug-scrape route.
const NOT_FOUND = () =>
  NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export const GET = NOT_FOUND;
export const POST = NOT_FOUND;
