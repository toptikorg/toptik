/** Browser preview only. The authenticated POST repeats authoritative identity,
 * READY media, current bytes, deny-list and signature checks before any write. */
export type MediaReviewInput = {
  identity: { productId: string; variantId: string; itemId: string; exactGallerySku: string; exactShopifySku: string; productHandle: string };
  mediaId: string; imageUrl: string; expectedSha256: string; sourceUrl: string; evidence: string; reviewedExactSkuColor: true;
};
export type ReviewCatalogItem = { id: string; sku: string; title: string; color: string | null; handle: string; variantId: string };
export type MediaReviewPreview = { input: MediaReviewInput; item: ReviewCatalogItem; key: string };
function fail(): never { throw new Error("תוכנית האישור אינה תקינה או אינה מתאימה לזהות המוצר בגלריה."); }
const row = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
function exactKeys(v: Record<string, unknown>, keys: string[]) { if (Object.keys(v).sort().join("|") !== keys.sort().join("|")) fail(); }
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v !== v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) fail();
  return v;
}
function url(v: unknown, image = false): string {
  const s = text(v, 2048); let u: URL; try { u = new URL(s); } catch { return fail(); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || /[\s\\]/.test(s) ||
      (image && (u.origin !== "https://cdn.shopify.com" || !u.pathname.startsWith("/s/files/") || /%(?:2e|2f|5c)/i.test(u.pathname)))) fail();
  return s;
}
export function prepareMediaReview(textInput: string, catalog: ReviewCatalogItem[]): MediaReviewPreview[] {
  if (textInput.length > 200000) fail();
  let data: unknown; try { data = JSON.parse(textInput); } catch { return fail(); }
  if (!Array.isArray(data) || !data.length || data.length > 20) fail();
  const seen = new Set<string>();
  return data.map(value => {
    const v = row(value), i = row(v.identity);
    exactKeys(v, ["identity", "mediaId", "imageUrl", "expectedSha256", "sourceUrl", "evidence", "reviewedExactSkuColor"]);
    exactKeys(i, ["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"]);
    const identity = { productId: text(i.productId, 100), variantId: text(i.variantId, 100), itemId: text(i.itemId, 36),
      exactGallerySku: text(i.exactGallerySku, 255), exactShopifySku: text(i.exactShopifySku, 255), productHandle: text(i.productHandle, 255) };
    if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(identity.productId) || !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(identity.variantId) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(identity.itemId) || v.reviewedExactSkuColor !== true) fail();
    const mediaId = text(v.mediaId, 100), expectedSha256 = text(v.expectedSha256, 64);
    if (!/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(mediaId) || !/^[a-f0-9]{64}$/.test(expectedSha256)) fail();
    const item = catalog.find(x => x.id === identity.itemId);
    if (!item || item.sku !== identity.exactGallerySku || item.handle !== identity.productHandle ||
        `gid://shopify/ProductVariant/${item.variantId}` !== identity.variantId) fail();
    const input: MediaReviewInput = { identity, mediaId, imageUrl: url(v.imageUrl, true), expectedSha256,
      sourceUrl: url(v.sourceUrl), evidence: text(v.evidence, 1000), reviewedExactSkuColor: true };
    const key = `${identity.itemId}:${mediaId}`;
    if (seen.has(key)) fail(); seen.add(key);
    return { input, item, key: `${key}:${expectedSha256}:${input.imageUrl}` };
  });
}
