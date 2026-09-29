import "server-only";
import type { User } from "@supabase/supabase-js";

/**
 * DEV-ONLY demo mode for clicking through the whole panel locally without any
 * Supabase / DB — sample admins + an in-memory password vault (real add / edit
 * / delete that persist until the dev server restarts).
 *
 * HARD-GATED two ways, so it can never weaken a real deploy:
 *   1. `NODE_ENV !== "production"` — `next build` / `next start` and every Vercel
 *      build set NODE_ENV=production, where this is dead code.
 *   2. explicit `PANEL_DEMO=1` — so a normal `npm run dev` against real Supabase
 *      still exercises the real auth.
 *
 *   PANEL_DEMO=1 npm run dev   →   http://localhost:3000/dashboard
 */
export function isPanelDemo(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.PANEL_DEMO === "1";
}

export const DEMO_USER = {
  id: "demo-owner",
  email: "rordan@gmail.com",
  user_metadata: {},
  // Dev-only demo owner: the role lives in app_metadata, like real accounts.
  app_metadata: { provider: "email", role: "owner" },
  email_confirmed_at: "2026-06-01T10:00:00Z",
  aud: "authenticated",
  created_at: "2026-06-01T10:00:00Z",
} as unknown as User;

export const DEMO_USERS = [
  { id: "1", email: "rordan@gmail.com", role: "owner", createdAt: "2026-06-01T10:00:00Z", lastSignInAt: "2026-06-20T08:30:00Z", invitePending: false },
  { id: "2", email: "sarah@toptik.co.il", role: "admin", createdAt: "2026-06-10T10:00:00Z", lastSignInAt: "2026-06-19T14:05:00Z", invitePending: false },
];

export const DEMO_MASKED_EMAIL = "ro•••••@gmail.com";
