import { NextResponse, type NextRequest } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { getCarouselPayload } from "@/lib/carousel/repository";
import { auditSelfHostedMedia, type SelfHostedAuditItem } from "@/lib/shopify/self-hosted-media-audit";

export const runtime = "nodejs";
export const preferredRegion = "syd1";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

// Admin/cron, strictly read-only. One bounded gallery read; it can never link,
// upload, enqueue, approve or mutate either platform. It FLAGS self-hosted
// gallery angles as candidates for human review (documented exemptions in
// self-hosted-media-audit.ts); the actual relink stays human-verified.
//
// Runs on a low-frequency cron (see vercel.json) so the "self-hosted media that
// should point at an existing store photo" condition can never again sit
// unnoticed — including for any future import, which is born self-hosted.
async function run(req: NextRequest) {
  const denied = requireAdminToken(req, { allowCron: true });
  if (denied) return denied;
  try {
    const payload = await getCarouselPayload({ includeInactive: true, rawAdmin: true });
    const items: SelfHostedAuditItem[] = (payload.items ?? []).map(item => ({
      id: item.id,
      catalogNumber: item.catalogNumber ?? null,
      angles: (item.angles ?? []).map(a => ({
        angleOrder: a.angleOrder,
        angleKey: a.angleKey,
        imagePath: a.imagePath,
      })),
    }));
    const audit = auditSelfHostedMedia(items);
    return NextResponse.json(
      { fetchedAt: new Date().toISOString(), ...audit },
      { headers },
    );
  } catch {
    // Never leak provider detail; a failed read is "unavailable", not "clean".
    return NextResponse.json({ error: "RECONCILE_AUDIT_READ_FAILED" }, { status: 503, headers });
  }
}

export const GET = run;
export const POST = run;
