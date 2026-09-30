import { fallbackCarouselPayload } from "@/lib/carousel/fallback-data";
import { CarouselPayload } from "@/lib/carousel/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSupabasePublicEnv } from "@/lib/supabase/public-env";
import { applyReviewedCopy } from "./reviewed-copy";
import { normalizeSyncSku } from "@/lib/shopify/sync-rules";

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
  seo_title?: string | null;
  seo_description?: string | null;
  copy_updated_at?: string | null;
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

  // This table is a narrow public projection (SKU key + verified product URL
  // + publication bit). If the sync migration is not installed yet, retain the
  // audited static map in purchase-links.ts as a backwards-compatible fallback.
  const { data: liveLinks } = await supabase
    .from("shopify_gallery_public_links")
    .select("catalog_key,product_handle,variant_id,is_published");
  const liveLinksByKey = new Map((liveLinks ?? []).map((row: {
    catalog_key: string;
    product_handle: string;
    variant_id: string;
    is_published: boolean;
  }) => [row.catalog_key, {
    handle: row.product_handle,
    variantId: row.variant_id,
    isPublished: row.is_published,
  }]));

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
      seoTitle: item.seo_title ?? null,
      seoDescription: item.seo_description ?? null,
      copyUpdatedAt: item.copy_updated_at ?? null,
      catalogNumber: item.catalog_number ?? null,
      shopifyLink: item.catalog_number
        ? liveLinksByKey.get(normalizeSyncSku(item.catalog_number) ?? "") ?? null
        : null,
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
