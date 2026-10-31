import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function readPublicOrderHealth() {
  const { data, error } = await createSupabaseServerClient().from("toptik_order_automation_health")
    .select("last_audit_completed_at,audit_status,issue_codes").eq("id", true).single();
  if (error || !data) return { status: "unhealthy" as const, checkedAt: null, issueCodes: ["HEALTH_STATE_UNAVAILABLE"] };
  const stale = !data.last_audit_completed_at || Date.now() - Date.parse(data.last_audit_completed_at) > 12 * 60_000;
  return {
    status: !stale && data.audit_status === "healthy" ? "healthy" as const : "unhealthy" as const,
    checkedAt: data.last_audit_completed_at,
    issueCodes: stale ? ["HEALTH_AUDIT_STALE"] : Array.isArray(data.issue_codes) ? data.issue_codes : ["HEALTH_STATE_INVALID"],
  };
}
