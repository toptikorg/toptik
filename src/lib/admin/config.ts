// Central configuration for the TOPTIK admin panel (the `admin.toptik.co.il`
// subdomain surface). Values are overridable via env so previews / staging can
// point elsewhere, but production defaults are baked in.

/** Host that serves the admin panel. The landing page lives on `landing.toptik.co.il`. */
export const ADMIN_HOST = (process.env.NEXT_PUBLIC_ADMIN_HOST ?? "admin.toptik.co.il").toLowerCase();

/** Hard cap on the number of admin accounts (product requirement: up to 3). */
export const MAX_ADMIN_USERS = 3;

/** Public landing page — "צפייה בדף הנחיתה". */
export const LANDING_URL = process.env.NEXT_PUBLIC_LANDING_URL ?? "https://landing.toptik.co.il";

/** Same-host editor keeps the existing authenticated panel session. */
export const GALLERY_EDITOR_URL =
  process.env.NEXT_PUBLIC_GALLERY_EDITOR_URL ?? "/admin";

/** Shopify store admin console. */
export const SHOPIFY_ADMIN_URL =
  process.env.NEXT_PUBLIC_SHOPIFY_ADMIN_URL ??
  "https://admin.shopify.com/store/toptikcoil?ui_locales=en-IL";

/** WhatsApp AI agent console (already built — separate service). */
export const WHATSAPP_AGENT_URL =
  process.env.NEXT_PUBLIC_WHATSAPP_AGENT_URL ?? "https://agent.toptik.co.il/";

/** internic — hosting/storage + DNS/domain management portal. */
export const INTERNIC_URL =
  process.env.NEXT_PUBLIC_INTERNIC_URL ?? "https://portal.internic.co.il/dashboard/main";

/** Vercel — hosting / deployments dashboard. */
export const VERCEL_URL =
  process.env.NEXT_PUBLIC_VERCEL_URL ?? "https://vercel.com/rordan-ais-projects";

/** GitHub — source code in the cloud. */
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/toptikorg/toptik";

/**
 * URL path prefixes that belong to the admin panel surface. `proxy.ts` uses
 * these to (a) refresh the Supabase session and (b) keep the panel on its
 * subdomain. Keep in sync with the routes under `src/app/(panel)` + the auth
 * callback route handler.
 */
export const PANEL_PREFIXES = [
  "/login",
  "/setup",
  "/reset",
  "/dashboard",
  "/settings",
  "/auth",
] as const;

/** Panel paths that are reachable without an authenticated session. */
export const PUBLIC_PANEL_PREFIXES = ["/login", "/setup", "/reset", "/auth"] as const;
