import type { CachedTechSpecs, CarouselItem } from "@/lib/carousel/types";
import { approvedSourceUrl } from "./source-allowlist";

// Public, read-only tech-spec lookup (GAL-025). It answers only from specs
// already stored with an existing active product whose source URL is approved.
// It never fetches the URL and never writes anything.
export type PublicProductDetailsBody = {
  specs: CachedTechSpecs["specs"];
  colors: CachedTechSpecs["colors"];
  error?: "source_not_approved" | "not_cached";
};

export type PublicProductDetailsResult = { status: 200 | 400 | 404; body: PublicProductDetailsBody };

export function resolvePublicProductDetails(
  rawUrl: string | null,
  items: readonly CarouselItem[],
): PublicProductDetailsResult {
  const requested = approvedSourceUrl(rawUrl);
  if (!requested) return { status: 400, body: { specs: [], colors: [], error: "source_not_approved" } };

  const matches = items.filter((item) =>
    item.isActive && approvedSourceUrl(item.sourceUrl ?? null)?.href === requested.href);
  // Several colour/size SKUs can share one manufacturer page. Answer only when
  // every matching product has the same stored specs, never a sibling's data.
  const stored = matches.map((item) => item.techSpecs ?? null);
  if (stored.length === 0 || stored.some((specs) => !specs)) {
    return { status: 404, body: { specs: [], colors: [], error: "not_cached" } };
  }
  const shapes = new Set(stored.map((specs) => JSON.stringify({ specs: specs!.specs ?? [], colors: specs!.colors ?? [] })));
  if (shapes.size !== 1) return { status: 404, body: { specs: [], colors: [], error: "not_cached" } };
  return { status: 200, body: { specs: stored[0]!.specs ?? [], colors: stored[0]!.colors ?? [] } };
}
