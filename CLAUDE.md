# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Operational rules — deployment workflow, post-Figma-export cleanup, and the **locked carousel-image CSS** — live in AGENTS.md. The owner's project instructions and the Drive master log override both files; read them before any deploy or visual change.

**Live domain:** as of **2026-06-20** the apex **`toptik.co.il` was returned to the Shopify store**; this Next/Vercel landing page now lives on the subdomain **`landing.toptik.co.il`** (Production builds from `master`; releases need the owner's explicit approval — see AGENTS.md). DNS is managed at internic → sitesdepot (zone 7144); Google Workspace email (MX/SPF) and Shopify email records are intentionally left untouched. The `landing` subdomain cutover (Vercel domain-add + `CNAME landing → Vercel`) is tracked step-by-step in **`docs/LANDING-SUBDOMAIN.md`** — read it before touching DNS or the domain. The original apex→Vercel migration record and rollback anchors remain in **`docs/DOMAIN-MIGRATION.md`**.

@AGENTS.md

## Commands

```bash
npm run dev      # Next.js dev server (HMR)
npm run build    # production build (next build --webpack)
npm run start    # serve the production build
npm run lint     # ESLint (flat config: eslint.config.mjs)
npm test         # all unit/regression tests: node --test tests/*.test.mjs
npm run verify   # lint + build; mirrors CI (.github/workflows/ci-quality.yml)
npm run backup:bundle  # full git bundle — Windows/PowerShell only
```

- **Tests** live in `tests/*.test.mjs` and use the built-in Node test runner (Node 22.13+ for `stripTypeScriptTypes`; no extra framework). Run one file with `node --test tests/<name>.test.mjs`. CI (push/PR to `dev`/`master`/`main`) runs lint + build only, so run `npm test` yourself before every change. Verification = `npm test` + `npm run lint` + `npm run build`, then the Preview/acceptance steps in AGENTS.md.
- Offline builds: `next/font/google` downloads fonts at build time. Where `fonts.googleapis.com` is blocked, `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` may be used to check the structure only; a real-font build must still pass on Vercel.
- **Do not run `npm run build` or delete `.next/` while `npm run dev` is running** — it wipes the dev server's manifests and breaks it. Stop the dev server first (see `.cursor/rules/dev_server_safety.md`).

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 (via `@tailwindcss/postcss`) · Supabase (`@supabase/supabase-js`) · GSAP + Swiper (animation/carousel) · Zod (validation). The site is Hebrew and RTL (`<html lang="he" dir="rtl">` in `src/app/layout.tsx`); Google fonts are loaded there as CSS variables.

## Two surfaces

1. **Landing page** — `src/app/page.tsx` (server component) plus `src/app/MobileLayer.tsx` (the `<768px` overlay). The hero is a full-viewport `next/image` with separate desktop and mobile sources. Almost all of this page's styling is an inline `<style>` block inside `page.tsx`, **not** in `globals.css`.
2. **Carousel / catalog** — the route is **`/carousel`** (`src/app/carousel/page.tsx` → `CarouselPageClient.tsx`), built on Swiper. Components live in `src/components/carousel/` (`CarouselGrid`, `CategoryNav`, `ProductModal`, `TechSpecsModal`, `ShatterTransition`, `HomeToCarouselCta`). Note the naming mismatch: CSS classes are `catalog-card-*` even though the route is `/carousel`. Carousel/catalog styling lives in `src/app/globals.css` (~2100 lines).
   - **Purchase buttons** (card and modal) link to `purchaseUrlFor()` (`src/lib/carousel/purchase-links.ts`, Shopify cart permalinks) in the **same tab** (GAL-027): no `target="_blank"`, no `window.open`, so one Back returns to the gallery URL with its `brand`/`category` params. Guarded by `tests/purchase-navigation.test.mjs`.
   - **Share/search metadata** (GAL-028) is set in `src/app/carousel/page.tsx`: owner-approved Hebrew title/description, canonical `https://landing.toptik.co.il/carousel`, Open Graph and Twitter card with `public/og/toptik-showroom-1200x630.jpg` (TopTik logo + real gallery products; provenance in `docs/OG-SHARE-IMAGE.md`). The `noindex, follow` hold stays. Guarded by `tests/share-metadata.test.mjs`.

## Feature flag

`NEXT_PUBLIC_ENABLE_CAROUSEL` (`src/lib/carousel/feature-flag.ts`) is the carousel kill-switch. Default = enabled; setting it to `"false"` hides the catalog CTA and redirects `/carousel` → `/`.

## Data layer (Supabase)

- The read and write boundaries are separate modules:
  - `src/lib/carousel/repository.ts` — `getCarouselPayload()` reads with the **public anon** client. Public routes use only this.
  - `src/lib/carousel/repository-admin.ts` — `saveCarouselPayload()` does a full diff-based upsert/delete with the **service-role** client and tolerates older DB schemas (retries the item upsert without `catalog_number`/`source_url` if those columns are missing). Admin routes only.
- Tables: `carousel_items`, `carousel_item_angles`, `carousel_settings` (singleton row `id=1`). Schema + storage policies are in `supabase/migrations/`. Per-product spec data is cached as JSON in `carousel_items.tech_specs`.
- **Unavailable, not fake:** when the public Supabase env vars are absent or the read fails, reads return `fallbackCarouselPayload` (`src/lib/carousel/fallback-data.ts`) — an explicit `unavailable` marker with no products. The app still builds and runs locally without a DB or secrets, and the gallery shows its "unavailable" message.

### Environment variables (all optional for a local build — missing ones trigger fallback)

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — public reads.
- `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PANEL_TOKEN` — required for admin writes and imports.
- `ADMIN_VAULT_KEY` — 32-byte base64 key for the password-vault AES-256-GCM encryption + step-up token HMAC. Without it the vault reports "not configured" and stays closed.
- `CRON_SECRET` — Vercel cron auth for the tech-specs warmer.

Public env lives in `src/lib/supabase/public-env.ts` (`hasSupabasePublicEnv()`); admin env in `src/lib/supabase/env.ts` (`hasSupabaseAdminEnv()`). The anon server client is in `src/lib/supabase/server.ts` and the service-role client in `src/lib/supabase/service-role.ts` — both `server-only`. Client components and public routes must never reach `service-role.ts` (enforced by `tests/public-read-isolation.test.mjs`).

## Admin panel (third surface — `admin.toptik.co.il`)

A session-gated control panel served on the **`admin.toptik.co.il`** subdomain. Read **`docs/ADMIN-SUBDOMAIN.md`** before touching auth, the proxy, or DNS/Vercel for it.

- **Auth:** Supabase Auth (email+password, hashed, built-in reset email) via `@supabase/ssr` cookie sessions. Up to **3 admins**. Helpers in `src/lib/admin/` (`supabase-server.ts`, `supabase-browser.ts`, `users.ts`, `origin.ts`, `config.ts`).
- **Routing:** `src/proxy.ts` (Next 16 renamed Middleware→Proxy) refreshes the session and rewrites the subdomain root → `/dashboard`. Panel routes live under `src/app/(panel)/`: `/login`, `/setup`, `/reset`, `/dashboard`, `/settings`; plus the `/auth/callback` route handler.
- **First admin:** one-time `/setup` guarded by `ADMIN_PANEL_TOKEN`; the rest are invited from `/settings`. Panel APIs under `/api/panel/{setup,users,users/reset}`.
- **`/dashboard`** is a hub of external/internal links: admin settings (`/settings`), the gallery editor (`landing.toptik.co.il/admin`), the live landing page, the Shopify store admin, and the WhatsApp AI agent (`agent.toptik.co.il`). All link targets are in `src/lib/admin/config.ts`.
- **`/settings`** holds admin-user management (invite/remove/reset, max 3), external-tool links (internic, Vercel, GitHub), and the **password vault**.
- **Password vault** ("סיסמאות" in `/settings`): an AES-256-GCM encrypted credentials store, gated by an **email-OTP step-up** (Supabase `signInWithOtp`/`verifyOtp`) before the modal opens. Crypto + step-up HMAC token live in `src/lib/admin/vault.ts` (key `ADMIN_VAULT_KEY`); rows are ciphertext-only in `admin_vault_entries` (migration `supabase/migrations/20260620_admin_vault.sql`, RLS deny-all → service-role). APIs: `/api/panel/vault/{challenge,unlock}` + `/api/panel/vault[/[id]]`; UI in `src/components/admin/VaultLauncher.tsx`.
- **Local demo:** `PANEL_DEMO=1 npm run dev` clicks through the whole panel (dashboard, settings, vault CRUD) with sample data + an in-memory vault — no Supabase needed. Dev-only: `isPanelDemo()` (`src/lib/admin/demo.ts`) is hard-gated to `NODE_ENV !== "production"` **and** the `PANEL_DEMO` flag, so it can never bypass auth in a build/deploy.
- The legacy **`/admin`** carousel editor is unchanged (client token-gated via `localStorage["toptik_admin_token"]` → `x-admin-token`); `/api/admin/*` stay token-only.

## Catalog import

- Import (`POST /api/admin/import/mandarina`): scrape Mandarina Duck by catalog number (`src/lib/catalog-source/`, `MandarinaDuckScraperProvider`) → download images → re-upload to the Supabase storage bucket **`carousel-media`** → keep the source description verbatim unless an exact-SKU reviewed copy exists (no machine translation, GAL-009) → prefetch & cache tech specs. It returns a **draft** item; the admin must "save all" (`saveCarouselPayload`) to persist it.

## Image pipeline

- `/api/img-trim?u=<supabase-public-url>` (`src/app/api/img-trim/route.ts`) trims the flat product background with `sharp` (threshold 25) and returns immutable-cached WebP. It is SSRF-guarded: only `*.supabase.co` public-storage URLs are allowed, and on any failure it passes the original image through. Wrap product URLs with `trimmedProductSrc()` (`src/lib/carousel/trim-src.ts`); local paths bypass the trimmer.
- `next/image` is configured for AVIF/WebP and the `*.supabase.co` remote pattern in `next.config.ts`.

## Tech-specs cache warmer

`/api/admin/warm-tech-specs` (add `?force=1` to refresh all) scrapes and caches product specs into `carousel_items.tech_specs`. A Vercel cron runs it daily at 03:00 UTC (`vercel.json`). Auth: `x-admin-token` / `?token=`, or `Authorization: Bearer $CRON_SECRET`. Scraping goes through `safeSourceFetch()` (`src/lib/catalog-source/safe-fetch.ts`): HTTPS only, approved manufacturer hosts only (`source-allowlist.ts`), no internal addresses, every redirect re-validated.

**No machine translation, ever** (GAL-009): no Google Translate or other MT service for any public text (descriptions, titles, specs, metadata), not even as a draft. The old Google Translate helpers in `product-details.ts` are disabled (kill switch `MACHINE_TRANSLATION_ENABLED = false`, no caller), `catalog-source/translate.ts` is a disabled no-op that nothing imports, and `/api/admin/translate` returns 410. `tests/no-machine-translation.test.mjs` scans `src`, `scripts` and `supabase` and fails if anything reconnects them.

The scraper's fixed glossary may only render **field names** from the explicit `KEY_TRANSLATIONS` allowlist (Weight → משקל, Material → חומר, …). Values, bullet lines, sentences, materials and colour names keep the manufacturer's wording (`VALUE_AND_FREE_TEXT_GLOSSARY_ENABLED = false`); `tests/glossary-scope.test.mjs` enforces it.

The public `/api/product-details?url=` is **read-only** (GAL-025): it returns only specs already stored with an existing active product whose source URL is approved. It never fetches the URL and never writes to the database.

`/api/debug-scrape` is closed (404, GAL-026). Scrape diagnostics live at `/api/admin/debug-scrape` (admin token + approved source + `safeSourceFetch`, read-only).
