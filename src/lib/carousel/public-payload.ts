import { getCarouselPayload } from "@/lib/carousel/repository";
import { isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";
import { appendSamsoniteItems } from "@/lib/carousel/samsonite-catalog";
import { readStoreClassification, applyStoreClassification } from "./store-classification";

/**
 * The public gallery catalog includes the reviewed Samsonite supplement and
 * excludes rows hidden by an editor. Reuse this in every public surface so
 * article product cards resolve against the same active SKUs as /api/carousel.
 */
export async function getPublicCarouselPayload(onTiming?: (name: string, ms: number) => void) {
  const timed = async <T>(name: string, promise: Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await promise; }
    finally { onTiming?.(name, performance.now() - start); }
  };
  const specs = process.env.VERCEL_ENV === "production" && process.env.SHOPIFY_TYPED_SPEC_SYNC === "enabled_v1"
    ? import("@/lib/shopify/typed-spec-public").then(module => module.readPublicTypedSpecOverlay())
    : Promise.resolve(null);
  const [payload, classification, applySpecs] = await Promise.all([
    timed("catalog", getCarouselPayload({ includeInactive: true })),
    timed("classification", readStoreClassification()),
    timed("specs", specs),
  ]);
  if (isUnavailableCarouselPayload(payload)) return payload;

  let items = appendSamsoniteItems(payload.items).filter((item) => item.isActive);
  if (applySpecs) items = applySpecs(items);
  return { ...payload, items: applyStoreClassification(items, classification) };
}
