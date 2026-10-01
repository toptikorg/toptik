import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireAdminToken, type AdminTokenOptions } from "@/lib/admin/admin-token";
import { requireAdminUser } from "@/lib/admin/authz";
import { allowsGallerySessionRequest } from "@/lib/admin/gallery-session-policy";

type GalleryAccessOptions = AdminTokenOptions & { sessionMutation?: boolean };
type GalleryAccess =
  | { ok: true; actorId: string; authMethod: "token" | "session" }
  | { ok: false; response: NextResponse };

// The existing automation principal identifies token-authenticated operations,
// never a person asserted by the browser.
const AUTOMATION_ACTOR = "f4a10335-5d41-4b70-9e16-93bb74a52eba";

export async function authorizeGalleryAdmin(req: NextRequest, options: GalleryAccessOptions = {}): Promise<GalleryAccess> {
  if (!requireAdminToken(req, options)) return { ok: true, actorId: AUTOMATION_ACTOR, authMethod: "token" };
  const access = await requireAdminUser();
  if (!access.ok) return access;
  if (!allowsGallerySessionRequest(req.method, req.nextUrl.origin, req.headers, options.sessionMutation)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden origin" }, { status: 403 }) };
  }
  return { ok: true, actorId: access.user.id, authMethod: "session" };
}

/** Interactive editor only. Workers retain their token/cron-only gates. */
export async function requireGalleryAdmin(req: NextRequest, options: GalleryAccessOptions = {}): Promise<NextResponse | null> {
  const access = await authorizeGalleryAdmin(req, options);
  return access.ok ? null : access.response;
}
