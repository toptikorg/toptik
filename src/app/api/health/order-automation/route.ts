import { NextResponse } from "next/server";
import { readPublicOrderHealth } from "@/lib/orders/health-public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await readPublicOrderHealth();
  return NextResponse.json(result, {
    status: result.status === "healthy" ? 200 : 503,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
