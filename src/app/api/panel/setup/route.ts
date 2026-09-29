import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { createPrimaryAdmin } from "@/lib/admin/users";
import { isValidSetupToken } from "@/lib/admin/admin-token";

export const runtime = "nodejs";

const setupSchema = z.object({
  email: z.string().email("כתובת מייל לא תקינה"),
  password: z.string().min(10, "סיסמה חייבת לפחות 10 תווים"),
  token: z.string().optional(),
});

// No public GET: whether accounts exist is not disclosed to anonymous visitors
// (it used to be read with the service role). Setup is decided by POST only.

/** POST → create the primary owner (guarded by the one-time setup token; the
 *  service role is reached only after the token check, and createPrimaryAdmin
 *  refuses once any account exists). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasSupabaseAdminEnv()) {
    return NextResponse.json({ error: "Supabase admin env not configured" }, { status: 500 });
  }

  const parsed = setupSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "קלט לא תקין" }, { status: 400 });
  }

  const providedToken = parsed.data.token ?? req.headers.get("x-admin-token") ?? "";
  if (!isValidSetupToken(providedToken)) {
    return NextResponse.json({ error: "טוקן הקמה שגוי" }, { status: 401 });
  }

  try {
    await createPrimaryAdmin(parsed.data.email.trim(), parsed.data.password);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ההקמה נכשלה";
    const status = message.includes("הקמה כבר בוצעה") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
