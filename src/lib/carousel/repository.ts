import { fallbackCarouselPayload } from "@/lib/carousel/fallback-data";
import { CarouselPayload } from "@/lib/carousel/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSupabasePublicEnv } from "@/lib/supabase/public-env";
import { applyReviewedCopy } from "./reviewed-copy";
import { normalizeSyncSku } from "@/lib/shopify/sync-rules";
import { readCompletePages } from "./read-complete-pages";

// Public, read-only catalog access (anon client + RLS). The service-role save
// path lives in ./repository-admin.ts so public routes never import it.

type SettingsRow = {
  id: number;
  autoplay_ms: number;
  editor_revision?: number;
  transition_mode: "shatter-particle" | "curtain-fade";
};

type ItemRow = {
  id: string;
  title: string;
  description: string | null;
  description_html?: string | null;
  seo_title?: string | null;
  seo_description?: string | null;
  copy_updated_at?: string | null;
  editor_revision?: number;
  cover_image_alt?: string | null;
  catalog_number?: string | null;
  source_url?: string | null;
  cover_image_path: string;
  display_order: number;
  is_active: boolean;
  color?: string | null;
  dimensions?: string | null;
  weight?: string | null;
  sizes?: string[] | null;
  available_colors?: string[] | null;
  tech_specs?: import("./types").CachedTechSpecs | null;
  colors?: import("./types").CarouselColor[] | null;
};

type AngleRow = {
  id: string;
  item_id: string;
  angle_key: string;
  image_path: string;
  angle_order: number;
  image_alt?: string | null;
};

type GetCarouselPayloadOptions = {
  includeInactive?: boolean;
  /** Only authenticated admin routes may request stored copy and rich HTML. */
  rawAdmin?: boolean;
};

export async function getCarouselPayload(
  options: GetCarouselPayloadOptions = {},
): Promise<CarouselPayload> {
  if (!hasSupabasePublicEnv()) {
    if (options.rawAdmin) throw new Error("GALLERY_ADMIN_READ_INCOMPLETE");
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

  const [{ data: settingsRow, error: settingsError }, { data: itemRows, error: itemsError }] = await Promise.all([
    supabase.from("carousel_settings").select("*").eq("id", 1).maybeSingle<SettingsRow>(),
    itemQuery,
  ]);

  // Never let a partial editable snapshot be saved as intentional removal.
  if (options.rawAdmin && (settingsError || !settingsRow || itemsError || !Array.isArray(itemRows))) {
    throw new Error("GALLERY_ADMIN_READ_INCOMPLETE");
  }
  if (itemsError || !itemRows) {
    return fallbackCarouselPayload;
  }

  // This table is a narrow public projection (SKU key + verified product URL
  // + publication bit). If the sync migration is not installed yet, retain the
  // audited static map in purchase-links.ts as a backwards-compatible fallback.
  const { data: liveLinks, error: linksError } = await supabase
    .from("shopify_gallery_public_links")
    .select("catalog_key,product_handle,variant_id,is_published");
  if (options.rawAdmin && (linksError || !Array.isArray(liveLinks))) throw new Error("GALLERY_ADMIN_READ_INCOMPLETE");
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
        ...(options.rawAdmin ? { editorRevision: settingsRow?.editor_revision } : {}),
      autoplayMs: settingsRow?.autoplay_ms ?? fallbackCarouselPayload.settings.autoplayMs,
        transitionMode: settingsRow?.transition_mode ?? fallbackCarouselPayload.settings.transitionMode,
      },
    };
  }

  const itemIds = itemRows.map((row: ItemRow) => row.id);
  // Supabase caps a response at 1,000 rows. Read every angle, including in the
  // editor: saving a truncated snapshot otherwise removes unreturned angles.
  // Small ID batches keep the filter URL bounded; stable ordering prevents ties
  // at page boundaries. Exact counts and duplicate checks reject partial reads.
  const angleRows: AngleRow[] = [];
  try {
    for (let offset = 0; offset < itemIds.length; offset += 100) {
      const batch = itemIds.slice(offset, offset + 100);
      angleRows.push(...await readCompletePages<AngleRow>((from, to) => supabase
        .from("carousel_item_angles")
        .select("*", { count: "exact" })
        .in("item_id", batch)
        .order("angle_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)));
    }
  } catch {
    throw new Error(options.rawAdmin ? "GALLERY_ADMIN_READ_INCOMPLETE" : "GALLERY_READ_INCOMPLETE");
  }

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
      descriptionHtml: item.description_html ?? null,
      seoTitle: item.seo_title ?? null,
      seoDescription: item.seo_description ?? null,
      copyUpdatedAt: item.copy_updated_at ?? null,
      ...(options.rawAdmin ? { editorRevision: item.editor_revision } : {}),
      catalogNumber: item.catalog_number ?? null,
      shopifyLink: item.catalog_number
        ? liveLinksByKey.get(normalizeSyncSku(item.catalog_number) ?? "") ?? null
        : null,
      sourceUrl: item.source_url ?? null,
      coverImagePath: item.cover_image_path,
      coverImageAlt: item.cover_image_alt ?? null,
      displayOrder: item.display_order,
      isActive: item.is_active,
      color: item.color ?? null,
      dimensions: item.dimensions ?? null,
      weight: item.weight ?? null,
      sizes: item.sizes ?? null,
      availableColors: item.available_colors ?? null,
      techSpecs: item.tech_specs ?? null,
      colors: item.colors ?? null,
      angles: (anglesByItem.get(item.id) ?? []).map((angle) => ({
        id: angle.id,
        itemId: angle.item_id,
        angleKey: angle.angle_key,
        imagePath: angle.image_path,
        imageAlt: angle.image_alt ?? null,
        angleOrder: angle.angle_order,
      })),
    })).map(item => {
      // Public cards keep escaped text. Raw HTML is used by the authenticated
      // editor only; rawAdmin is passed by the gated admin endpoint.
      // Public supplement deduplication also needs inactive rows, so that
      // independent option must never select the raw admin representation.
      // Admin must round-trip raw stored fields: applying public legacy repairs
      // here would turn an unrelated Save All into edits of other products.
      if (options.rawAdmin) return item;
      const publicItem = { ...applyReviewedCopy(item) };
      Reflect.deleteProperty(publicItem, "descriptionHtml");
      return publicItem;
    }),
    settings: {
      ...(options.rawAdmin ? { editorRevision: settingsRow?.editor_revision } : {}),
      autoplayMs: settingsRow?.autoplay_ms ?? fallbackCarouselPayload.settings.autoplayMs,
      transitionMode: settingsRow?.transition_mode ?? fallbackCarouselPayload.settings.transitionMode,
    },
  };
}
