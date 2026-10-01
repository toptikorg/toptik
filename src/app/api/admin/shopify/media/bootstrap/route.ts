import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { bootstrapProductionMedia } from "@/lib/shopify/media-bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  const start = Date.now(), denied = requireAdminToken(request); if (denied) return denied;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([request.text(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MEDIA_BOOTSTRAP_INPUT_TIMEOUT")), 3000); })]);
    if (Buffer.byteLength(raw) > 2000) throw new Error("MEDIA_BOOTSTRAP_INPUT_INVALID");
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.productId !== "string" ||
        Object.keys(input).some(k => !["productId", "enable"].includes(k)) || (input.enable !== undefined && typeof input.enable !== "boolean")) throw new Error("MEDIA_BOOTSTRAP_INPUT_INVALID");
    const result = await bootstrapProductionMedia(input.productId, input.enable ?? false, start + 50000);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^(MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "MEDIA_BOOTSTRAP_FAILED";
    return NextResponse.json({ error: code }, { status: /INPUT/.test(code) ? 400 : 409, headers: { "Cache-Control": "no-store" } });
  } finally { if (timer) clearTimeout(timer); }
}
