// Admin-panel authorization rules (pure, no I/O) — owner decision 2026-09-29.
//
// A signed-in Supabase user is NOT an admin by default. Access is decided on the
// server only, from:
//   1. app_metadata.role ("owner" | "admin"). app_metadata can be written only
//      with the service role, never by the user or by public sign-up.
//   2. TEMPORARY: the remaining legacy admin account, matched by exact email
//      (LEGACY_ROLE_BY_EMAIL). See docs/ADMIN-AUTHZ.md — remove once that
//      account carries an app_metadata role. The former rordan owner fallback
//      was removed for the access handover on 2026-10-05.
// user_metadata is user-editable (sign-up `options.data`, `updateUser`) and is
// never a source of authority. A user with no role gets 403; nobody without a
// session gets past 401. tests/admin-authz.test.mjs enforces all of this.

export type PanelRole = "owner" | "admin";

export type AuthzDecision =
  | { ok: true; role: PanelRole; source: "app_metadata" | "legacy_email" }
  | { ok: false; status: 401 | 403; reason: string };

// Minimal shape of a Supabase auth user that authorization reads.
export interface AuthzUser {
  id?: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
  app_metadata?: Record<string, unknown> | null;
}

// TEMPORARY compatibility for the remaining admin from the owner decision
// 2026-09-29 16:17. The 2026-10-05 handover removes rordan's email-only access;
// service@toptik.com's compatibility stays until its separate migration.
// It is a closed list of exact addresses — no domains, no patterns, no other
// path — and applies only to confirmed email-password accounts that carry no
// app_metadata role of their own.
export const LEGACY_ROLE_BY_EMAIL: Readonly<Record<string, PanelRole>> = Object.freeze({
  "service@toptik.com": "admin",
});

function isPanelRole(value: unknown): value is PanelRole {
  return value === "owner" || value === "admin";
}

export function roleFromAppMetadata(user: AuthzUser | null | undefined): PanelRole | null {
  const role = user?.app_metadata?.role;
  return isPanelRole(role) ? role : null;
}

function legacyRole(user: AuthzUser): PanelRole | null {
  const appMetadata = user.app_metadata ?? {};
  // An explicit app_metadata role (even an unknown one) always wins.
  if (Object.prototype.hasOwnProperty.call(appMetadata, "role")) return null;
  if (appMetadata.provider !== "email") return null;
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  return email && Object.prototype.hasOwnProperty.call(LEGACY_ROLE_BY_EMAIL, email)
    ? LEGACY_ROLE_BY_EMAIL[email]
    : null;
}

export function authorizePanelUser(
  user: AuthzUser | null | undefined,
  required: PanelRole = "admin",
): AuthzDecision {
  if (!user) return { ok: false, status: 401, reason: "anonymous" };
  if (user.is_anonymous) return { ok: false, status: 403, reason: "anonymous-sign-in" };
  if (!user.email_confirmed_at) return { ok: false, status: 403, reason: "email-not-confirmed" };

  const fromApp = roleFromAppMetadata(user);
  const fromLegacy = fromApp ? null : legacyRole(user);
  const role = fromApp ?? fromLegacy;
  if (!role) return { ok: false, status: 403, reason: "no-panel-role" };
  if (required === "owner" && role !== "owner") return { ok: false, status: 403, reason: "owner-required" };
  return { ok: true, role, source: fromApp ? "app_metadata" : "legacy_email" };
}
