import { NextRequest, NextResponse } from "next/server";
import { enumerateColorVariants } from "@/lib/catalog-source/mandarina-scraper";
import { enumerateBricsColorVariants } from "@/lib/catalog-source/brics-scraper";
import { uploadVariantGalleries } from "@/lib/catalog-source/storage";
import { ensureOwnColor, toCarouselColors, toBricsCarouselColors } from "@/lib/carousel/colors";
import { dominantHexFromUrl } from "@/lib/carousel/dominant-color";
import type { CarouselColor } from "@/lib/carousel/types";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv, supabaseEnv } from "@/lib/supabase/env";

export const runtime = "nodejs";
export const maxDuration = 300;

// Populate carousel_items.colors for active items — enumerate every colour of
// each model on Mandarina Duck, re-host a cover image per colour, and cache the
// result. Mirrors /api/admin/warm-tech-specs (same auth + cron model). Add
// ?force=1 to refresh items that already have colours.
function isAuthorized(req: NextRequest) {
  const token = req.headers.get("x-admin-token") ?? req.nextUrl.searchParams.get("token");
  if (token && supabaseEnv.adminToken && token === supabaseEnv.adminToken) return true;
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  return false;
}

type ColorWarmRow = {
  id: string;
  catalog_number: string | null;
  source_url: string | null;
  cover_image_path: string;
  title: string | null;
  colors: unknown;
};

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasSupabaseAdminEnv()) {
    return NextResponse.json({ error: "Supabase admin env not configured" }, { status: 500 });
  }

  const reset = req.nextUrl.searchParams.get("reset") === "1";
  const recolor = req.nextUrl.searchParams.get("recolor") === "1";
  const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10) || 0);
  const force = req.nextUrl.searchParams.get("force") === "1";
  // ?thin=1 re-warms items that came back with fewer than 2 colours, to retry
  // them with the current (more complete, sitemap-based) enumeration.
  const thin = req.nextUrl.searchParams.get("thin") === "1";
  // Re-hosting a full gallery per colour is heavy, so process a bounded batch per
  // call and report `remaining` — callers loop until it reaches 0 (no timeout).
  const limit = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "6", 10) || 6, 1),
    28,
  );
  const supabase = createSupabaseServiceRoleClient();

  // `?reset=1` clears cached colours so a subsequent warm repopulates every item
  // with the current scraper logic (use once before a full re-warm).
  if (reset) {
    const { error: resetError } = await supabase
      .from("carousel_items")
      .update({ colors: null })
      .eq("is_active", true);
    if (resetError) return NextResponse.json({ error: resetError.message }, { status: 500 });
    return NextResponse.json({ reset: true });
  }

  // `?recolor=1` recomputes each colour's swatch hex from its own image's
  // dominant colour, so the dot matches the product. Resumable via `?offset=N`.
  if (recolor) {
    const { data: rows, error: rErr } = await supabase
      .from("carousel_items")
      .select("id,colors")
      .eq("is_active", true)
      .order("display_order", { ascending: true });
    if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

    const withColors = (rows ?? []).filter(
      (it: { colors: unknown }) => Array.isArray(it.colors) && (it.colors as unknown[]).length > 0,
    );
    const batch = withColors.slice(offset, offset + limit);
    const results = await Promise.allSettled(
      batch.map(async (it: { id: string; colors: unknown }) => {
        const colors = it.colors as CarouselColor[];
        const updated = await Promise.all(
          colors.map(async (c) => {
            const hex = await dominantHexFromUrl(c.imagePath);
            return hex ? { ...c, hex } : c;
          }),
        );
        const { error: uErr } = await supabase
          .from("carousel_items")
          .update({ colors: updated })
          .eq("id", it.id);
        if (uErr) throw uErr;
        return { id: it.id, colors: updated.length };
      }),
    );
    return NextResponse.json({
      recolor: true,
      offset,
      processed: batch.length,
      remaining: Math.max(0, withColors.length - (offset + batch.length)),
      succeeded: results.filter((r) => r.status === "fulfilled").length,
      failed: results.filter((r) => r.status === "rejected").length,
    });
  }

  const { data: items, error } = await supabase
    .from("carousel_items")
    .select("id,catalog_number,source_url,cover_image_path,title,colors")
    .eq("is_active", true);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const allTargets = (items ?? []).filter(
    (it: ColorWarmRow) =>
      it.source_url &&
      (force ||
        !it.colors ||
        (thin && Array.isArray(it.colors) && (it.colors as unknown[]).length < 2)),
  );
  const targets = allTargets.slice(0, limit);

  const results = await Promise.allSettled(
    targets.map(async (item: ColorWarmRow) => {
      // Vendor-aware: Bric's items enumerate colours from the Shopify variant
      // list; Mandarina items enumerate sibling colour products.
      const isBrics = Boolean(item.source_url?.includes("bricstore.com"));
      const enumerationInput = {
        sourceUrl: item.source_url as string,
        catalogNumber: item.catalog_number,
      };
      const variants = isBrics
        ? await enumerateBricsColorVariants(enumerationInput)
        : await enumerateColorVariants(enumerationInput);

      const folder = `imports/${isBrics ? "brics" : "mandarina"}/${item.catalog_number ?? item.id}/colors`;
      const galleryByHandle = await uploadVariantGalleries(folder, variants);

      // Always keep the item's own colour so a product never ends up with zero
      // colours, even if sibling enumeration / re-hosting fails entirely.
      const mapped = isBrics
        ? toBricsCarouselColors(variants, galleryByHandle)
        : toCarouselColors(variants, galleryByHandle);
      const colors = ensureOwnColor(mapped, {
        catalogNumber: item.catalog_number,
        title: item.title,
        coverImagePath: item.cover_image_path,
      });
      if (colors.length === 0) throw new Error("no colours resolved");

      const { error: updateError } = await supabase
        .from("carousel_items")
        .update({ colors })
        .eq("id", item.id);
      if (updateError) throw updateError;

      return { id: item.id, colors: colors.length };
    }),
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  return NextResponse.json({
    totalActive: items?.length ?? 0,
    targetsAttempted: targets.length,
    remaining: allTargets.length - targets.length,
    succeeded,
    failed,
    skipped: (items?.length ?? 0) - allTargets.length,
    sample: results
      .slice(0, 5)
      .map((r) =>
        r.status === "fulfilled" ? r.value : { error: String((r as PromiseRejectedResult).reason) },
      ),
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
