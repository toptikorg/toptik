import { fallbackCarouselPayload } from "@/lib/carousel/fallback-data";
import { CarouselPayload } from "@/lib/carousel/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSupabasePublicEnv } from "@/lib/supabase/public-env";
import { applyReviewedCopy } from "./reviewed-copy";

// Public, read-only catalog access (anon client + RLS). The service-role save
// path lives in ./repository-admin.ts so public routes never import it.

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
};

export async function getCarouselPayload(
  options: GetCarouselPayloadOptions = {},
): Promise<CarouselPayload> {
  if (!hasSupabasePublicEnv()) {
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
    return fallbackCarouselPayload;
  }

  if (itemRows.length === 0) {
    // A successful empty read is distinct from the unavailable fallback above.
    return {
      items: [],
      settings: {
        autoplayMs: settingsRow?.autoplay_ms ?? fallbackCarouselPayload.settings.autoplayMs,
        transitionMode: settingsRow?.transition_mode ?? fallbackCarouselPayload.settings.transitionMode,
      },
    };
  }

  const itemIds = itemRows.map((row: ItemRow) => row.id);
  const { data: angleRows } = await supabase
    .from("carousel_item_angles")
    .select("*")
    .in("item_id", itemIds.length ? itemIds : [""])
    .order("angle_order", { ascending: true });

  const anglesByItem = new Map<string, AngleRow[]>();
  for (const angle of (angleRows ?? []) as AngleRow[]) {
    const existing = anglesByItem.get(angle.item_id) ?? [];
    existing.push(angle);
    anglesByItem.set(angle.item_id, existing);
  }

  return {
    items: (itemRows as ItemRow[]).map((item) => applyReviewedCopy({
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
