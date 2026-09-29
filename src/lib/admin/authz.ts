import "server-only";

import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getPanelUser } from "@/lib/admin/supabase-server";
import { authorizePanelUser, type PanelRole } from "@/lib/admin/authz-core";

export type { PanelRole } from "@/lib/admin/authz-core";

// Central server-side gates for the admin panel. Every route handler, server
// action and page that reaches the service role must call the matching gate
// FIRST (tests/admin-authz.test.mjs checks each entry point):
//   requireAdminUser / requireOwnerUser  → route handlers (401 / 403 JSON)
//   requireAdminPage / requireOwnerPage  → server-rendered panel pages
// Token-only legacy routes (/api/admin/*) use requireAdminToken instead.

export type PanelGate =
  | { ok: true; user: User; role: PanelRole }
  | { ok: false; response: NextResponse };

async function gate(required: PanelRole): Promise<PanelGate> {
  const user = await getPanelUser();
  const decision = authorizePanelUser(user, required);
  if (!decision.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: decision.status === 401 ? "Unauthorized" : "Forbidden" },
        { status: decision.status },
      ),
    };
  }
  return { ok: true, user: user as User, role: decision.role };
}

/** Owner or admin. Anonymous → 401; signed in without a panel role → 403. */
export function requireAdminUser(): Promise<PanelGate> {
  return gate("admin");
}

/** Owner only (admin-user management). Admin → 403. */
export function requireOwnerUser(): Promise<PanelGate> {
  return gate("owner");
}

async function pageGate(required: PanelRole): Promise<{ user: User; role: PanelRole }> {
  const user = await getPanelUser();
  const decision = authorizePanelUser(user, required);
  if (!decision.ok) redirect(decision.status === 401 ? "/login" : "/login?error=forbidden");
  return { user: user as User, role: decision.role };
}

/** Panel pages: anonymous → /login; signed in without a role → /login?error=forbidden. */
export function requireAdminPage(): Promise<{ user: User; role: PanelRole }> {
  return pageGate("admin");
}

export function requireOwnerPage(): Promise<{ user: User; role: PanelRole }> {
  return pageGate("owner");
}

/** Session + role lookup for public panel pages (login, setup). Never throws. */
export async function getPanelAccess(): Promise<{ user: User | null; role: PanelRole | null }> {
  const user = await getPanelUser();
  const decision = authorizePanelUser(user, "admin");
  return { user, role: decision.ok ? decision.role : null };
}
