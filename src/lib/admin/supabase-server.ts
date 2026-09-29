import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { hasSupabasePublicEnv, supabaseEnv } from "@/lib/supabase/env";
import { isPanelDemo, DEMO_USER } from "@/lib/admin/demo";

/**
 * Cookie-bound Supabase client for Server Components, Server Actions and Route
 * Handlers. Reads/writes the session cookies that `proxy.ts` keeps fresh.
 *
 * `cookies()` is async in Next.js 16, so this helper is async too.
 */
export async function createPanelServerClient() {
  if (!hasSupabasePublicEnv()) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const cookieStore = await cookies();

  return createServerClient(supabaseEnv.publicUrl!, supabaseEnv.publicAnonKey!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` was called from a Server Component, where cookies are
          // read-only. The session refresh in `proxy.ts` keeps cookies current,
          // so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * Returns the signed-in Supabase user, or `null`. Uses `getUser()` which
 * validates the JWT against Supabase Auth (never trust the unverified cookie).
 * A session is NOT panel access: authorization is decided only by the gates in
 * `@/lib/admin/authz` (requireAdminUser / requireOwnerUser / requireAdminPage).
 */
export async function getPanelUser(): Promise<User | null> {
  if (isPanelDemo()) return DEMO_USER;
  if (!hasSupabasePublicEnv()) return null;
  try {
    const supabase = await createPanelServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ?? null;
  } catch {
    return null;
  }
}
