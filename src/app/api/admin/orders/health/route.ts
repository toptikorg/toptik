import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { markOrderAuditFailed, runOrderHealthAudit } from "@/lib/orders/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function requireCronAuthorization(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!secret || !provided) return false;
  const a = Buffer.from(secret), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!requireCronAuthorization(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await runOrderHealthAudit();
    return NextResponse.json(result, { status: result.status === "healthy" ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch (error) {
    await markOrderAuditFailed(error);
    console.error("TopTik order health audit failed", { code: error instanceof Error ? error.message : "ORDER_HEALTH_ERROR" });
    return NextResponse.json({ status: "unhealthy", issueCodes: ["HEALTH_AUDIT_FAILED"] }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
