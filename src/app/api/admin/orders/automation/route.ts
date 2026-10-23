import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runOrderAutomation } from "@/lib/orders/worker";
import { ensureOrderWebhookSubscriptions } from "@/lib/orders/shopify-webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function requireCronAuthorization(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!secret || !provided) return false;
  const a = Buffer.from(secret), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!requireCronAuthorization(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const webhooks = await ensureOrderWebhookSubscriptions();
  const results = await runOrderAutomation(5);
  console.info("TopTik order automation tick", {
    webhookExisting: webhooks.existing.length,
    webhookCreated: webhooks.created.length,
    processed: results.length,
  });
  return NextResponse.json({ webhooks, processed: results.length, results: results.map(result => result.result) });
}

