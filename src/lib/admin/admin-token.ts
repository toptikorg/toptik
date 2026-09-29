import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "@/lib/supabase/env";

// Gate for the legacy token-only routes (/api/admin/* used by the gallery
// editor, imports and the Vercel cron). These routes never read a Supabase
// session, so a signed-in panel user — including anyone who signed up — cannot
// reach them without ADMIN_PANEL_TOKEN (or CRON_SECRET where allowed).
// Comparison is constant-time.

function sameSecret(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** One-time panel setup token check (same ADMIN_PANEL_TOKEN), constant-time. */
export function isValidSetupToken(provided: string | null | undefined): boolean {
  return sameSecret(provided, supabaseEnv.adminToken);
}

export interface AdminTokenOptions {
  /** Also accept ?token= (existing curl/MCP use of the warm-up and probe routes). */
  allowQueryToken?: boolean;
  /** Also accept `Authorization: Bearer <CRON_SECRET>` (Vercel Cron). */
  allowCron?: boolean;
}

/** Returns a 401 response when the request carries no valid token, else null. */
export function requireAdminToken(req: NextRequest, options: AdminTokenOptions = {}): NextResponse | null {
  const header = req.headers.get("x-admin-token");
  const query = options.allowQueryToken ? req.nextUrl.searchParams.get("token") : null;
  if (sameSecret(header ?? query, supabaseEnv.adminToken)) return null;
  if (options.allowCron) {
    const cronSecret = process.env.CRON_SECRET;
    const auth = req.headers.get("authorization");
    if (cronSecret && auth && sameSecret(auth, `Bearer ${cronSecret}`)) return null;
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
