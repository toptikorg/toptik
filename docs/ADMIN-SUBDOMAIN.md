# Admin panel — `admin.toptik.co.il`

The admin panel is a session-gated control surface served on the **`admin.toptik.co.il`**
subdomain (same Vercel project / `master` deployment as the landing page). It is
**separate from** the legacy token-only `/admin` carousel editor, which stays exactly
as-is; the dashboard simply links to it (see the menu below).

## Status — verified 2026-06-21

- **Repo / code: READY and live on `master`.** Host routing is in `src/proxy.ts`
  (`/` is rewritten to `/dashboard` only on the admin host; the landing root is
  outside the matcher, so it stays a pure static hit). The panel renders today on
  the production Vercel URL — e.g. `https://toptik-iota.vercel.app/login` (shows
  the one-time "הקמת מנהל ראשי" `/setup` screen because no owner exists yet).
- **Vercel domains attached (checked via API):** `landing.toptik.co.il` +
  the `*.vercel.app` URLs. **`admin.toptik.co.il` is NOT attached to the project
  yet** — this is the one blocker. Adding it (step 1) + DNS (step 2) is what makes
  the subdomain serve from this repo; from then on every `master` deploy updates it.
- **Cannot be done by the cloud agent:** steps 1–7 below are external dashboard
  actions (Vercel domains/env, internic DNS, Supabase). The Claude-Code-on-the-web
  container has no internet egress and none of the keys, so a human (or desktop
  Claude with the dashboards open) must perform them. The repo side is complete.

- Login / password reset: **Supabase Auth** (email + password, hashed, built-in
  recovery email). Up to **3 admin accounts**.
- Routing: handled by `src/proxy.ts` (Next.js 16 renamed Middleware → Proxy).
- Settings storage: `supabase/migrations/20260620_admin_panel.sql`
  (`admin_settings` singleton, service-role only).

## Dashboard menu

| # | Item | Destination |
|---|------|-------------|
| 1 | הגדרות אדמין | `/settings` — manage admin users (invite / remove / reset, max 3) |
| 2 | עדכון גלריית דף הנחיתה | links to **`/admin`** — the existing carousel editor (token-gated) |
| 3 | דף הנחיתה | `https://landing.toptik.co.il` (new tab) |
| 4 | חנות שופיפיי | `https://toptik.co.il` (new tab) |
| 5 | סוכן וואטסאפ AI | "coming soon" tile — deferred, no page yet |

## Surface / route map

```
admin.toptik.co.il/            → rewritten to /dashboard (→ /login when signed out)
/login        public   email + password sign-in, "forgot password" link
/setup        public   one-time primary-admin creation (guarded by ADMIN_PANEL_TOKEN)
/reset        public   request a reset link, or set a new password (with a session)
/auth/callback route   exchanges the email link (code OR token_hash) → session
/dashboard    gated    the menu hub (links out to /settings, /admin, external sites)
/settings     gated    manage admin users (invite / remove / reset, max 3)
```

The gallery editor is the pre-existing **`/admin`** route (token-gated, not part of
the panel group); the dashboard simply links to it. WhatsApp is a deferred
"coming soon" tile with no page yet.

## One-time deploy / DNS / Supabase setup

> Production serves from `master`, so the panel only goes live after the feature
> branch is fast-forward-merged to `master` (see `AGENTS.md`).

### 1. Vercel — add the domain
In the Vercel project (`rordan-ais-projects/toptik`) → **Settings → Domains**,
add `admin.toptik.co.il`. Vercel will show the DNS record to create.

### 2. DNS — point the subdomain at Vercel
At the DNS host (internic → sitesdepot, zone 7144 — same place as the `landing`
cutover, see `docs/LANDING-SUBDOMAIN.md`), add:

```
CNAME   admin   →   cname.vercel-dns.com.
```

(Use whatever target Vercel shows in step 1. Leave Google Workspace MX/SPF and
Shopify records untouched.) Verify the domain in Vercel once DNS propagates.

### 3. Supabase Auth — redirect URLs
**Authentication → URL Configuration**:

- **Site URL**: `https://admin.toptik.co.il`
- **Redirect URLs** — add: `https://admin.toptik.co.il/auth/callback`

### 4. Supabase Auth — email templates (recommended, robust resets/invites)
By default Supabase recovery/invite links use the PKCE *code* flow, which only
works in the same browser that requested it. For **cross-device and
admin-initiated** resets/invites, switch the two templates to the one-time
**token_hash** flow (the `/auth/callback` handler already supports both).

**Authentication → Email Templates → Reset Password** — set the link to:
```
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=/reset
```
**Authentication → Email Templates → Invite user** — set the link to:
```
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite&next=/reset
```

(Optional) Configure **SMTP** under Auth → SMTP for branded sender / higher
send limits. The built-in Supabase mailer works for low volume.

### 5. Database + vault key
Admin accounts live in Supabase Auth (`auth.users`). The one panel table is the
password vault — apply `supabase/migrations/20260620_admin_vault.sql`
(`admin_vault_entries`; RLS deny-all → service-role only; rows hold ciphertext
only). Set **`ADMIN_VAULT_KEY`** (32-byte base64) for the AES-256-GCM encryption
+ step-up HMAC; without it the "סיסמאות" vault stays closed ("not configured").
Opening the vault requires an email-OTP step-up, so Supabase email OTP must be
enabled (default).

### 6. Environment variables (Vercel → Settings → Environment Variables)
Required (most already set for the carousel):

| Var | Purpose |
|-----|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key (session auth) |
| `SUPABASE_SERVICE_ROLE_KEY` | Create/invite/delete users, settings writes |
| `ADMIN_PANEL_TOKEN` | One-time `/setup` guard + legacy API fallback |

Optional overrides: `NEXT_PUBLIC_ADMIN_HOST` (default `admin.toptik.co.il`),
`NEXT_PUBLIC_LANDING_URL`, `NEXT_PUBLIC_SHOPIFY_URL`.

### 7. First-run — create the primary admin
1. Visit `https://admin.toptik.co.il` → you are redirected to **`/setup`**.
2. Enter the primary admin email, a password (≥ 10 chars), and the
   `ADMIN_PANEL_TOKEN` value. Submit → the owner account is created and you are
   signed in.
3. From **הגדרות אדמין** (`/settings`) invite up to **2 more** admins by email.
   Each invitee receives a link to set their password.

After an owner exists, `POST /api/panel/setup` refuses (409). The `/setup` page no
longer reads the account count with the service role.

## Security notes
- Passwords are hashed and managed by Supabase Auth; the app never stores them.
- A Supabase session is NOT panel access. Panel pages and `/api/panel/*` are
  gated by role (`requireAdminUser` / `requireOwnerUser` / `requireAdminPage`,
  roles from `app_metadata` only; user management is owner-only; the vault needs
  an admin AND an OTP). See `docs/ADMIN-AUTHZ.md` (2026-09-29).
- `ADMIN_PANEL_TOKEN` stays server-side and now guards only one-time `/setup`.
  The legacy `/admin` carousel editor + `/api/admin/*` keep token auth, now
  through the central constant-time `requireAdminToken`.
