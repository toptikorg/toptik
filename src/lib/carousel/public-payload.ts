import { getCarouselPayload } from "@/lib/carousel/repository";
import { isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";
import { appendSamsoniteItems } from "@/lib/carousel/samsonite-catalog";

/**
 * The public gallery catalog includes the reviewed Samsonite supplement and
 * excludes rows hidden by an editor. Reuse this in every public surface so
 * article product cards resolve against the same active SKUs as /api/carousel.
 */
export async function getPublicCarouselPayload() {
  const payload = await getCarouselPayload({ includeInactive: true });
  if (isUnavailableCarouselPayload(payload)) return payload;

  return {
    ...payload,
    items: appendSamsoniteItems(payload.items).filter((item) => item.isActive),
  };
}
