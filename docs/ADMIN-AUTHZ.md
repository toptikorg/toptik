# Admin panel authorization

**Decision:** owner, 2026-09-29. A signed-in Supabase user is **not** an admin.
Code: `src/lib/admin/authz-core.ts` (rules), `src/lib/admin/authz.ts` (gates),
`src/lib/admin/admin-token.ts` (legacy token routes). Guard:
`tests/admin-authz.test.mjs`.

## Rules

- Authorization is decided on the server only.
- Role source: `app_metadata.role` = `"owner"` or `"admin"`. `app_metadata` can be
  written only with the service role (never by the user or by sign-up).
- `user_metadata` is user-editable and is **never** a source of authority.
- No default role: a user without a role gets **403**; no session gets **401**.
- The email must be confirmed; anonymous sign-ins are refused.
- Owner only: list, create and delete admins, set an admin's password.
- Vault: an authorized admin **and** a valid email OTP (step-up cookie bound to
  the user). An OTP alone never opens the vault; a non-admin gets 403 before any
  code is sent.
- Public sign-up, if it is ever enabled by mistake, cannot create an admin and
  cannot open the panel.

## Gates

| Gate | Used by | Result |
|---|---|---|
| `requireAdminUser()` | vault challenge / unlock, `authStepUp` (vault CRUD) | 401 / 403 JSON |
| `requireOwnerUser()` | `/api/panel/users` (GET, POST, DELETE), `/api/panel/users/reset` | 401 / 403 JSON |
| `requireAdminPage()` | `/dashboard`, `/settings` (user management shown to owners only) | redirect `/login` or `/login?error=forbidden` |
| `requireAdminToken(req)` | legacy `/api/admin/*` (gallery editor, imports, warm-ups, probes) | 401 JSON; constant-time token; cron secret only where allowed |
| `isValidSetupToken()` | `POST /api/panel/setup` (refuses once any account exists) | 401 |

The legacy `/api/admin/*` routes never read a Supabase session, so a signed-in
user cannot reach them without `ADMIN_PANEL_TOKEN`. Moving the gallery editor
behind `requireAdminUser` is a separate, later change (the editor runs on
`landing.toptik.co.il/admin` with a browser-stored token today).

`/login` and `/setup` no longer read anything with the service role: the old
"no accounts yet" check and the public `GET /api/panel/setup` were removed.

## Temporary compatibility (existing accounts)

The two accounts created on 2026-06-21 carry their role in `user_metadata`
only. By the owner's decision (2026-09-29 16:17) nothing in those accounts is
changed, so `LEGACY_ROLE_BY_EMAIL` maps exactly these two addresses:

| Email | Role |
|---|---|
| rordan@gmail.com | owner |
| service@toptik.com | admin |

It applies only to a confirmed email-password account (`app_metadata.provider =
"email"`) that has **no** `app_metadata.role`. There is no domain or pattern
match and no other path. Supabase keeps emails unique, so another account
cannot claim these addresses. Remove the list once the accounts carry
`app_metadata` roles (see the plan below).

Known risk kept by decision: `service@toptik.com` is on the `toptik.com`
domain, not `toptik.co.il`. Whoever receives mail for that address can use
"forgot password" to sign in as this admin.

## Future migration plan — NOT to be executed without the owner's approval

1. Owner creates the mailboxes `info@toptik.co.il` and `service@toptik.co.il`.
2. Owner (in the panel) creates the new accounts; they get `app_metadata.role`
   (owner / admin) from `createAdminWithPassword` / a one-off service-role step.
3. The new accounts sign in and are verified (panel, vault OTP).
4. Owner decides about the old accounts (`rordan@gmail.com`,
   `service@toptik.com`): keep, set `app_metadata.role`, or remove.
5. Remove `LEGACY_ROLE_BY_EMAIL` in a separate commit, with the test updated.
6. Only then turn the legacy editor to `requireAdminUser` if wanted.
