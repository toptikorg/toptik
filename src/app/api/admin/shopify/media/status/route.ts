import { NextResponse, type NextRequest } from "next/server";
import { requireGalleryAdmin } from "@/lib/admin/gallery-access";
import { readMediaStatus } from "@/lib/shopify/media-status";
import { mediaSyncEnabled } from "@/lib/shopify/media-work-queue";

export const runtime = "nodejs";
export const preferredRegion = "syd1";
const headers = { "Cache-Control": "no-store" };
export async function GET(req: NextRequest) {
  const denied = await requireGalleryAdmin(req); if (denied) return denied;
  try {
    const state = await readMediaStatus(req.nextUrl.searchParams.get("productId"), Date.now() + 5000);
    return NextResponse.json({ ...state, runtimeEnabled: mediaSyncEnabled(), scope: "media_only" }, { headers });
  } catch (error) {
    const code = error instanceof Error && /^MEDIA_[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "MEDIA_STATUS_FAILED";
    return NextResponse.json({ error: code, verified: false }, { status: code.includes("INPUT") ? 400 : 503, headers });
  }
}
