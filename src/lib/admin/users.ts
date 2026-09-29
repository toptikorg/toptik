import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { MAX_ADMIN_USERS } from "@/lib/admin/config";
import { authorizePanelUser, type PanelRole } from "@/lib/admin/authz-core";

// Server-only admin-user operations (service role). Callers: owner-gated panel
// routes (requireOwnerUser) and the token-gated one-time setup. Roles are read
// with authorizePanelUser (app_metadata, or the temporary legacy email list) —
// never from user_metadata — and new accounts get their role in app_metadata.

export type AdminUserSummary = {
  id: string;
  email: string | null;
  role: PanelRole;
  createdAt: string | null;
  lastSignInAt: string | null;
  invitePending: boolean;
};

/** Panel role of an auth user, or null when the account has no panel access. */
function panelRoleOf(user: User): PanelRole | null {
  const decision = authorizePanelUser(user, "admin");
  return decision.ok ? decision.role : null;
}

function toSummary(user: User, role: PanelRole): AdminUserSummary {
  return {
    id: user.id,
    email: user.email ?? null,
    role,
    createdAt: user.created_at ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    // An invited user has confirmed nothing and never signed in yet.
    invitePending: !user.last_sign_in_at && !user.email_confirmed_at,
  };
}

/** Lists the accounts that HAVE panel access (owner/admin), oldest first.
 *  Signed-up users without a role are not admins and are not listed. */
export async function listAdminUsers(): Promise<AdminUserSummary[]> {
  const admin = createSupabaseServiceRoleClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 100 });
  if (error) throw error;
  return data.users
    .flatMap((user) => {
      const role = panelRoleOf(user);
      return role ? [toSummary(user, role)] : [];
    })
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export async function countAdminUsers(client?: SupabaseClient): Promise<number> {
  const admin = client ?? createSupabaseServiceRoleClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 100 });
  if (error) throw error;
  return data.users.length;
}

/**
 * Creates the very first ("primary") admin. Caller MUST have already verified
 * the one-time setup token. Refuses to run once any account exists.
 */
export async function createPrimaryAdmin(email: string, password: string): Promise<void> {
  const admin = createSupabaseServiceRoleClient();
  if ((await countAdminUsers(admin)) > 0) {
    throw new Error("הקמה כבר בוצעה — קיים מנהל ראשון.");
  }
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // Server-controlled role (the user cannot edit app_metadata).
    app_metadata: { role: "owner" },
  });
  if (error) throw error;
}

/**
 * Creates an additional admin with a password set DIRECTLY — no email is ever
 * sent (admin.createUser + email_confirm). The owner shares the credentials with
 * the new admin out-of-band. Enforces the 3-account ceiling. This deliberately
 * avoids inviteUserByEmail, which requires working SMTP and fails (500
 * unexpected_failure) when email delivery is unavailable.
 */
export async function createAdminWithPassword(email: string, password: string): Promise<AdminUserSummary> {
  const admin = createSupabaseServiceRoleClient();
  const existing = await listAdminUsers();
  if (existing.some((u) => u.email?.toLowerCase() === email.toLowerCase())) {
    throw new Error("כתובת המייל כבר רשומה כמנהל.");
  }
  if (existing.length >= MAX_ADMIN_USERS) {
    throw new Error(`ניתן להגדיר עד ${MAX_ADMIN_USERS} מנהלים בלבד.`);
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // Server-controlled role (the user cannot edit app_metadata).
    app_metadata: { role: "admin" },
  });
  if (error) throw error;
  if (!data.user) throw new Error("יצירת המנהל נכשלה.");
  const role = panelRoleOf(data.user);
  if (!role) throw new Error("יצירת המנהל נכשלה.");
  return toSummary(data.user, role);
}

/** Removes an admin. Only panel accounts can be targeted; the last remaining
 *  account and the last owner can never be deleted. */
export async function deleteAdmin(id: string): Promise<void> {
  const admin = createSupabaseServiceRoleClient();
  const users = await listAdminUsers();
  if (users.length <= 1) {
    throw new Error("לא ניתן למחוק את המנהל האחרון שנותר.");
  }
  const target = users.find((u) => u.id === id);
  if (!target) {
    throw new Error("המנהל לא נמצא.");
  }
  if (target.role === "owner" && users.filter((u) => u.role === "owner").length <= 1) {
    throw new Error("לא ניתן למחוק את הבעלים האחרון.");
  }
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) throw error;
}

/**
 * Owner-initiated password reset: sets a NEW password directly on the account —
 * no email. The owner shares the new password with the admin out-of-band.
 */
export async function setAdminPassword(id: string, password: string): Promise<void> {
  const admin = createSupabaseServiceRoleClient();
  // Only an existing panel account can be targeted — never an arbitrary user.
  const users = await listAdminUsers();
  if (!users.some((u) => u.id === id)) {
    throw new Error("המנהל לא נמצא.");
  }
  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) throw error;
}
