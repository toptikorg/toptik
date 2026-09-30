import type { ShopifyOnboardingSnapshot, ShopifyOnboardingVariant } from "./admin-api";
import { assertSafeDescriptionHtml, descriptionTextFromHtml } from "./description-document";
import { isSafeShopifyProductHandle, normalizeSyncSku } from "./sync-rules";

export const PUBLIC_ONBOARDING_POLICY = "published-shopify-v1";
export const ONBOARDING_SHOP_DOMAIN = "toptikcoil.myshopify.com";
export const MAX_ONBOARDING_IMAGES = 20;
export const MAX_ONBOARDING_IMAGE_BYTES = 8 * 1024 * 1024;
const HELD_SKUS = new Set(["P10OSV0405J", "P10ZJT0624U"]);
const BRANDS: Record<string, "Mandarina Duck" | "Bric's" | "Samsonite"> = {
  "mandarina duck": "Mandarina Duck", "bric's": "Bric's", "bric’s": "Bric's", brics: "Bric's", samsonite: "Samsonite",
};
const CATEGORY_TYPES: Record<string, "carryon" | "suitcase"> = {
  "carry-on luggage": "carryon", "cabin luggage": "carryon", "מזוודת עלייה למטוס": "carryon",
  "checked luggage": "suitcase", "checked suitcase": "suitcase", "מזוודה לבטן המטוס": "suitcase",
};

export type OnboardingImageEvidence = { mediaGid: string; url: string; width: number; height: number;
  mime: string; sha256: string; byteLength: number };

export function approvedShopifyImageUrl(raw: string): URL | null {
  if (!raw || raw.length > 2048 || /[\\\s]/.test(raw) || !raw.startsWith("https://cdn.shopify.com/")) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "cdn.shopify.com" && !url.username && !url.password &&
      !url.port && !url.hash && url.pathname.startsWith("/s/files/") ? url : null;
  } catch { return null; }
}

/** null is an intentional exclusion, never permission to create a private/other-brand product. */
export function publicOnboardingCandidate(product: ShopifyOnboardingSnapshot) {
  const vendorKey = product.vendor.trim().toLowerCase();
  const brandLabel = Object.hasOwn(BRANDS, vendorKey) ? BRANDS[vendorKey] : null;
  if (product.status !== "ACTIVE" || !product.publishedOnPublication || !brandLabel) return null;
  if (product.variants.length !== 1) throw new Error("SYNC_ONBOARDING_MULTIPLE_VARIANTS");
  const variant = product.variants[0];
  const exactSku = variant.sku;
  const catalogKey = normalizeSyncSku(exactSku);
  if (catalogKey && HELD_SKUS.has(catalogKey)) return null;
  if (!exactSku || exactSku !== exactSku.trim() || exactSku.length < 2 || exactSku.length > 64 || !/^[A-Za-z0-9._ /-]+$/.test(exactSku) || !catalogKey ||
      !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id) || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id) ||
      !isSafeShopifyProductHandle(product.handle) || !Number.isFinite(Date.parse(product.updatedAt))) {
    throw new Error("SYNC_ONBOARDING_IDENTITY_INVALID");
  }
  if (!product.title.trim() || product.title.length > 120 || product.descriptionHtml.length > 200_000 ||
      (product.seoTitle?.length ?? 0) > 512 || (product.seoDescription?.length ?? 0) > 5_000) {
    throw new Error("SYNC_ONBOARDING_COPY_LIMIT");
  }
  try { assertSafeDescriptionHtml(product.descriptionHtml); }
  catch { throw new Error("SYNC_ONBOARDING_HTML_UNSAFE"); }
  const description = descriptionTextFromHtml(product.descriptionHtml);
  if (description.length > 50_000) throw new Error("SYNC_ONBOARDING_COPY_LIMIT");
  if (product.media.length > MAX_ONBOARDING_IMAGES) throw new Error("SYNC_ONBOARDING_MEDIA_LIMIT");
  const media = product.media.filter(entry => entry.mediaContentType === "IMAGE");
  if (!media.length || media.some(entry => entry.status !== "READY" || !entry.image)) throw new Error("SYNC_ONBOARDING_MEDIA_NOT_READY");
  if (new Set(media.map(entry => entry.id)).size !== media.length || media.some(entry =>
    !/^gid:\/\/shopify\/MediaImage\/\d+$/.test(entry.id) || !entry.image || !approvedShopifyImageUrl(entry.image.url) ||
    !Number.isInteger(entry.image.width) || !Number.isInteger(entry.image.height) || entry.image.width < 1 || entry.image.height < 1 ||
    entry.image.width > 16000 || entry.image.height > 16000 || entry.image.width * entry.image.height > 16_000_000)) {
    throw new Error("SYNC_ONBOARDING_MEDIA_IDENTITY_INVALID");
  }
  const categoryKey = product.productType.trim().toLowerCase();
  return { brandLabel, category: Object.hasOwn(CATEGORY_TYPES, categoryKey) ? CATEGORY_TYPES[categoryKey] : null,
    exactSku, catalogKey, variantGid: variant.id, media,
    copy: { title: product.title, description, descriptionHtml: product.descriptionHtml,
      seoTitle: product.seoTitle, seoDescription: product.seoDescription } };
}

/** Normalization detects collisions only; the surviving Shopify raw SKU must match exactly. */
export function assertOnboardingShopifyUniqueness(product: ShopifyOnboardingSnapshot, all: ShopifyOnboardingVariant[]): void {
  const variant = product.variants[0];
  const key = normalizeSyncSku(variant?.sku);
  const matches = all.filter(row => normalizeSyncSku(row.sku) === key);
  if (!key || matches.length !== 1 || matches[0].id !== variant.id || matches[0].product.id !== product.id || matches[0].sku !== variant.sku) {
    throw new Error("SYNC_ONBOARDING_SHOPIFY_SKU_COLLISION");
  }
}

/** Compare all copy/identity/media evidence, not updatedAt alone. */
export function onboardingSnapshotFingerprint(product: ShopifyOnboardingSnapshot): string {
  return JSON.stringify({ id: product.id, handle: product.handle, title: product.title, descriptionHtml: product.descriptionHtml,
    seoTitle: product.seoTitle, seoDescription: product.seoDescription, status: product.status, updatedAt: product.updatedAt,
    publishedOnPublication: product.publishedOnPublication, vendor: product.vendor, productType: product.productType,
    variants: product.variants, media: product.media });
}
