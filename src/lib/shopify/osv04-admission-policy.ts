import { assertSafeDescriptionHtml, descriptionTextFromHtml } from "./description-document";
import { assertOnboardingShopifyUniqueness, approvedShopifyImageUrl } from "./onboarding-policy";
import type { ShopifyOnboardingSnapshot, ShopifyOnboardingVariant } from "./admin-api";

/** One explicitly reviewed legacy alias, never a fuzzy/global vendor exception. */
export const OSV04_ADMISSION = {
  policyVersion: "existing-osv04-v1", productId: "gid://shopify/Product/15401872654586",
  variantId: "gid://shopify/ProductVariant/67612818669818", itemId: "70bce0cd-f69f-4d27-8e98-7632b458bf1f",
  gallerySku: "P10OSV04-05J-TU", shopifySku: "P10OSV0405J", catalogKey: "P10OSV0405J", handle: "p10osv0405j",
  manufacturerUrl: "https://mandarinaduck.com/products/eco-coated-trolley-large-expandable-duck-yellow-osv0405j",
  price: "1545.00", currency: "ILS",
} as const;
function fail(code: string): never { throw new Error(code); }
export function validateOsv04AdmissionSource(product: ShopifyOnboardingSnapshot, allVariants: ShopifyOnboardingVariant[], commerce: unknown) {
  const c = commerce as { shop?: { myshopifyDomain?: unknown; currencyCode?: unknown }; product?: { id?: unknown; variants?: { nodes?: Array<{
    id?: unknown; sku?: unknown; price?: unknown; inventoryItem?: { tracked?: unknown } }>; pageInfo?: { hasNextPage?: unknown } } } };
  const id = OSV04_ADMISSION, variant = product.variants[0], v = c?.product?.variants?.nodes;
  if (product.id !== id.productId || product.handle !== id.handle || product.status !== "ACTIVE" || product.publishedOnPublication !== true ||
      !["mandarinaduck", "Mandarina Duck"].includes(product.vendor) || product.variants.length !== 1 || variant?.id !== id.variantId || variant.sku !== id.shopifySku ||
      c?.shop?.myshopifyDomain !== "toptikcoil.myshopify.com" || c.shop.currencyCode !== id.currency || c.product?.id !== id.productId ||
      !Array.isArray(v) || v.length !== 1 || c.product.variants?.pageInfo?.hasNextPage !== false || v[0].id !== id.variantId || v[0].sku !== id.shopifySku ||
      v[0].price !== id.price || v[0].inventoryItem?.tracked !== false) fail("SYNC_OSV04_IDENTITY_OR_COMMERCE_CHANGED");
  assertOnboardingShopifyUniqueness(product, allVariants);
  if (!product.title.trim() || product.title.length > 120 || product.descriptionHtml.length > 200000 ||
      (product.seoTitle?.length ?? 0) > 512 || (product.seoDescription?.length ?? 0) > 5000 || !Number.isFinite(Date.parse(product.updatedAt))) fail("SYNC_OSV04_COPY_INVALID");
  assertSafeDescriptionHtml(product.descriptionHtml);
  const description = descriptionTextFromHtml(product.descriptionHtml);
  if (description.length > 50000 || !product.media.length || product.media.length > 20 || product.media.some(m => m.mediaContentType !== "IMAGE" ||
      m.status !== "READY" || !/^gid:\/\/shopify\/MediaImage\/[1-9][0-9]*$/.test(m.id) || !m.image || !approvedShopifyImageUrl(m.image.url) ||
      !Number.isInteger(m.image.width) || !Number.isInteger(m.image.height) || m.image.width < 1 || m.image.height < 1 ||
      m.image.width > 16000 || m.image.height > 16000 || m.image.width * m.image.height > 16000000) ||
      new Set(product.media.map(m => m.id)).size !== product.media.length ||
      new Set(product.media.map(m => m.image?.url)).size !== product.media.length) fail("SYNC_OSV04_MEDIA_INVALID");
  return { title: product.title, description, descriptionHtml: product.descriptionHtml, seoTitle: product.seoTitle, seoDescription: product.seoDescription };
}
