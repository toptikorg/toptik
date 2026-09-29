import { isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { adminCarouselPayloadSchema } from "@/lib/validation/carousel";
import { applyReviewedCopy } from "./reviewed-copy";

// Admin-only write path (service role). Moved unchanged from ./repository.ts so
// the public read path cannot reach the service-role client (GAL-025 / GAL-015).

export async function saveCarouselPayload(input: unknown) {
  // Check before schema parsing strips the failure marker and before any write.
  if (isUnavailableCarouselPayload(input)) {
    throw new Error("Cannot save an unavailable catalog. Reload the catalog first.");
  }
  const parsed = adminCarouselPayloadSchema.parse(input);
  const supabase = createSupabaseServiceRoleClient();

  const normalizedItems = parsed.items.map((item) => ({
    ...applyReviewedCopy(item),
    id: item.id ?? crypto.randomUUID(),
    angles: item.angles.map((angle) => ({
      ...angle,
      id: angle.id ?? crypto.randomUUID(),
    })),
  }));

  const { error: settingsError } = await supabase.from("carousel_settings").upsert(
    {
      id: 1,
      autoplay_ms: parsed.settings.autoplayMs,
      transition_mode: parsed.settings.transitionMode,
    },
    { onConflict: "id" },
  );
  if (settingsError) throw settingsError;

  // Full row incl. scraped side-data (colours + tech specs) so a "save all"
  // from the admin persists everything an import produced — not just images.
  const fullRow = (item: (typeof normalizedItems)[number]) => ({
    id: item.id,
    title: item.title,
    description: item.description ?? null,
    catalog_number: item.catalogNumber ?? null,
    source_url: item.sourceUrl ?? null,
    cover_image_path: item.coverImagePath,
    display_order: item.displayOrder,
    is_active: item.isActive,
    color: item.color ?? null,
    dimensions: item.dimensions ?? null,
    weight: item.weight ?? null,
    sizes: item.sizes ?? null,
    available_colors: item.availableColors ?? null,
    colors: item.colors ?? null,
    tech_specs: item.techSpecs ?? null,
  });

  // Progressive fallbacks for older DB schemas: drop the newest columns first
  // if the DB rejects them, so a save never fails outright on a lagging schema.
  const rowVariants = [
    normalizedItems.map(fullRow),
    // without colors/tech_specs/color/dimensions/weight/sizes/available_colors
    normalizedItems.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description ?? null,
      catalog_number: item.catalogNumber ?? null,
      source_url: item.sourceUrl ?? null,
      cover_image_path: item.coverImagePath,
      display_order: item.displayOrder,
      is_active: item.isActive,
    })),
    // legacy: without catalog_number/source_url too
    normalizedItems.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description ?? null,
      cover_image_path: item.coverImagePath,
      display_order: item.displayOrder,
      is_active: item.isActive,
    })),
  ];

  let itemsError: { message: string } | null = null;
  let upsertedItems: { id: string }[] | null = null;
  for (const rows of rowVariants) {
    const result = await supabase
      .from("carousel_items")
      .upsert(rows, { onConflict: "id" })
      .select("id");
    itemsError = result.error;
    upsertedItems = result.data;
    if (!result.error) break;
    // Only retry with a smaller row when the failure is a missing column.
    if (!/column|does not exist|schema cache/i.test(result.error.message)) break;
  }

  if (itemsError) throw itemsError;

  const validItemIds = new Set((upsertedItems ?? []).map((row: { id: string }) => row.id));

  const { data: existingItems } = await supabase.from("carousel_items").select("id");
  const incomingItemIds = new Set(normalizedItems.map((item) => item.id));
  const itemIdsToDelete = (existingItems ?? [])
    .filter((row: { id: string }) => !incomingItemIds.has(row.id))
    .map((row: { id: string }) => row.id);

  if (itemIdsToDelete.length > 0) {
    const { error: deleteItemsError } = await supabase
      .from("carousel_items")
      .delete()
      .in("id", itemIdsToDelete);
    if (deleteItemsError) throw deleteItemsError;
  }

  const angleRows = normalizedItems.flatMap((item) =>
    item.angles.map((angle) => ({
      id: angle.id,
      item_id: item.id,
      angle_key: angle.angleKey,
      image_path: angle.imagePath,
      angle_order: angle.angleOrder,
    })),
  );

  if (angleRows.length > 0) {
    const { error: anglesError } = await supabase
      .from("carousel_item_angles")
      .upsert(angleRows, { onConflict: "id" });
    if (anglesError) throw anglesError;
  }

  if (validItemIds.size > 0) {
    const { data: existingAngles } = await supabase.from("carousel_item_angles").select("id,item_id");
    const incomingAngleIds = new Set(normalizedItems.flatMap((item) => item.angles.map((angle) => angle.id)));
    const angleIdsToDelete = (existingAngles ?? [])
      .filter((row: { id: string; item_id: string }) => validItemIds.has(row.item_id) && !incomingAngleIds.has(row.id))
      .map((row: { id: string }) => row.id);

    if (angleIdsToDelete.length > 0) {
      await supabase.from("carousel_item_angles").delete().in("id", angleIdsToDelete);
    }
  }

  return { ok: true };
}
