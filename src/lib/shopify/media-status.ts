import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

async function call(name: string, productId: string | null, deadline: number) {
  if (productId !== null && !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productId)) throw new Error("MEDIA_STATUS_INPUT_INVALID");
  const ms = Math.min(5000, deadline - Date.now());
  if (!Number.isFinite(deadline) || ms <= 0) throw new Error("MEDIA_STATUS_TIME_BUDGET");
  const { data, error } = await createSupabaseServiceRoleClient().rpc(name, { p_product_gid: productId }).abortSignal(AbortSignal.timeout(ms));
  if (error) throw new Error("MEDIA_STATUS_RPC_FAILED");
  return data;
}
export async function readMediaStatus(productId: string | null, deadline: number) {
  const data = await call("read_toptik_media_status", productId, deadline);
  if (!data || !Array.isArray(data.queue) || typeof data.observedAt !== "string") throw new Error("MEDIA_STATUS_RESPONSE_INVALID");
  return data;
}
export async function enqueueReviewedMedia(productId: string, deadline: number) {
  const data = await call("enqueue_toptik_reviewed_media_work", productId, deadline);
  if (typeof data !== "boolean") throw new Error("MEDIA_STATUS_RESPONSE_INVALID");
  return data;
}
