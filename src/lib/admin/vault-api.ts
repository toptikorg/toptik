import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { requireAdminUser } from "@/lib/admin/authz";
import { isVaultConfigured, verifyStepUpToken, STEP_UP_COOKIE, type VaultEntryInput } from "@/lib/admin/vault";
import { isPanelDemo, DEMO_USER } from "@/lib/admin/demo";

/**
 * Gate for vault read/write routes: requires an AUTHORIZED admin (owner/admin
 * role, see authz-core.ts) AND a valid (recent) email-OTP step-up token cookie
 * bound to that user. Returns the user, or a ready NextResponse to short-circuit.
 */
export async function authStepUp(): Promise<{ res: NextResponse } | { user: User }> {
  if (isPanelDemo()) return { user: DEMO_USER };
  const gate = await requireAdminUser();
  if (!gate.ok) return { res: gate.response };
  const { user } = gate;
  if (!isVaultConfigured()) {
    return { res: NextResponse.json({ error: "כספת הסיסמאות אינה מוגדרת בשרת" }, { status: 503 }) };
  }
  const token = (await cookies()).get(STEP_UP_COOKIE)?.value;
  if (!verifyStepUpToken(token, user.id)) {
    return { res: NextResponse.json({ error: "נדרש אימות מחדש" }, { status: 403 }) };
  }
  return { user };
}

export function parseVaultInput(body: unknown): VaultEntryInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const label = String(b.label ?? "").trim();
  const secret = String(b.secret ?? "");
  if (!label || !secret) return null;
  return {
    label,
    username: String(b.username ?? "").trim(),
    secret,
    url: b.url ? String(b.url).trim() : null,
    notes: b.notes ? String(b.notes).trim() : null,
  };
}
