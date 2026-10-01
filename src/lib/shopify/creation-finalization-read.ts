import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

const RPC = "read_finalized_gallery_creation_items";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Only the private SQL receipt/identity join may release a reserved draft to ordinary editing. */
export async function finalizedCreationIds(ids: string[], db: SupabaseClient = createSupabaseServiceRoleClient(),
  deadline = Date.now() + 6000): Promise<Set<string>> {
  if (!Array.isArray(ids) || ids.length > 6000 || ids.some(id => typeof id !== "string" || !UUID.test(id)) ||
      new Set(ids).size !== ids.length || !Number.isFinite(deadline)) throw new Error("SYNC_CREATION_FINALIZATION_INPUT_INVALID");
  const finalized = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SYNC_CREATION_FINALIZATION_TIME_BUDGET");
    const batch = ids.slice(offset, offset + 1000);
    const { data, error } = await db.rpc(RPC, { p_item_ids: batch })
      .abortSignal(AbortSignal.timeout(Math.min(3000, remaining)));
    if (Date.now() >= deadline) throw new Error("SYNC_CREATION_FINALIZATION_TIME_BUDGET");
    if (error) {
      // Additive deployment order: a missing finalization schema must never
      // release a draft. Permission, transport and other SQL errors are real failures.
      if (["PGRST202", "42883"].includes(error.code) && typeof error.message === "string" && error.message.includes(RPC)) {
        return new Set();
      }
      throw new Error("SYNC_CREATION_FINALIZATION_READ_FAILED");
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 1 ||
        !Array.isArray(data.finalizedItemIds) || data.finalizedItemIds.length > batch.length ||
        new Set(data.finalizedItemIds).size !== data.finalizedItemIds.length ||
        data.finalizedItemIds.some((id: unknown) => typeof id !== "string" || !batch.includes(id))) {
      throw new Error("SYNC_CREATION_FINALIZATION_RESULT_INVALID");
    }
    for (const id of data.finalizedItemIds) finalized.add(id);
  }
  return finalized;
}
