import { trimmedProductSrc } from "./trim-src";

type ProductImageOwner = {
  id: string;
  catalogNumber?: string | null;
  coverImagePath: string;
  angles: ReadonlyArray<{ imagePath: string; angleOrder?: number }>;
};

export type ProductImageCandidate = { src: string; originalSrc: string };

function isProductPhoto(path: string): boolean {
  if (!path.trim()) return false;
  try {
    // This built-in scene is an old admin default, never a product photo.
    // Compare paths so absolute URLs and cache queries cannot reintroduce it.
    return new URL(path, "https://landing.toptik.co.il").pathname !== "/hero-web-airport.png";
  } catch {
    // Keep other supplied assets unchanged; normal decoding decides validity.
    return true;
  }
}

export function ownProductImagePaths(item: ProductImageOwner): string[] {
  return [...new Set([
    item.coverImagePath,
    ...[...item.angles]
      .sort((a, b) => (a.angleOrder ?? 0) - (b.angleOrder ?? 0))
      .map((angle) => angle.imagePath),
  ].filter(isProductPhoto))];
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

// The page whose visibility gates the decode budget (the document in the
// browser; injectable, and absent, in tests / on the server).
type PageVisibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

function currentPage(): PageVisibility | null {
  return typeof document === "undefined" ? null : document;
}

// Injecting the image factory keeps load/decode/timeout/abort behavior testable
// offline. Each URL gets one bounded attempt, never an automatic retry loop.
//
// GAL-028: the time budget only runs while the page is visible. Browsers
// fulfil image.decode() on a rendering frame, and a hidden tab (opened in the
// background, covered by another window, app switched on mobile) gets none, so
// the decode sits pending until the tab is shown again. Counting that time as
// a timeout failed every angle of every card and removed the products from a
// gallery nobody had looked at yet. A hidden page pauses the budget; it
// restarts in full when the page comes back.
export function decodeProductImage(
  src: string,
  signal: AbortSignal,
  createImage: () => ImageProbe = () => new Image(),
  timeoutMs = 10_000,
  page: PageVisibility | null = currentPage(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const image = createImage();
    let settled = false;
    let decoding = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("Image load timed out")), timeoutMs);
    };
    const onVisibility = () => {
      if (settled) return;
      if (page?.hidden) clearTimeout(timer);
      else armTimer();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page?.removeEventListener("visibilitychange", onVisibility);
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      if (error) {
        image.removeAttribute("src");
        reject(error);
      } else resolve();
    };
    const abort = () => finish(new DOMException("Image load cancelled", "AbortError"));
    page?.addEventListener("visibilitychange", onVisibility);
    if (!page?.hidden) armTimer();
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
