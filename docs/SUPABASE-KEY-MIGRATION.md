# Supabase API key migration for access offboarding

**Status: PENDING RELEASE AND KEY MIGRATION (2026-10-05).** This branch only
prepares Storage request compatibility; it does not create, rotate, disclose or
revoke a credential. Source base: `7ec6b3cd30f7ffe737467dad367d470911d7ca47`,
which includes the removal of Rordan's email-only owner fallback (PR #68).
Preview, release approval, a fresh Production deployment and live acceptance
remain required under `AGENTS.md`. A successful build is not migration proof.

## Compatibility and consumer inventory

Locked dependencies are `@supabase/supabase-js` **2.108.2**, `@supabase/ssr`
**0.12.0** and Next.js **16.2.3**. This change does not upgrade dependencies.
All SDK consumers already pass the configured key to the supported client
constructors; they do not decode the API key or require it to be a JWT.

The sole raw authenticated Supabase request found in tracked runtime code is
`src/lib/shopify/media-storage-transport.ts`. Its immutable upload now sends:

| Configured backend key | Request headers |
|---|---|
| Legacy `service_role` | `apikey` and matching `Authorization: Bearer` |
| Opaque `sb_secret_...` | `apikey` only |

The prefix selects the wire format; Supabase still validates the credential.
The project origin, source hash/dimensions/MIME checks, safe DNS checks,
Production/feature gates, deadlines, redirect refusal and `x-upsert: false`
remain unchanged. Uploads remain one attempt; uncertain results recover through
independent public readback. Public readback sends no credential headers for
either key type. Keys stay inside server-only code, never in a response or log.

The installed SDK can copy an API key into its own Authorization header and
Supabase gateways provide compatibility handling. This PR follows the explicit
`apikey` protocol for the custom transport; it does **not** claim that a live
failure of the previous request has been observed.

Keep existing environment **names**; replace their values only:

| Environment name | Replacement | Consumers |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Named, owner-controlled secret key | Shared service-role SDK client: user/vault management, gallery writes/imports/uploads, Shopify inbox/queues/workers; raw media Storage transport |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key | Browser/public readers, SSR panel clients and proxy/session refresh |
| `NEXT_PUBLIC_SUPABASE_URL` | Same project URL | All clients; raw media transport remains pinned to the existing project |
| `ADMIN_PANEL_TOKEN` | Keep a valid owner-controlled token | Required by `hasSupabaseAdminEnv`; token APIs and internal worker dispatch |

No Supabase PAT/Management API, API-key JWT decoding, second raw authenticated
Supabase request or Edge Function invocation was found in tracked `src`,
`scripts` or `.github`. That is a code inventory, not an audit of external
clients, database cron/webhooks, `pg_net`, integrations or other projects.

## Preconditions

1. Verify owner access to Supabase API-key administration and the live project's
   current key types using metadata, without recording key values.
2. Confirm the Production source contains the Rordan fallback removal, and
   `info@toptik.co.il` can sign in with its server-controlled owner role.
3. Inventory every deployment environment and external key consumer. In
   particular, check database cron/webhooks/`pg_net`, scripts outside this repo,
   integrations and older browser builds before deactivating legacy keys.
4. Prepare a permitted, isolated media canary with an exact approved identity,
   immutable source and durable one-shot upload permission. Do not substitute a
   customer product, overwrite an existing object or activate an identity just
   to make this test pass. If no suitable canary exists, live upload remains
   **NOT TESTED** and legacy deactivation must wait.

## Controlled rollout

1. Release the compatibility change through the required Preview and specific
   owner approval. Preview is not evidence of Production media uploads: they
   require `VERCEL_ENV=production` and `SHOPIFY_MEDIA_SYNC=enabled_v1`.
2. Create owner-controlled publishable/secret keys in the **same** Supabase
   project alongside the existing legacy keys. Store secrets only in the
   authorized deployment secret store; never source, reports or screenshots.
3. Update both key environment values for every intended consumer and scope.
   Use a fresh build/deployment: `NEXT_PUBLIC_` values are inlined into browser
   bundles, and existing Vercel deployments retain their old environment.
4. Verify the new Production deployment is Ready and the public domains serve
   that deployment. Check public gallery reads, `info@toptik.co.il` login/owner
   pages, owner-only user listing and vault OTP without changing vault content.
5. Complete the isolated media canary through the permitted application path:
   one non-overwrite upload, exact independent GET/hash/dimension readback,
   durable acceptance, and no repeated upload. Record identity, source/deployed
   commit, object path/hash, result and any uncertain operation to be recovered.
   Any Shopify change must stay within the explicitly approved canary scope.
6. Check the next scheduled invocation and dependent queues using bounded
   status/log metadata. Do not trigger catalog reconciliation as a smoke test.
7. Only after all consumers and the canary pass, deactivate legacy API keys at
   Supabase. Updating a Vercel variable does not revoke a copied provider key.
   Legacy `anon` and `service_role` share the legacy mechanism, so migrate both
   before deactivation. Verify old API-key rejection through a permitted
   read-only request; never expose its Authorization header or body.
8. Restrict historical deployment URLs and any protection bypasses. New env
   values do not replace credentials in a historical deployment. Keep a safe
   source reference for rollback instead of reusing an old deployed bundle.

If a former administrator may also have copied the legacy **JWT signing
secret** or database password, API-key deactivation alone does not complete
offboarding. Inventory those separately by metadata and use their own reviewed
rotation plans. This PR does not change JWT signing keys, sessions, passwords,
RLS, organization memberships or encryption keys.

## Non-writing authentication smoke checks

These checks confirm the guards, not that an actual upload or worker completes.
Use process-scoped credentials and requests without browser cookies when
checking a token's rejection. Report status/error code only.

| Production request | Header | Expected result before work |
|---|---|---|
| `POST /api/admin/shopify/media/worker?hop=invalid` | `x-admin-token` | New token: `400 MEDIA_CONTINUATION_INVALID`; old token: `401`. No scheduling/DB call. |
| `POST /api/admin/shopify/specs/worker?hop=invalid` | `x-admin-token` | New token: `400 SPEC_CONTINUATION_INVALID`; old token: `401`. No scheduling/DB call. |
| `GET /api/admin/shopify/sync?run=1&productId=invalid` | `Authorization: Bearer` cron secret | Valid cron auth: `400 SYNC_PRODUCT_GID_INVALID` before client/drain; `503` if Supabase env is missing; invalid secret: `401`. |
| `GET /api/admin/shopify/sync` without `run` | `x-admin-token` | Read-only DB status/counts; no worker dispatch. |
| `GET /api/admin/carousel` | Admin token or authorized owner session | Read-only gallery observation. |

Do not use a valid worker `hop` or omit the invalid product from the `run=1`
probe: that can dispatch real synchronization. `GET specs/fields` does not
mutate Shopify but acquires/releases a DB lease; it is not a pure read-only
guard probe. Read-only success cannot replace the live Storage canary.

## Rollback without restoring former access

- Before revocation, stop the rollout on a failed check, repair the new-key
  consumer and keep the migration marked incomplete. Legacy credentials still
  working means copied credentials have not yet been neutralized.
- After revocation, do **not** reactivate legacy keys, restore an old secret,
  revert PR #68, or promote a historical deployment holding old credentials.
- Deploy a fresh known-good source containing both the offboarding and key
  compatibility changes with the owner-controlled new credentials. If needed,
  create a further owner-controlled replacement key and update its consumers.
- Preserve durable pending operation/queue state. Recover an uncertain upload
  read-only; never retry an accepted-but-unconfirmed write or set upsert true.
- If safe recovery is unavailable, hold the affected worker and document the
  limitation until the owner approves a tested recovery. Do not claim the
  copied credentials have been revoked while a legacy fallback remains active.

## Verification evidence

Unit regressions cover legacy headers, secret-key headers, credential-free
readback under both types, sanitized provider rejection, no retry/overwrite,
origin/DNS/source/MIME gates and deadlines. These use deliberately invalid test
keys and mocked transport, never a real credential.

Required repository checks: `npm test`, `npm run lint`, `npm run build`.
Local verification on 2026-10-05: **1124/1124** tests passed, lint passed with
the two existing unused-variable warnings in `verify-existing-media-25mp-sql.mjs`,
and the Production build passed compilation, TypeScript and all 74 static pages.
The opaque-key header regression first failed against the previous transport;
the final transport suite has 14 passing cases. Independent cold review found
no blockers in the code, tests or migration plan. Live key acceptance and the
isolated Storage canary remain **NOT TESTED**.

Offline SQL fixtures include `verify-shopify-sync-sql.mjs`,
`verify-existing-media-25mp-sql.mjs` and `verify-gallery-editor-cas-sql.mjs`;
they do not prove live key acceptance. No provider key rotation or live upload
has been performed by this code change.

Sources: [Supabase API-key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys),
[API keys](https://supabase.com/docs/guides/getting-started/api-keys),
[JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys),
[Vercel environment variables](https://vercel.com/docs/environment-variables).
