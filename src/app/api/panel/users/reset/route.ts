import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { requireOwnerUser } from "@/lib/admin/authz";
import { setAdminPassword } from "@/lib/admin/users";

export const runtime = "nodejs";

const resetSchema = z.object({
  id: z.string().min(1, "חסר מזהה משתמש"),
  password: z.string().min(10, "הסיסמה חייבת להכיל לפחות 10 תווים"),
});

/** Owner-initiated password reset: sets a new password directly (no email). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireOwnerUser();
  if (!gate.ok) return gate.response;
  if (!hasSupabaseAdminEnv()) {
    return NextResponse.json({ error: "Supabase admin env not configured" }, { status: 500 });
  }

  const parsed = resetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "קלט לא תקין" }, { status: 400 });
  }

  try {
    await setAdminPassword(parsed.data.id, parsed.data.password);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "איפוס הסיסמה נכשל";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
