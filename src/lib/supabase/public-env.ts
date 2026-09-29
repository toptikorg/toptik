// Public Supabase settings only. These two values are designed to be public:
// they are inlined into browser bundles and every read is limited by RLS.
// Never add the service-role key or the admin token here — public and client
// code import this module (see tests/public-read-isolation.test.mjs).
const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publicAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabasePublicEnv = {
  publicUrl,
  publicAnonKey,
};

export function hasSupabasePublicEnv() {
  return Boolean(supabasePublicEnv.publicUrl && supabasePublicEnv.publicAnonKey);
}
