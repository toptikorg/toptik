import { NextRequest, NextResponse } from "next/server";
import { createPanelServerClient } from "@/lib/admin/supabase-server";
import { requireAdminUser } from "@/lib/admin/authz";
import {
  isVaultConfigured,
  listVaultEntries,
  issueStepUpToken,
  STEP_UP_COOKIE,
  STEP_UP_MAX_AGE,
} from "@/lib/admin/vault";
import { isPanelDemo } from "@/lib/admin/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Step 2 of the vault gate — verify the OTP, open a short step-up window, and
 *  return the decrypted entries. Requires an authorized admin FIRST: a valid
 *  OTP alone never opens the vault. */
export async function POST(req: NextRequest) {
  if (isPanelDemo()) return NextResponse.json({ ok: true, entries: await listVaultEntries() });
  const gate = await requireAdminUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  if (!user.email) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!isVaultConfigured()) {
    return NextResponse.json({ error: "כספת הסיסמאות אינה מוגדרת בשרת" }, { status: 503 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { code?: string };
    const code = String(body.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "יש להזין קוד בן 6 ספרות" }, { status: 400 });
    }
    const supabase = await createPanelServerClient();
    const { error } = await supabase.auth.verifyOtp({ email: user.email, token: code, type: "email" });
    if (error) return NextResponse.json({ error: "קוד שגוי או שפג תוקפו" }, { status: 400 });

    const entries = await listVaultEntries();
    const res = NextResponse.json({ ok: true, entries });
    res.cookies.set(STEP_UP_COOKIE, issueStepUpToken(user.id), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: STEP_UP_MAX_AGE,
    });
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
