import "server-only";
import type { CarouselPayload } from "@/lib/carousel/types";
import { adminCarouselPayloadSchema } from "@/lib/validation/carousel";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { galleryDraftCreationMode } from "./creation-runtime";
import { finalizedCreationIds } from "./creation-finalization-read";

async function privateDraftIds(): Promise<Set<string>> {
  const db = createSupabaseServiceRoleClient(), ids = new Set<string>();
  const deadline = Date.now() + 6000;
  for (let offset = 0; offset < 6000; offset += 1000) {
    if (Date.now() >= deadline) throw new Error("SYNC_CREATION_CATALOG_TIME_BUDGET");
    const { data, error } = await db.from("shopify_gallery_creation_drafts").select("id").order("id").range(offset, offset + 999)
      .abortSignal(AbortSignal.timeout(Math.min(3000, deadline - Date.now())));
    if (error || !data) {
      // Default-off deployments may precede the additive schema. Once the
      // table exists, even disabling creation must keep its rows private.
      if (!galleryDraftCreationMode() && error && ["42P01", "PGRST205"].includes(error.code) &&
        error.message.includes("shopify_gallery_creation_drafts")) return ids;
      throw new Error("SYNC_CREATION_CATALOG_READ_FAILED");
    }
    data.forEach(row => ids.add(row.id));
    if (data.length < 1000) {
      const finalized = await finalizedCreationIds([...ids], db, deadline);
      finalized.forEach(id => ids.delete(id));
      return ids;
    }
  }
  throw new Error("SYNC_CREATION_CATALOG_LIMIT");
}

/** Reserved inactive products are edited through their immutable intent, not full-catalog save. */
export async function visibleAdminCatalog(payload: CarouselPayload): Promise<CarouselPayload> {
  const privateIds = await privateDraftIds();
  if (payload.items.some(item => privateIds.has(item.id) && item.isActive)) throw new Error("SYNC_CREATION_PRIVATE_ROW_ACTIVE");
  return { ...payload, items: payload.items.filter(item => !privateIds.has(item.id)) };
}

/** Preserve private reservations when a merchant saves unrelated existing catalog edits. */
export async function prepareExistingCatalogSave(input: unknown, current: CarouselPayload): Promise<unknown> {
  const parsed = adminCarouselPayloadSchema.parse(input), privateIds = await privateDraftIds();
  const currentIds = new Set(current.items.map(item => item.id));
  if (galleryDraftCreationMode() && parsed.items.some(item => !item.id || !currentIds.has(item.id))) throw new Error("SYNC_CREATION_NEW_ITEM_USE_INTENT");
  if (parsed.items.some(item => privateIds.has(item.id!))) throw new Error("SYNC_CREATION_PRIVATE_ITEM_USE_INTENT");
  const reserved = current.items.filter(item => privateIds.has(item.id));
  if (reserved.some(item => item.isActive)) throw new Error("SYNC_CREATION_PRIVATE_ROW_ACTIVE");
  // Validation above establishes the shape; preserve the original editable
  // payload for the existing repository validator rather than pre-stripping it.
  const original = input as CarouselPayload;
  // A changed-only save writes exactly the submitted rows and never deletes by
  // omission, so untouched reservations must not be re-sent (that would write
  // them and advance their revisions). A full save still has to carry them.
  if (parsed.saveMode === "changed-only") return { ...original, items: [...original.items] };
  return { ...original, items: [...original.items, ...reserved] };
}
