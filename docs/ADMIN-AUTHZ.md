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
| `authorizeGalleryAdmin(req)` / `requireGalleryAdmin(req)` | interactive gallery routes (editor, upload, import, translation, commerce and specs) | valid admin token or an authorized panel session; session mutations require the allowed origin policy |
| `requireAdminToken(req)` | worker/bootstrap routes, warm-colors, colors-probe, debug-scrape and other token-only automation | 401 JSON; constant-time token; cron secret only where allowed |
| `isValidSetupToken()` | `POST /api/panel/setup` (refuses once any account exists) | 401 |

The interactive gallery routes already accept either `ADMIN_PANEL_TOKEN` or a
panel session authorized by `requireAdminUser`; their session requests also
pass the gallery origin/mutation policy. Removing the email fallback therefore
closes this session path for the former legacy owner. The token path remains
independent of the user's identity.

Worker and other automation routes retain their token-only gates and do not
read a Supabase session. A signed-in panel user cannot reach those routes
without `ADMIN_PANEL_TOKEN` (or `CRON_SECRET` on routes that explicitly allow it).

`/login` and `/setup` no longer read anything with the service role: the old
"no accounts yet" check and the public `GET /api/panel/setup` were removed.

## Access handover — pending release, 2026-10-05

The owner requested the work needed to remove Ramy's access safely. This branch
removes the email-only owner fallback for `rordan@gmail.com`. It is **pending
release**: local code and tests are not proof that Production has changed.
The repository workflow still requires a verified Preview and the owner's
approval of this specific release before merging to `master`.

A confirmed `rordan@gmail.com` session without `app_metadata.role` now receives
**403** from the protected APIs, including case and whitespace variants and a
forged role in `user_metadata`. Panel pages redirect it to
`/login?error=forbidden`; user management and the vault are refused, even with a
valid vault step-up cookie. Confirmed owners authorized via `app_metadata.role`,
including `info@toptik.co.il`, retain access.

Removing this fallback does not remove organization memberships, Supabase Auth
users, an explicit `app_metadata.role`, or access through `ADMIN_PANEL_TOKEN`.
Those must be checked separately during the handover. Preserve shared Supabase
content before removing the organization member.

## Temporary compatibility (remaining legacy admin)

The two historical accounts created on 2026-06-21 originally used a fallback
because their roles were in `user_metadata` only. The 2026-09-29 decision kept
them unchanged. For the 2026-10-05 handover, this branch removes the former
`rordan@gmail.com` owner entry; `LEGACY_ROLE_BY_EMAIL` now maps only the remaining
legacy admin, whose migration is a separate decision:

| Email | Role |
|---|---|
| service@toptik.com | admin |

It applies only to a confirmed email-password account (`app_metadata.provider =
"email"`) that has **no** `app_metadata.role`. There is no domain or pattern
match and no other path. Supabase keeps emails unique, so another account
cannot claim this address. Remove the list once the remaining account's
migration is verified (see the plan below).

Known risk kept by decision: `service@toptik.com` is on the `toptik.com`
domain, not `toptik.co.il`. Whoever receives mail for that address can use
"forgot password" to sign in as this admin.

## Remaining migration plan — separate owner approval required

1. Verify `info@toptik.co.il` can sign in as an `app_metadata` owner in the panel
   and complete vault OTP before releasing this access change.
2. Owner verifies control of the intended `service@toptik.co.il` mailbox and
   creates or verifies its admin account through the panel. The role must be in
   `app_metadata`, set server-side.
3. Verify the new admin can sign in and complete vault OTP.
4. Owner decides whether to migrate or retire `service@toptik.com`.
5. Remove its remaining `LEGACY_ROLE_BY_EMAIL` entry in a separate reviewed
   commit, with the test updated.
6. Review whether the editor should retain its independent admin-token path;
   any token retirement or rotation is a separate change coordinated with the
   workers and other automation that use it.
