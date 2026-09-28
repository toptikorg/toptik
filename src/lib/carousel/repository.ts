import { fallbackCarouselPayload } from "@/lib/carousel/fallback-data";
import { CarouselPayload } from "@/lib/carousel/types";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { hasSupabasePublicEnv } from "@/lib/supabase/env";
import { adminCarouselPayloadSchema } from "@/lib/validation/carousel";

type SettingsRow = {
  id: number;
  autoplay_ms: number;
  transition_mode: "shatter-particle" | "curtain-fade";
};

type ItemRow = {
  id: string;
  title: string;
  description: string | null;
  catalog_number?: string | null;
  source_url?: string | null;
  cover_image_path: string;
  display_order: number;
  is_active: boolean;
  tech_specs?: import("./types").CachedTechSpecs | null;
  colors?: import("./types").CarouselColor[] | null;
};

type AngleRow = {
  id: string;
  item_id: string;
  angle_key: string;
  image_path: string;
  angle_order: number;
};

type GetCarouselPayloadOptions = {
  includeInactive?: boolean;
  strict?: boolean;
};

export async function getCarouselPayload(
  options: GetCarouselPayloadOptions = {},
): Promise<CarouselPayload> {
  if (!hasSupabasePublicEnv()) {
    if (options.strict) throw new Error("Gallery data source is not configured");
    return fallbackCarouselPayload;
  }

  const supabase = createSupabaseServerClient();
  const includeInactive = Boolean(options.includeInactive);
  let itemQuery = supabase
    .from("carousel_items")
    .select("*")
    .order("display_order", { ascending: true });

  if (!includeInactive) {
    itemQuery = itemQuery.eq("is_active", true);
  }

  const [{ data: settingsRow }, { data: itemRows, error: itemsError }] = await Promise.all([
    supabase.from("carousel_settings").select("*").eq("id", 1).maybeSingle<SettingsRow>(),
    itemQuery,
  ]);

  if (itemsError || !itemRows) {
    if (options.strict) throw new Error("Gallery data source is unavailable");
    return fallbackCarouselPayload;
  }

  if (itemRows.length === 0) {
    // DB is reachable but has no products — show a genuinely EMPTY gallery, not
    // the demo fallback. (The fallback is only for the no-DB/error cases above,
    // so local dev still renders something.) Returning demo items here also used
    // to leak them into the admin editor and get persisted on "save all".
    return {
      items: [],
      settings: {
        autoplayMs: settingsRow?.autoplay_ms ?? fallbackCarouselPayload.settings.autoplayMs,
        transitionMode: settingsRow?.transition_mode ?? fallbackCarouselPayload.settings.transitionMode,
      },
    };
  }

  const itemIds = itemRows.map((row: ItemRow) => row.id);
  const { data: angleRows, error: anglesError } = await supabase
    .from("carousel_item_angles")
    .select("*")
    .in("item_id", itemIds.length ? itemIds : [""])
    .order("angle_order", { ascending: true });
  if (options.strict && anglesError) throw new Error("Gallery media source is unavailable");

  const anglesByItem = new Map<string, AngleRow[]>();
  for (const angle of (angleRows ?? []) as AngleRow[]) {
    const existing = anglesByItem.get(angle.item_id) ?? [];
    existing.push(angle);
    anglesByItem.set(angle.item_id, existing);
  }

  return {
    items: (itemRows as ItemRow[]).map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      catalogNumber: item.catalog_number ?? null,
      sourceUrl: item.source_url ?? null,
      coverImagePath: item.cover_image_path,
      displayOrder: item.display_order,
      isActive: item.is_active,
      techSpecs: item.tech_specs ?? null,
      colors: item.colors ?? null,
      angles: (anglesByItem.get(item.id) ?? []).map((angle) => ({
        id: angle.id,
        itemId: angle.item_id,
        angleKey: angle.angle_key,
        imagePath: angle.image_path,
        angleOrder: angle.angle_order,
      })),
    })),
    settings: {
      autoplayMs: settingsRow?.autoplay_ms ?? fallbackCarouselPayload.settings.autoplayMs,
      transitionMode: settingsRow?.transition_mode ?? fallbackCarouselPayload.settings.transitionMode,
    },
  };
}

export async function saveCarouselPayload(input: unknown) {
  const parsed = adminCarouselPayloadSchema.parse(input);
  const supabase = createSupabaseServiceRoleClient();

  const normalizedItems = parsed.items.map((item) => ({
    ...item,
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
