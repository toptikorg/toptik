import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, visibleCopyFromProduct, writeShopifyOwnedMediaAlt, writeShopifyVisibleCopy, type ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml, descriptionPairsEquivalent, descriptionTextFromHtml } from "./description-document";
import { fzt73SourceProjection, readFzt73Snapshot, reconcileFzt73Variants, sameFzt73Source } from "./fzt73-source-worker";
import { planOwnedEdit, requireVariantMediaToken, type OwnedCard, type OwnedEditHelpers, type OwnedVariant } from "./owned-edit-plan";
import { visibleCopiesEquivalent } from "./sync-policy";
import { FZT73_PRODUCT_GID, FZT73_VARIANTS, MD20_PRODUCT_GID, MD20_VARIANTS } from "./variant-source-policy";
import { md20SourceProjection, readMd20Snapshot, reconcileApprovedVariants, sameMd20Source } from "./variant-source-worker";

// Gallery -> Shopify delivery for the two Shopify-owned color families.
//
// The color cards are projections of one Shopify product, so an edit is delivered to Shopify FIRST and
// the cards are rebuilt from Shopify afterwards, by the same projection the webhook worker uses. The
// edit never lands in a card before Shopify has accepted it, which means a refused or conflicting
// edit leaves the Gallery exactly as it was, and no unsent Gallery edit can exist for the projection
// to trip over. The caller holds the product reconciliation lease for the whole call.

type Variant = { sku: string; variantId: string; itemId: string; color: string };
type Family = {
  key: "fzt73" | "md20";
  productGid: string;
  variants: readonly Variant[];
  read: (deadline: number) => Promise<ShopifyOnboardingSnapshot | null>;
  same: (left: ShopifyOnboardingSnapshot | null, right: ShopifyOnboardingSnapshot | null) => boolean;
  reconcile: (db: SupabaseClient, deadline: number, owner: string) => Promise<void>;
  helpers: OwnedEditHelpers<ShopifyOnboardingSnapshot>;
};

const shared = {
  seoSuffix: (variant: OwnedVariant) => ` בצבע ${variant.color}`,
  descriptionPairsEquivalent, descriptionTextFromHtml, assertSafeDescriptionHtml,
};
const FAMILIES: readonly Family[] = [
  {
    key: "fzt73", productGid: FZT73_PRODUCT_GID, variants: FZT73_VARIANTS,
    read: readFzt73Snapshot, same: sameFzt73Source, reconcile: reconcileFzt73Variants,
    helpers: { ...shared, variants: FZT73_VARIANTS, project: (source, variant) => fzt73SourceProjection(source, variant as (typeof FZT73_VARIANTS)[number]),
      titleSuffix: variant => ` בצבע ${variant.color}`, altGuard: () => {} },
  },
  {
    key: "md20", productGid: MD20_PRODUCT_GID, variants: MD20_VARIANTS,
    read: readMd20Snapshot, same: sameMd20Source, reconcile: reconcileApprovedVariants,
    helpers: { ...shared, variants: MD20_VARIANTS, project: (source, variant) => md20SourceProjection(source, variant as (typeof MD20_VARIANTS)[number]),
      titleSuffix: () => "", altGuard: requireVariantMediaToken },
  },
];

export function ownedFamilyForItem(itemId: string): Family | null {
  return FAMILIES.find(family => family.variants.some(variant => variant.itemId === itemId)) ?? null;
}

export type OwnedEditRequest = {
  itemId: string;
  /** The card version the editor loaded; a different stored version means someone else changed it. */
  expectedVersion: string;
  expectedRevision: number;
  patch: {
    title?: string;
    description?: string;
    descriptionHtml?: string;
    seoTitle?: string;
    seoDescription?: string;
    coverImageAlt?: string;
    angles?: { id: string; imageAlt: string }[];
  };
};
export type OwnedEditResult = {
  ok: true;
  itemId: string;
  changed: boolean;
  written: string[];
  alreadyApplied: string[];
  copyUpdatedAt: string;
  editorRevision: number;
};

type ItemRow = { id: string; catalog_number: string | null; is_active: boolean; copy_updated_at: string; editor_revision: number;
  title: string; description: string | null; description_html: string | null; seo_title: string | null; seo_description: string | null;
  cover_image_path: string; cover_image_alt: string | null };
type AngleRow = { id: string; item_id: string; angle_key: string; angle_order: number; image_path: string; image_alt: string | null };

function cardFromRows(item: ItemRow, angles: AngleRow[]): OwnedCard {
  return {
    title: item.title, description: item.description, description_html: item.description_html, seo_title: item.seo_title,
    seo_description: item.seo_description, cover_image_path: item.cover_image_path, cover_image_alt: item.cover_image_alt,
    angles: angles.filter(angle => angle.item_id === item.id)
      .sort((a, b) => a.angle_order - b.angle_order || a.angle_key.localeCompare(b.angle_key) || a.image_path.localeCompare(b.image_path))
      .map(angle => ({ angle_key: angle.angle_key, angle_order: angle.angle_order, image_path: angle.image_path, image_alt: angle.image_alt })),
  };
}

async function readCard(db: SupabaseClient, family: Family, variant: Variant) {
  const [item, angles, bindings] = await Promise.all([
    db.from("carousel_items").select("*").eq("id", variant.itemId).maybeSingle(),
    db.from("carousel_item_angles").select("*").eq("item_id", variant.itemId),
    db.from("shopify_gallery_bindings").select("catalog_key,carousel_item_id,product_gid,variant_gid").eq("carousel_item_id", variant.itemId),
  ]);
  if (item.error || angles.error || bindings.error || !item.data || !angles.data || !bindings.data) throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
  const row = item.data as ItemRow;
  const binding = bindings.data as { catalog_key: string; product_gid: string; variant_gid: string }[];
  if (!row.is_active || row.catalog_number !== variant.sku || binding.length !== 1 || binding[0].catalog_key !== variant.sku ||
      binding[0].product_gid !== family.productGid || binding[0].variant_gid !== `gid://shopify/ProductVariant/${variant.variantId}`) {
    throw new Error("SYNC_OWNED_IDENTITY_CONFLICT");
  }
  return { row, angles: angles.data as AngleRow[] };
}

export async function applyOwnedGalleryEdit(db: SupabaseClient, request: OwnedEditRequest, owner: string, deadline: number): Promise<OwnedEditResult> {
  const family = ownedFamilyForItem(request.itemId);
  if (!family) throw new Error("SYNC_OWNED_ITEM_UNKNOWN");
  if (configuredShopifyDomain() !== "toptikcoil.myshopify.com") throw new Error("SYNC_ONBOARDING_SHOP_MISMATCH");
  const variant = family.variants.find(row => row.itemId === request.itemId)!;
  const stale = (row: ItemRow) => Date.parse(row.copy_updated_at) !== Date.parse(request.expectedVersion) || row.editor_revision !== request.expectedRevision;

  // 1. Refuse an obviously stale form before touching Shopify.
  if (stale((await readCard(db, family, variant)).row)) throw new Error("SYNC_COPY_STALE_EDIT_RELOAD");

  // 2. Bring every color to the current Shopify state first. This also proves, before anything is
  // written, that the projection can follow a change (baselines exist, no unresolved legacy outbox
  // row, no hidden Gallery edit). A Shopify change the editor has not seen moves the card version, so
  // the form is stale and must be reloaded instead of being merged blindly.
  await family.reconcile(db, deadline, owner);
  const loaded = await readCard(db, family, variant);
  if (stale(loaded.row)) throw new Error("SYNC_COPY_STALE_EDIT_RELOAD");

  // 3. Plan against the live product. Nothing here writes.
  const source = await family.read(deadline);
  if (!source || source.status !== "ACTIVE" || !source.publishedOnPublication) throw new Error("SYNC_OWNED_SOURCE_UNPUBLISHED");
  const before = cardFromRows(loaded.row, loaded.angles);
  const angleAlts = (request.patch.angles ?? []).map(entry => {
    const angle = loaded.angles.find(row => row.id === entry.id && row.item_id === variant.itemId);
    if (!angle) throw new Error("SYNC_OWNED_ALT_IMAGE_UNKNOWN");
    return { imagePath: angle.image_path, imageAlt: entry.imageAlt };
  });
  const plan = planOwnedEdit({ source, variant, before, edit: {
    title: request.patch.title, description: request.patch.description, descriptionHtml: request.patch.descriptionHtml,
    seoTitle: request.patch.seoTitle, seoDescription: request.patch.seoDescription, coverImageAlt: request.patch.coverImageAlt,
    angleAlts: request.patch.angles ? angleAlts : undefined,
  } }, family.helpers);
  const done = (changed: boolean, row: ItemRow): OwnedEditResult => ({ ok: true, itemId: request.itemId, changed,
    written: plan.written, alreadyApplied: plan.alreadyApplied, copyUpdatedAt: row.copy_updated_at, editorRevision: row.editor_revision });
  if (plan.noop) return done(false, loaded.row);

  // 4. Shopify has no compare-and-swap: re-read immediately before writing and stop if it moved.
  const fresh = await family.read(deadline);
  if (!fresh || !family.same(source, fresh)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");

  // 5. Write. Image alt text goes first because the file scope is the likelier to be refused, and a
  // refusal then leaves Shopify untouched. A failure after something landed is reported as partial.
  let landed = false;
  try {
    if (plan.mediaAlt.length) { await writeShopifyOwnedMediaAlt(plan.mediaAlt, deadline); landed = true; }
    if (plan.copy) {
      await writeShopifyVisibleCopy(family.productGid, {
        title: plan.copy.title, description: descriptionTextFromHtml(plan.copy.descriptionHtml), descriptionHtml: plan.copy.descriptionHtml,
        seoTitle: plan.copy.seoTitle, seoDescription: plan.copy.seoDescription,
      }, fresh);
      landed = true;
    }
  } catch (error) {
    if (!landed) throw error;
    await family.reconcile(db, deadline, owner).catch(() => undefined);
    throw new Error("SYNC_OWNED_EDIT_PARTIAL");
  }

  // 6. Read back what Shopify now holds, then rebuild every color from it. The rebuild runs even when
  // the readback disagrees, so the Gallery always shows what Shopify really holds.
  let verified = false;
  try {
    const after = await family.read(deadline);
    const copyLanded = !plan.copy || (!!after && visibleCopiesEquivalent(visibleCopyFromProduct(after), {
      title: plan.copy.title, description: descriptionTextFromHtml(plan.copy.descriptionHtml), descriptionHtml: plan.copy.descriptionHtml,
      seoTitle: plan.copy.seoTitle, seoDescription: plan.copy.seoDescription }));
    const altLanded = plan.mediaAlt.every(update => after?.media.find(media => media.id === update.mediaId)?.alt?.trim() === update.alt);
    verified = copyLanded && altLanded;
  } catch {
    verified = false;
  }
  try {
    await family.reconcile(db, deadline, owner);
  } catch {
    // Shopify already holds the change. The webhook it triggers rebuilds the cards on its own.
    throw new Error("SYNC_OWNED_EDIT_DELIVERED_PROJECTION_PENDING");
  }
  if (!verified) throw new Error("SYNC_COPY_READBACK_MISMATCH");
  console.info("Owned gallery edit delivered to Shopify", { family: family.key, itemId: request.itemId, written: plan.written.length });
  return done(true, (await readCard(db, family, variant)).row);
}
