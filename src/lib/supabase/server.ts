import "server-only";
import { createClient } from "@supabase/supabase-js";
import { hasSupabasePublicEnv, supabasePublicEnv } from "@/lib/supabase/public-env";

// Public, RLS-limited server client. The service-role client lives in
// ./service-role.ts so public routes cannot reach it, even indirectly.
export function createSupabaseServerClient() {
  if (!hasSupabasePublicEnv()) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createClient(supabasePublicEnv.publicUrl!, supabasePublicEnv.publicAnonKey!);
}
