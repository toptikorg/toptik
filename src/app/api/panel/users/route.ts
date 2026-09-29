import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { requireOwnerUser } from "@/lib/admin/authz";
import { deleteAdmin, createAdminWithPassword, listAdminUsers } from "@/lib/admin/users";
import { isPanelDemo, DEMO_USERS } from "@/lib/admin/demo";

export const runtime = "nodejs";

const createSchema = z.object({
  email: z.string().email("כתובת מייל לא תקינה"),
  password: z.string().min(10, "הסיסמה חייבת להכיל לפחות 10 תווים"),
});

// Admin-user management is owner-only: anonymous → 401, any other signed-in
// user (admin, or a user without a panel role) → 403. Each handler calls the
// gate first, before any service-role operation.
function adminEnvMissing(): NextResponse | null {
  return hasSupabaseAdminEnv()
    ? null
    : NextResponse.json({ error: "Supabase admin env not configured" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  if (isPanelDemo()) return NextResponse.json({ users: DEMO_USERS });
  const gate = await requireOwnerUser();
  if (!gate.ok) return gate.response;
  const envMissing = adminEnvMissing();
  if (envMissing) return envMissing;
  try {
    return NextResponse.json({ users: await listAdminUsers() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list users";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireOwnerUser();
  if (!gate.ok) return gate.response;
  const envMissing = adminEnvMissing();
  if (envMissing) return envMissing;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "קלט לא תקין" }, { status: 400 });
  }

  try {
    const created = await createAdminWithPassword(parsed.data.email.trim(), parsed.data.password);
    return NextResponse.json({ ok: true, user: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "יצירת המנהל נכשלה";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const gate = await requireOwnerUser();
  if (!gate.ok) return gate.response;
  const envMissing = adminEnvMissing();
  if (envMissing) return envMissing;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "חסר מזהה משתמש" }, { status: 400 });

  try {
    await deleteAdmin(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "המחיקה נכשלה";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
