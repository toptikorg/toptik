import { getCarouselPayload } from "./repository";
import { getStorefrontSnapshot } from "./storefront-reader";
import { projectStorefront } from "./storefront-projection";
import { LEGACY_VARIANT_IDS } from "./purchase-links";
import type { CarouselPayload } from "./types";
import { applyEditorial } from "./editorial";
import { readEditorialOverrides } from "./editorial-repository";

/** Read-only public view. Deliberately NOT used by /api/admin/carousel or Excel. */
export async function getPublicCatalog(): Promise<CarouselPayload> {
  // A temporary upstream failure is not a product removal or a noindex order.
  // Fail the request rather than publishing a partial sitemap or false 404s.
  // Already-open browsers retain their display and disable stale buy actions.
  const [curated, store, overrides] = await Promise.all([
    getCarouselPayload({ includeInactive: true, strict: true }),
    getStorefrontSnapshot(),
    readEditorialOverrides(),
  ]);
  return applyEditorial(projectStorefront(curated, store, LEGACY_VARIANT_IDS), overrides);
}
