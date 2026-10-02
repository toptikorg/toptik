// Owner-approved 2026-10-03: these existing colors are Shopify-owned projections.
// This is not permission to admit arbitrary multi-variant products.
export const MD20_PRODUCT_GID = "gid://shopify/Product/7512404951290";
export const MD20_PRODUCT_HANDLE = "md-20-תיק-פאוץ-מבית-מנדרינה-דאק";
// Pre-existing unassigned media verified on 2026-10-03. Do not infer their
// colors or expose them in the gallery; new unassigned media requires review.
export const MD20_LEGACY_UNASSIGNED_MEDIA = new Set([
  "28993546911994", "28993552711930", "28993554645242", "28993555792122",
  "28993600979194", "28993602846970", "28993604747514", "28993606516986",
  "28993608646906", "28993609924858", "28993610973434", "28993611596026",
].map(id => `gid://shopify/MediaImage/${id}`));
export const MD20_VARIANTS = [
  { sku: "P10QMMM1651", variantId: "42307603103994", itemId: "e78b4341-95ae-56e2-ba11-58c2d1e15f8e" },
  { sku: "P10QMMM1465", variantId: "42307603136762", itemId: "973d074a-ace0-5225-90e6-8f348d9b3e1c" },
  { sku: "P10QMMM109K", variantId: "42307603169530", itemId: "63110328-f35d-5247-8793-48abc8450124" },
] as const;
export const SHOPIFY_OWNED_MESSAGE = "שלושת צבעי MD20 מתעדכנים אוטומטית מהחנות. יש לערוך את המוצר ב-Shopify ואז לרענן את הגלריה.";
export function isShopifyOwnedVariant(itemId: string): boolean {
  return MD20_VARIANTS.some(variant => variant.itemId === itemId);
}

type Media = { id: string; alt: string | null; status: string; mediaContentType: string;
  image?: { url: string; altText: string | null; width: number; height: number } | null };
export function exactVariantMedia(media: Media[], sku: string): Media[] {
  const selected = media.filter(entry => (entry.alt ?? "").includes(` | ${sku} | `));
  if (!selected.length || selected.length > 20) throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  const orders = selected.map(entry => Number(entry.alt?.match(/ (\d+)$/)?.[1]));
  if (orders.some(order => !Number.isSafeInteger(order) || order < 1) || new Set(orders).size !== orders.length ||
      new Set(selected.map(entry => entry.image?.url)).size !== selected.length ||
      selected.some(entry => entry.status !== "READY" || entry.mediaContentType !== "IMAGE" || !entry.image)) {
    throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  }
  return selected.sort((a, b) => Number(a.alt?.match(/ (\d+)$/)?.[1]) - Number(b.alt?.match(/ (\d+)$/)?.[1]));
}
