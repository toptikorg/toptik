import { hasSupabasePublicEnv, supabasePublicEnv } from "@/lib/supabase/public-env";

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminToken = process.env.ADMIN_PANEL_TOKEN?.trim();

export { hasSupabasePublicEnv };

export const supabaseEnv = {
  ...supabasePublicEnv,
  serviceRoleKey,
  adminToken,
};

export function hasSupabaseAdminEnv() {
  return Boolean(
    supabaseEnv.publicUrl &&
      supabaseEnv.publicAnonKey &&
      supabaseEnv.serviceRoleKey &&
      supabaseEnv.adminToken,
  );
}
