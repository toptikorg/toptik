import "server-only";
import { assertOwnedMappedAlt } from "./owned-media-projection";
import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredShopifyDomain, visibleCopyFromProduct, writeShopifyOwnedMediaAlt, writeShopifyVisibleCopy, type ShopifyOnboardingSnapshot } from "./admin-api";
import { assertSafeDescriptionHtml, descriptionPairsEquivalent, descriptionTextFromHtml } from "./description-document";
import { fzt73SourceProjection, readFzt73Snapshot, reconcileFzt73Variants, sameFzt73Source } from "./fzt73-source-worker";
import { planOwnedEdit, type OwnedCard, type OwnedEditHelpers, type OwnedVariant } from "./owned-edit-plan";
import { visibleCopiesEquivalent } from "./sync-policy";
import { FZT73_PRODUCT_GID, FZT73_VARIANTS, MD20_PRODUCT_GID, MD20_VARIANTS } from "./variant-source-policy";
import { md20SourceProjection, readMd20Snapshot, reconcileApprovedVariants, sameMd20Source } from "./variant-source-worker";

// Gallery -> Shopify delivery for the two Shopify-owned color families.
//
// The color cards are projections of one Shopify product, so an edit is delivered to Shopify FIRST and
// the cards are rebuilt from Shopify afterwards, by the same projection the webhook worker uses. The
// edit never lands in a card before a Shopify readback. Even a failed first mutation may have changed
// Shopify partially, so recovery reads the actual source and attempts a rebuild. The caller holds
// the product reconciliation lease, which coordinates our workers, not Shopify's own admin UI.

type Variant = { sku: string; variantId: string; itemId: string; color: string };
type Family = {
  key: "fzt73" | "md20";
  productGid: string;
  variants: readonly Variant[];
  read: (deadline: number, db?: SupabaseClient) => Promise<ShopifyOnboardingSnapshot | null>;
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
      titleSuffix: () => "", altGuard: (variant,currentAlt,desiredAlt,source)=>assertOwnedMappedAlt(source,variant,currentAlt,desiredAlt) },
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

function requireTime(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("SYNC_ONBOARDING_TIME_BUDGET");
}

/** Only the requested ALT values (and their image.altText mirror) may move between our two writes. */
function sameAfterOwnAlt(family: Family, before: ShopifyOnboardingSnapshot, after: ShopifyOnboardingSnapshot,
  updates: { mediaId: string; alt: string }[]): boolean {
  const restored = { ...after, media: after.media.map(media => {
    const update = updates.find(row => row.mediaId === media.id);
    const old = before.media.find(row => row.id === media.id);
    if (!update || !old || media.alt !== update.alt) return media;
    const image = media.image && old.image && (media.image.altText === old.image.altText || media.image.altText === update.alt)
      ? { ...media.image, altText: old.image.altText } : media.image;
    return { ...media, alt: old.alt, image };
  }) };
  return family.same(before, restored);
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
  const source = await family.read(deadline,db);
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
  const fresh = await family.read(deadline,db);
  if (!fresh || !family.same(source, fresh)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");

  const desiredCopy = plan.copy ? {
    title: plan.copy.title, description: descriptionTextFromHtml(plan.copy.descriptionHtml), descriptionHtml: plan.copy.descriptionHtml,
    seoTitle: plan.copy.seoTitle, seoDescription: plan.copy.seoDescription,
  } : null;

  // 5. Mark the attempt BEFORE awaiting: fileUpdate can partially apply, and either mutation can
  // land even when its response is lost. Never retry the mutation blindly after an ambiguous reply.
  let attempted = false;
  let mutationFailed = false;
  try {
    if (plan.mediaAlt.length) {
      requireTime(deadline);
      attempted = true;
      await writeShopifyOwnedMediaAlt(plan.mediaAlt, deadline);
    }
    if (desiredCopy) {
      let copySource = fresh;
      if (plan.mediaAlt.length) {
        requireTime(deadline);
        const afterAlt = await family.read(deadline,db);
        if (!afterAlt || !sameAfterOwnAlt(family, fresh, afterAlt, plan.mediaAlt)) throw new Error("SYNC_COPY_CONCURRENT_UPDATE");
        copySource = afterAlt;
      }
      requireTime(deadline);
      attempted = true;
      // The writer sends changed fields only and rechecks the deadline after token acquisition.
      await writeShopifyVisibleCopy(family.productGid, desiredCopy, copySource, deadline);
    }
  } catch (error) {
    if (!attempted) throw error;
    mutationFailed = true;
  }

  // 6. Recover by reading, never by repeating a mutation. A failed read or expired budget cannot
  // establish that nothing landed. A verified source does not imply the Gallery rebuild succeeded.
  let verified = false;
  let readbackKnown = false;
  let someApplied = false;
  let readbackCard: OwnedCard | null = null;
  try {
    requireTime(deadline);
    const after = await family.read(deadline,db);
    readbackKnown = !!after;
    const copyLanded = !desiredCopy || (!!after && visibleCopiesEquivalent(visibleCopyFromProduct(after), desiredCopy));
    const altLanded = plan.mediaAlt.every(update => after?.media.find(media => media.id === update.mediaId)?.alt?.trim() === update.alt);
    verified = !!after && after.status === "ACTIVE" && after.publishedOnPublication && copyLanded && altLanded;
    if (verified) readbackCard = family.helpers.project(after!, variant);
    someApplied = plan.mediaAlt.some(update => after?.media.find(media => media.id === update.mediaId)?.alt?.trim() === update.alt) ||
      (!!after && !!desiredCopy && plan.written.some(field =>
        field === "title" ? after.title === desiredCopy.title :
        field === "description" ? descriptionPairsEquivalent(visibleCopyFromProduct(after), desiredCopy) :
        field === "seoTitle" ? after.seoTitle === desiredCopy.seoTitle :
        field === "seoDescription" ? after.seoDescription === desiredCopy.seoDescription : false));
  } catch {
    verified = false;
  }
  try {
    requireTime(deadline);
    await family.reconcile(db, deadline, owner);
  } catch {
    // ALT-only fileUpdate has no proven products/update delivery or durable retry here.
    throw new Error(verified ? "SYNC_OWNED_EDIT_DELIVERED_PROJECTION_PENDING" : "SYNC_OWNED_EDIT_UNCERTAIN");
  }
  if (!readbackKnown) throw new Error("SYNC_OWNED_EDIT_UNCERTAIN");
  if (mutationFailed && !verified) throw new Error(someApplied ? "SYNC_OWNED_EDIT_PARTIAL" : "SYNC_OWNED_EDIT_UNCERTAIN");
  if (!verified) throw new Error("SYNC_COPY_READBACK_MISMATCH");
  let finalCard: Awaited<ReturnType<typeof readCard>>;
  try { requireTime(deadline); finalCard = await readCard(db, family, variant); }
  catch { throw new Error("SYNC_OWNED_EDIT_UNCERTAIN"); }
  if (JSON.stringify(cardFromRows(finalCard.row, finalCard.angles)) !== JSON.stringify(readbackCard)) {
    throw new Error("SYNC_COPY_READBACK_MISMATCH");
  }
  console.info("Owned gallery edit delivered to Shopify", { family: family.key, itemId: request.itemId, written: plan.written.length });
  return done(true, finalCard.row);
}
