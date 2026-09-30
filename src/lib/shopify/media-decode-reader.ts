import type { MediaIdentity } from "./media-sync-core";
import type { ShopifyMediaImage, ShopifyMediaRead } from "./media-read-adapter";

export type DecodedMediaImage = {
  mediaGid: string; url: string; width: number; height: number;
  mime: string; sha256: string; byteLength: number;
};
export type DecodedMediaRead = { read: ShopifyMediaRead; decoded: DecodedMediaImage[] };
export type MediaReadDependencies = {
  read(identity: MediaIdentity, deadline: number): Promise<ShopifyMediaRead>;
  decode(image: ShopifyMediaImage, deadline: number): Promise<DecodedMediaImage>;
  now(): number;
};

/** No partial batch escapes. This does not create logical keys or import-lineage receipts. */
export async function readDecodedMedia(identity: MediaIdentity, deadline: number, deps: MediaReadDependencies): Promise<DecodedMediaRead> {
  if (!Number.isFinite(deadline)) throw new Error("MEDIA_TIME_BUDGET_INVALID");
  const stopAt = Math.min(deadline, deps.now() + 45_000);
  const check = () => { if (deps.now() >= stopAt) throw new Error("MEDIA_TIME_BUDGET"); };
  check();
  const inputIdentity = structuredClone(identity), first = structuredClone(await deps.read(structuredClone(identity), stopAt));
  check();
  const identityKeys = ["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"] as const;
  if (!first.identity || identityKeys.some(key => first.identity[key] !== inputIdentity[key]) || !/^[a-f0-9]{64}$/.test(first.fingerprint) ||
      !Array.isArray(first.images) || first.images.length > 250) throw new Error("MEDIA_DECODE_READ_IDENTITY_CHANGED");
  const decoded: DecodedMediaImage[] = [];
  // Bounded concurrency limits peak image-buffer memory; no write occurs in this module.
  for (let i = 0; i < first.images.length; i += 2) {
    check();
    const images = first.images.slice(i, i + 2);
    const values = await Promise.all(images.map(image => deps.decode(structuredClone(image), stopAt)));
    check();
    values.forEach((value, index) => {
      const image = images[index];
      if (!value || value.mediaGid !== image.mediaId || value.url !== image.url || value.width !== image.width || value.height !== image.height ||
          !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > 8 * 1024 * 1024 ||
          !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(value.mime)) throw new Error("MEDIA_DECODE_EVIDENCE_INVALID");
      decoded.push(structuredClone(value));
    });
  }
  check();
  const last = await deps.read(structuredClone(inputIdentity), stopAt);
  check();
  if (!last.identity || identityKeys.some(key => last.identity[key] !== inputIdentity[key]) || last.fingerprint !== first.fingerprint) {
    throw new Error("MEDIA_CHANGED_DURING_DECODE");
  }
  return { read: first, decoded };
}
