import type { SupabaseClient } from "@supabase/supabase-js";
import type { VerifiedCopyEligibility } from "./sync-rules";

export const VERIFIED_COPY_COLUMNS = "product_gid,catalog_key,carousel_item_id,variant_gid,exact_gallery_sku,exact_shopify_sku,approved_product_handle,allowed_fields,enabled,approval_id,approved_source_updated_at,alias_evidence";

/** Private, reviewed rows only. Never infer eligibility from catalog or SKU similarity. */
export async function readVerifiedCopyEligibility(supabase: SupabaseClient, productGid: string): Promise<VerifiedCopyEligibility | null> {
  const { data, error } = await supabase.from("shopify_gallery_copy_eligibility")
    .select(VERIFIED_COPY_COLUMNS).eq("product_gid", productGid).limit(2);
  if (error) throw new Error("SYNC_COPY_APPROVAL_READ_FAILED");
  if (!data?.length) return null;
  if (data.length !== 1) throw new Error("SYNC_COPY_NOT_APPROVED");
  return data[0] as VerifiedCopyEligibility;
}
