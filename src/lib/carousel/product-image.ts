import { trimmedProductSrc } from "./trim-src";

type ProductImageOwner = {
  id: string;
  catalogNumber?: string | null;
  coverImagePath: string;
  angles: ReadonlyArray<{ imagePath: string; angleOrder?: number }>;
};

export type ProductImageCandidate = { src: string; originalSrc: string };

export function ownProductImagePaths(item: ProductImageOwner): string[] {
  return [...new Set([
    item.coverImagePath,
    ...[...item.angles]
      .sort((a, b) => (a.angleOrder ?? 0) - (b.angleOrder ?? 0))
      .map((angle) => angle.imagePath),
  ].filter(Boolean))];
}

// Include the exact SKU and media list: a reused item ID must not reuse another
// SKU's decoded frame or permanently hide newly corrected media.
export function productImageIdentity(item: ProductImageOwner): string {
  return JSON.stringify([item.id, item.catalogNumber ?? null, ownProductImagePaths(item)]);
}

export function productImageCandidates(
  item: ProductImageOwner,
  preferredSrc: string | null | undefined,
  width: number,
): ProductImageCandidate[] {
  const ownPaths = ownProductImagePaths(item);
  // Never accept a sibling colour's preferred image, even if supplied by a caller.
  const paths = preferredSrc && ownPaths.includes(preferredSrc)
    ? [preferredSrc, ...ownPaths.filter((path) => path !== preferredSrc)]
    : ownPaths;
  const seen = new Set<string>();
  return paths.flatMap((originalSrc) =>
    [trimmedProductSrc(originalSrc, width), originalSrc].flatMap((src) => {
      if (!src || seen.has(src)) return [];
      seen.add(src);
      return [{ src, originalSrc }];
    }),
  );
}

export async function firstDecodedProductImage(
  candidates: readonly ProductImageCandidate[],
  load: (src: string, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<ProductImageCandidate | null> {
  for (const candidate of candidates) {
    signal.throwIfAborted();
    try {
      await load(candidate.src, signal);
      signal.throwIfAborted();
      return candidate;
    } catch {
      signal.throwIfAborted();
    }
  }
  signal.throwIfAborted();
  return null;
}

type ImageProbe = Pick<HTMLImageElement,
  "src" | "decoding" | "onload" | "onerror" | "complete" |
  "naturalWidth" | "naturalHeight" | "decode" | "removeAttribute"
>;

// Injecting the image factory keeps load/decode/timeout/abort behavior testable
// offline. Each URL gets one bounded attempt, never an automatic retry loop.
export function decodeProductImage(
  src: string,
  signal: AbortSignal,
  createImage: () => ImageProbe = () => new Image(),
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const image = createImage();
    let settled = false;
    let decoding = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      if (error) {
        image.removeAttribute("src");
        reject(error);
      } else resolve();
    };
    const abort = () => finish(new DOMException("Image load cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Image load timed out")), timeoutMs);
    const loaded = async () => {
      if (decoding || settled) return;
      decoding = true;
      try {
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("Empty image");
        finish();
      } catch {
        finish(new Error("Image decode failed"));
      }
    };
    image.decoding = "async";
    image.onload = loaded;
    image.onerror = () => finish(new Error("Image load failed"));
    signal.addEventListener("abort", abort, { once: true });
    image.src = src;
    if (image.complete && image.naturalWidth > 0) void loaded();
  });
}
