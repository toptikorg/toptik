import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { ADMIN_HOST, PANEL_PREFIXES } from "@/lib/admin/config";
import { hasSupabasePublicEnv, supabaseEnv } from "@/lib/supabase/env";

// Next.js 16 renamed Middleware → Proxy (same functionality). This runs before
// matched requests to (1) keep the Supabase session cookie fresh for SSR and
// (2) serve the admin panel from the `admin.toptik.co.il` subdomain.

function isPanelPath(pathname: string): boolean {
  return PANEL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
  const { pathname } = request.nextUrl;

  const isAdminHost = host === ADMIN_HOST;
  const isLocal = host === "localhost" || host.startsWith("127.") || host.endsWith(".local");
  const isPreview = host.endsWith(".vercel.app");
  const panelHost = isAdminHost || isLocal || isPreview;
  const panelPath = isPanelPath(pathname);

  // A panel path requested on the public landing/apex host → push it to the
  // admin subdomain (the panel is not meant to live on the marketing host).
  if (panelPath && !panelHost) {
    const url = request.nextUrl.clone();
    url.host = ADMIN_HOST;
    url.protocol = "https";
    url.port = "";
    return NextResponse.redirect(url);
  }

  // The admin subdomain root shows the dashboard (which itself redirects to
  // /login when signed out).
  const rewriteRoot = pathname === "/" && isAdminHost;
  const needsSession = panelPath || rewriteRoot || (pathname === "/admin" && panelHost);

  const buildResponse = (): NextResponse => {
    if (rewriteRoot) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.rewrite(url, { request });
    }
    return NextResponse.next({ request });
  };

  if (!needsSession || !hasSupabasePublicEnv()) {
    return needsSession ? buildResponse() : NextResponse.next();
  }

  // Refresh the Supabase session and propagate any rotated cookies onto the
  // outgoing response (the canonical @supabase/ssr proxy pattern).
  let response = buildResponse();
  const supabase = createServerClient(supabaseEnv.publicUrl!, supabaseEnv.publicAnonKey!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = buildResponse();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}

// Matcher. The bare root `/` is intercepted ONLY on the admin subdomain (where it
// rewrites to /dashboard) — host-scoping it keeps the PUBLIC landing root out of
// the proxy entirely, so `landing.toptik.co.il/` stays a pure static/CDN hit with
// no edge-function hop. Panel paths match on every host: on the landing/apex host
// they redirect to the admin subdomain; on the admin host they get a fresh
// session. (The host literal must match ADMIN_HOST in src/lib/admin/config.ts.)
export const config = {
  matcher: [
    { source: "/", has: [{ type: "host", value: "admin.toptik.co.il" }] },
    "/admin",
    "/login/:path*",
    "/setup/:path*",
    "/reset/:path*",
    "/dashboard/:path*",
    "/settings/:path*",
    "/auth/:path*",
  ],
};
