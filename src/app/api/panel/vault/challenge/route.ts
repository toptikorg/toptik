import { NextResponse } from "next/server";
import { createPanelServerClient } from "@/lib/admin/supabase-server";
import { requireAdminUser } from "@/lib/admin/authz";
import { isVaultConfigured } from "@/lib/admin/vault";
import { isPanelDemo, DEMO_MASKED_EMAIL } from "@/lib/admin/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return email;
  const head = name.slice(0, 2);
  return `${head}${"•".repeat(Math.max(1, name.length - head.length))}@${domain}`;
}

/** Step 1 of the vault gate — email a fresh 6-digit OTP to an AUTHORIZED admin.
 *  A signed-in user without a panel role gets 403 and no code is sent. */
export async function POST() {
  if (isPanelDemo()) return NextResponse.json({ ok: true, email: DEMO_MASKED_EMAIL });
  const gate = await requireAdminUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  if (!user.email) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!isVaultConfigured()) {
    return NextResponse.json({ error: "כספת הסיסמאות אינה מוגדרת בשרת" }, { status: 503 });
  }
  try {
    const supabase = await createPanelServerClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: user.email,
      options: { shouldCreateUser: false },
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, email: maskEmail(user.email) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to send verification code";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
