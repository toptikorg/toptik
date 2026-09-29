import "server-only";
import { createClient } from "@supabase/supabase-js";
import { hasSupabaseAdminEnv, supabaseEnv } from "@/lib/supabase/env";

// Bypasses RLS. Import only from authenticated admin, panel or cron code.
// Public routes and client components must never reach this module
// (enforced by tests/public-read-isolation.test.mjs).
export function createSupabaseServiceRoleClient() {
  if (!hasSupabaseAdminEnv()) {
    throw new Error(
      "Missing Supabase admin env vars. Required: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PANEL_TOKEN",
    );
  }
  return createClient(supabaseEnv.publicUrl!, supabaseEnv.serviceRoleKey!, {
    auth: { persistSession: false },
  });
}
