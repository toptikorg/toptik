// Pure planning for Gallery edits of Shopify-owned multi-color products (FZT73 and QMMM1/MD20).
//
// The color cards of these products are projections of ONE Shopify product. An edit made on a card
// is therefore translated back into a change of that product, proven by projecting the changed
// product forward again for every color, and only then handed to the caller for delivery under the
// product lease. This file performs no I/O and imports nothing: every dependency arrives through
// `helpers`, which keeps it testable without any server-only module.
//
// Safety rules enforced here:
// - a field is written only if Shopify still shows what the editor loaded (no silent overwrite);
// - a value that cannot be represented exactly in Shopify (the color suffix, the 160-character SEO
//   window, the alt-text media token) is rejected instead of being approximated;
// - the change must keep every color projectable, otherwise the sync loop would stall afterwards.

export type OwnedAngle = { angle_key: string; angle_order: number; image_path: string; image_alt: string | null };
export type OwnedCard = {
  title: string;
  description: string | null;
  description_html: string | null;
  seo_title: string | null;
  seo_description: string | null;
  cover_image_path: string;
  cover_image_alt: string | null;
  angles: OwnedAngle[];
};
export type OwnedMedia = {
  id: string;
  alt: string | null;
  status: string;
  mediaContentType: string;
  image?: { url: string; altText: string | null; width: number; height: number } | null;
};
export type OwnedSource = {
  title: string;
  descriptionHtml: string;
  seoTitle: string | null;
  seoDescription: string | null;
  media: OwnedMedia[];
};
export type OwnedVariant = { sku: string; color: string };
export type OwnedCardEdit = {
  title?: string;
  description?: string;
  descriptionHtml?: string;
  seoTitle?: string;
  seoDescription?: string;
  coverImageAlt?: string;
  /** Keyed by image URL: the only identity a Gallery angle and a Shopify image share. */
  angleAlts?: { imagePath: string; imageAlt: string }[];
};
type DescriptionPair = { description: string; descriptionHtml?: string | null };
export type OwnedEditHelpers<S extends OwnedSource> = {
  /** The family's real forward projection (Shopify product -> one color card). */
  project: (source: S, variant: OwnedVariant) => OwnedCard;
  variants: readonly OwnedVariant[];
  /** FZT73 cards carry " בצבע X" in the title; QMMM1 cards carry the product title as is. */
  titleSuffix: (variant: OwnedVariant) => string;
  seoSuffix: (variant: OwnedVariant) => string;
  /** Family rule for edited alt text; throws when the edit would break the image-to-color mapping. */
  altGuard: (variant: OwnedVariant, currentAlt: string | null, desiredAlt: string) => void;
  descriptionPairsEquivalent: (left: DescriptionPair, right: DescriptionPair) => boolean;
  descriptionTextFromHtml: (html: string) => string;
  assertSafeDescriptionHtml: (html: string) => void;
};
export type OwnedEditPlan = {
  /** Full desired Shopify copy; null when no copy field needs writing. */
  copy: { title: string; descriptionHtml: string; seoTitle: string | null; seoDescription: string | null } | null;
  mediaAlt: { mediaId: string; alt: string }[];
  /** Fields that will be written. */
  written: string[];
  /** Fields Shopify already holds in the requested form (an earlier attempt landed). */
  alreadyApplied: string[];
  noop: boolean;
};

const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_OWNED_ALT_LENGTH = 512;
const MAX_TITLE_LENGTH = 120;
const MAX_SEO_TITLE_LENGTH = 120;

function fail(code: string): never {
  throw new Error(code);
}
const sameText = (left: string | null | undefined, right: string | null | undefined) => (left ?? "") === (right ?? "");

/** QMMM1 identifies an image's color and order by the trailing " | SKU | n" of its alt text. */
export function requireVariantMediaToken(variant: OwnedVariant, currentAlt: string | null, desiredAlt: string): void {
  const token = /( \| ([^|]+) \| (\d+))$/.exec(currentAlt ?? "");
  if (!token || token[2] !== variant.sku || !desiredAlt.endsWith(token[1]) || desiredAlt.length === token[1].length) {
    fail("SYNC_OWNED_ALT_TOKEN_REQUIRED");
  }
}

/**
 * The card's SEO description is the first sentence plus the color suffix, then as many whole
 * following sentences as fit in 160 characters. Return the Shopify text it came from, or null when
 * the card text does not have that exact shape.
 */
export function invertSeoDescription(card: string, suffix: string): string | null {
  if (!card.endsWith(".")) return null;
  const parts = card.slice(0, -1).split(/\.\s+/);
  if (!parts[0].endsWith(suffix)) return null;
  const first = parts[0].slice(0, parts[0].length - suffix.length);
  const rest = parts.slice(1);
  if (!first || first !== first.trim() || rest.some(part => !part || part !== part.trim())) return null;
  return [first, ...rest].join(". ") + ".";
}

const wholeSentences = (text: string) => text.trim().split(/\.\s+/).map(part => part.replace(/\.$/, "")).join(". ") + ".";

export function planOwnedEdit<S extends OwnedSource>(
  input: { source: S; variant: OwnedVariant; before: OwnedCard; edit: OwnedCardEdit },
  helpers: OwnedEditHelpers<S>,
): OwnedEditPlan {
  const { source, variant, before, edit } = input;
  const current = helpers.project(source, variant);
  const patched = { ...source, media: source.media.map(entry => ({ ...entry })) } as S;
  const written: string[] = [];
  const alreadyApplied: string[] = [];
  const mediaAlt: { mediaId: string; alt: string }[] = [];
  const checks: Array<(after: OwnedCard) => boolean> = [];
  let copyTouched = false;

  /**
   * skip: the editor did not change the field, or Shopify already holds the requested value.
   * write: Shopify still shows exactly what the editor loaded.
   * Anything else means somebody changed the same field in Shopify meanwhile.
   */
  const decide = <T>(field: string, loaded: T, live: T, desired: T, same: (left: T, right: T) => boolean): "skip" | "write" => {
    if (same(desired, loaded)) return "skip";
    if (same(desired, live)) { alreadyApplied.push(field); return "skip"; }
    if (!same(live, loaded)) fail("SYNC_OWNED_COPY_CONFLICT");
    return "write";
  };

  if (edit.title !== undefined) {
    const desired = edit.title;
    if (decide("title", before.title, current.title, desired, (a, b) => a === b) === "write") {
      const suffix = helpers.titleSuffix(variant);
      if (suffix && !desired.endsWith(suffix)) fail("SYNC_OWNED_TITLE_SUFFIX_REQUIRED");
      const base = suffix ? desired.slice(0, desired.length - suffix.length) : desired;
      if (!base || base !== base.trim() || base.length > MAX_TITLE_LENGTH || CONTROL.test(base)) fail("SYNC_OWNED_TITLE_INVALID");
      patched.title = base;
      copyTouched = true;
      written.push("title");
      checks.push(after => after.title === desired);
    }
  }

  if (edit.description !== undefined || edit.descriptionHtml !== undefined) {
    if (typeof edit.descriptionHtml !== "string") fail("SYNC_DESCRIPTION_RICH_EDITOR_REQUIRED");
    const html = edit.descriptionHtml;
    const text = helpers.descriptionTextFromHtml(html);
    if (edit.description !== undefined && edit.description !== text) fail("SYNC_DESCRIPTION_PAIR_MISMATCH");
    const desired: DescriptionPair = { description: text, descriptionHtml: html };
    const loaded: DescriptionPair = { description: before.description ?? "", descriptionHtml: before.description_html };
    const live: DescriptionPair = { description: current.description ?? "", descriptionHtml: current.description_html };
    if (decide("description", loaded, live, desired, helpers.descriptionPairsEquivalent) === "write") {
      helpers.assertSafeDescriptionHtml(html);
      patched.descriptionHtml = html;
      copyTouched = true;
      written.push("description");
      checks.push(after => helpers.descriptionPairsEquivalent({ description: after.description ?? "", descriptionHtml: after.description_html }, desired));
    }
  }

  if (edit.seoTitle !== undefined) {
    const desired = edit.seoTitle;
    if (decide("seoTitle", before.seo_title, current.seo_title, desired, sameText) === "write") {
      const suffix = helpers.seoSuffix(variant);
      if (!desired.endsWith(suffix)) fail("SYNC_OWNED_SEO_TITLE_SUFFIX_REQUIRED");
      const base = desired.slice(0, desired.length - suffix.length);
      if (!base || base !== base.trim() || CONTROL.test(base) || desired.length > MAX_SEO_TITLE_LENGTH) fail("SYNC_OWNED_SEO_TITLE_INVALID");
      patched.seoTitle = base;
      copyTouched = true;
      written.push("seoTitle");
      checks.push(after => after.seo_title === desired);
    }
  }

  if (edit.seoDescription !== undefined) {
    const desired = edit.seoDescription;
    if (decide("seoDescription", before.seo_description, current.seo_description, desired, sameText) === "write") {
      const suffix = helpers.seoSuffix(variant);
      const candidate = invertSeoDescription(desired, suffix);
      if (candidate === null || CONTROL.test(candidate)) fail("SYNC_OWNED_SEO_DESCRIPTION_NOT_REPRESENTABLE");
      // Replacing Shopify's text with the card text must not silently drop sentences that the
      // 160-character card window never showed.
      const live = source.seoDescription?.trim();
      if (live && invertSeoDescription(current.seo_description ?? "", suffix) !== wholeSentences(live)) {
        fail("SYNC_OWNED_SEO_DESCRIPTION_NOT_REPRESENTABLE");
      }
      patched.seoDescription = candidate;
      copyTouched = true;
      written.push("seoDescription");
      checks.push(after => after.seo_description === desired);
    }
  }

  // Image alt text. The cover is the first image: its alt text is the same Shopify field.
  const altEdits = new Map<string, string>();
  for (const entry of edit.angleAlts ?? []) {
    if (altEdits.has(entry.imagePath)) fail("SYNC_OWNED_ALT_CONFLICT");
    altEdits.set(entry.imagePath, entry.imageAlt);
  }
  if (edit.coverImageAlt !== undefined && !sameText(edit.coverImageAlt, before.cover_image_alt)) {
    if (before.cover_image_path !== current.cover_image_path) fail("SYNC_OWNED_COPY_CONFLICT");
    const coverLoaded = before.angles.find(angle => angle.image_path === current.cover_image_path)?.image_alt;
    const coverAngle = altEdits.get(current.cover_image_path);
    if (coverAngle !== undefined && !sameText(coverAngle, coverLoaded) && coverAngle !== edit.coverImageAlt) fail("SYNC_OWNED_ALT_CONFLICT");
    altEdits.set(current.cover_image_path, edit.coverImageAlt);
  }
  for (const [imagePath, desired] of altEdits) {
    const loadedAngle = before.angles.find(angle => angle.image_path === imagePath);
    const liveAngle = current.angles.find(angle => angle.image_path === imagePath);
    if (!loadedAngle || !liveAngle) fail("SYNC_OWNED_ALT_IMAGE_UNKNOWN");
    if (decide(`alt:${imagePath}`, loadedAngle.image_alt, liveAngle.image_alt, desired, sameText) !== "write") continue;
    if (!desired || desired !== desired.trim() || desired.length > MAX_OWNED_ALT_LENGTH || CONTROL.test(desired)) fail("SYNC_OWNED_ALT_INVALID");
    helpers.altGuard(variant, liveAngle.image_alt, desired);
    const matches = patched.media.filter(entry => entry.image?.url === imagePath);
    if (matches.length !== 1) fail("SYNC_OWNED_ALT_IMAGE_UNKNOWN");
    matches[0].alt = desired;
    mediaAlt.push({ mediaId: matches[0].id, alt: desired });
    written.push(`alt:${imagePath}`);
    checks.push(after => after.angles.find(angle => angle.image_path === imagePath)?.image_alt === desired);
  }

  if (!written.length) return { copy: null, mediaAlt: [], written, alreadyApplied, noop: true };

  // Every color must still project after the change; one failing color would stall the whole family.
  for (const row of helpers.variants) helpers.project(patched, row);
  const after = helpers.project(patched, variant);
  if (checks.some(check => !check(after))) fail("SYNC_OWNED_EDIT_NOT_REPRESENTABLE");
  return {
    copy: copyTouched ? { title: patched.title, descriptionHtml: patched.descriptionHtml, seoTitle: patched.seoTitle, seoDescription: patched.seoDescription } : null,
    mediaAlt,
    written,
    alreadyApplied,
    noop: false,
  };
}
