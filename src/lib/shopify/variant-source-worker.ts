import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyAdminGraphql, visibleCopyFromProduct, type ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml } from "./description-document";
import { verifyOnboardingImage } from "./onboarding-worker";
import { MD20_PRODUCT_GID, MD20_PRODUCT_HANDLE, MD20_VARIANTS, MD20_LEGACY_UNASSIGNED_MEDIA, exactVariantMedia, exactVariantSeo } from "./variant-source-policy";

async function snapshot(deadline: number): Promise<ShopifyOnboardingSnapshot> {
  const publicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim();
  if (publicationId !== "gid://shopify/Publication/79538258170") throw new Error("SYNC_ONBOARDING_PUBLICATION_MISMATCH");
  type Product = Omit<ShopifyOnboardingSnapshot, "variants" | "media" | "seoTitle" | "seoDescription"> & {
    variants: { nodes: (ShopifyOnboardingSnapshot["variants"][number] & { selectedOptions: { name: string; value: string }[] })[]; pageInfo: { hasNextPage: boolean } };
    media: { nodes: ShopifyOnboardingSnapshot["media"]; pageInfo: { hasNextPage: boolean } };
    seo: { title: string | null; description: string | null };
  };
  const result = await shopifyAdminGraphql<{ product: Product | null }>(`query GalleryApprovedVariantSource($id: ID!, $publicationId: ID!) {
    product(id: $id) { id handle title descriptionHtml status updatedAt vendor productType seo { title description }
      publishedOnPublication(publicationId: $publicationId)
      variants(first: 4) { nodes { id sku selectedOptions { name value } } pageInfo { hasNextPage } }
      media(first: 61) { nodes { id alt status mediaContentType ... on MediaImage { image { url altText width height } } } pageInfo { hasNextPage } }
    }
  }`, { id: MD20_PRODUCT_GID, publicationId }, 6000, deadline);
  const p = result.product;
  if (!p || p.id !== MD20_PRODUCT_GID || p.handle !== MD20_PRODUCT_HANDLE || p.variants.pageInfo.hasNextPage || p.variants.nodes.length !== 3 ||
      MD20_VARIANTS.some(v => !p.variants.nodes.some(row => row.id === `gid://shopify/ProductVariant/${v.variantId}` && row.sku === v.sku &&
        row.selectedOptions.some(option => option.name === "צבע" && option.value === v.color)))) {
    throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  }
  if (p.media.pageInfo.hasNextPage || p.media.nodes.length > 60) throw new Error("SYNC_ONBOARDING_MEDIA_LIMIT");
  if (p.title.length > 120 || p.descriptionHtml.length > 250000) throw new Error("SYNC_ONBOARDING_COPY_LIMIT");
  assertSafeDescriptionHtml(p.descriptionHtml);
  return { ...p, variants: p.variants.nodes, media: p.media.nodes, seoTitle: p.seo?.title ?? null, seoDescription: p.seo?.description ?? null };
}

/** Called only under the existing product lease. No Shopify writes and no new rows. */
export async function reconcileApprovedVariants(db: SupabaseClient, deadline: number): Promise<void> {
  const source = await snapshot(deadline);
  const ids = MD20_VARIANTS.map(v => v.itemId);
  const [items, angles, settings] = await Promise.all([
    db.from("carousel_items").select("*").in("id", ids),
    db.from("carousel_item_angles").select("*").in("item_id", ids),
    db.from("carousel_settings").select("autoplay_ms,transition_mode,editor_revision").eq("id", 1).single(),
  ]);
  if (items.error || angles.error || settings.error || !settings.data || items.data?.length !== 3) throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
  if (MD20_VARIANTS.some(v => !items.data.some(row => row.id === v.itemId && row.catalog_number === v.sku))) throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  const published = source.status === "ACTIVE" && source.publishedOnPublication;
  const copy = visibleCopyFromProduct(source);
  const mediaBySku = new Map(MD20_VARIANTS.map(v => [v.sku, published ? exactVariantMedia(source.media, v.sku) : []]));
  // Unknown/ambiguous assignments must never cross colors, even if their URLs load.
  if (published && source.media.some(m => {
    const assignments = MD20_VARIANTS.filter(v => mediaBySku.get(v.sku)!.some(x => x.id === m.id)).length;
    return assignments > 1 || (assignments === 0 && !MD20_LEGACY_UNASSIGNED_MEDIA.has(m.id));
  })) {
    throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  }
  if (published) {
    // Bounded batches: decode every exact image before exposing it, without
    // loading an unbounded catalog or doing expensive client-side processing.
    const assignedMedia = [...mediaBySku.values()].flat();
    for (let i = 0; i < assignedMedia.length; i += 3) {
      await Promise.all(assignedMedia.slice(i, i + 3).map(media => verifyOnboardingImage(media, deadline)));
    }
  }
  const projected = MD20_VARIANTS.map(v => {
    const old = items.data.find(row => row.id === v.itemId)!;
    const media = mediaBySku.get(v.sku)!;
    const seo = exactVariantSeo(copy, v.sku);
    return { id: v.itemId, title: copy.title, description: copy.description, description_html: copy.descriptionHtml,
      seo_title: seo.seoTitle, seo_description: seo.seoDescription, is_active: published,
      cover_image_path: published ? media[0].image!.url : old.cover_image_path,
      cover_image_alt: published ? media[0].alt : old.cover_image_alt };
  });
  const projectedAngles = MD20_VARIANTS.flatMap(v => published ? mediaBySku.get(v.sku)!.map((m, index) => ({
    id: angles.data!.find(a => a.item_id === v.itemId && a.image_path === m.image!.url)?.id ?? randomUUID(),
    item_id: v.itemId, angle_key: String(index + 1), angle_order: index + 1, image_path: m.image!.url, image_alt: m.alt,
  })) : angles.data!.filter(a => a.item_id === v.itemId).map(a => ({ id: a.id, item_id: a.item_id, angle_key: a.angle_key,
    angle_order: a.angle_order, image_path: a.image_path, image_alt: a.image_alt })));
  if (JSON.stringify(await snapshot(deadline)) !== JSON.stringify(source)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
  const saved = await db.rpc("save_gallery_catalog_atomic", {
    p_items: projected,
    p_expected_versions: Object.fromEntries(items.data.map(row => [row.id, row.copy_updated_at])),
    p_expected_editor_revisions: Object.fromEntries(items.data.map(row => [row.id, row.editor_revision])),
    p_angles: projectedAngles, p_settings: { autoplay_ms: settings.data.autoplay_ms, transition_mode: settings.data.transition_mode },
    p_expected_settings_revision: settings.data.editor_revision,
  });
  if (saved.error) throw new Error("SYNC_VARIANT_GALLERY_SAVE_FAILED");
  const [readItems, readAngles] = await Promise.all([
    db.from("carousel_items").select("*").in("id", ids),
    db.from("carousel_item_angles").select("*").in("item_id", ids),
  ]);
  if (readItems.error || readAngles.error || projected.some(p => {
    const row = readItems.data?.find(r => r.id === p.id);
    return !row || Object.entries(p).some(([key, value]) => row[key] !== value);
  }) || readAngles.data?.length !== projectedAngles.length || projectedAngles.some(p => {
    const row = readAngles.data?.find(r => r.id === p.id);
    return !row || Object.entries(p).some(([key, value]) => row[key] !== value);
  })) throw new Error("SYNC_COPY_READBACK_MISMATCH");
  // These existing variants use the reviewed static purchase map. Identity and
  // handle were checked before writing; do not write the read-only public link
  // projection or enlarge database permissions. A handle change needs review.
  // These rows are audit history, not outbound instructions: Shopify is the
  // approved source. Settle only after all three exact projections read back.
  const settled = await db.from("shopify_gallery_content_outbox").update({ status: "synced", synced_at: new Date().toISOString(), last_error: null })
    .in("carousel_item_id", ids).in("catalog_key", MD20_VARIANTS.map(v => v.sku)).in("status", ["pending", "processing", "review", "failed"]);
  if (settled.error) throw new Error("SYNC_OUTBOX_FINALIZE_FAILED");
}
