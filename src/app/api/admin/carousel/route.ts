import { NextRequest, NextResponse } from "next/server";
import { getCarouselPayload, saveCarouselPayload } from "@/lib/carousel/repository";
import { supabaseEnv } from "@/lib/supabase/env";
import { CAROUSEL_UNAVAILABLE_MESSAGE, isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";

function isAuthorized(req: NextRequest) {
  const token = req.headers.get("x-admin-token");
  return Boolean(token && supabaseEnv.adminToken && token === supabaseEnv.adminToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await getCarouselPayload({ includeInactive: true });
    if (isUnavailableCarouselPayload(payload)) {
      return NextResponse.json({ error: CAROUSEL_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    return NextResponse.json(payload);
  } catch (error) {
    console.error("GET /api/admin/carousel failed", error);
    return NextResponse.json({ error: "Failed to load admin data" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    await saveCarouselPayload(body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PUT /api/admin/carousel failed", error);
    const message = error instanceof Error ? error.message : "Failed to save carousel data";
    const status = message.includes("Missing Supabase admin env vars") ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
