import { ArticleProductCard } from "@/components/carousel/ArticleProductCard";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { getCarouselPayload } from "@/lib/carousel/repository";
import { normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";

/**
 * Resolve embedded article products from the same read-only active catalog as
 * the gallery. This is a Server Component so the matched product image, name,
 * SKU and exact Shopify product link are emitted in the initial HTML rather
 * than appearing only after a browser-side /api/carousel request.
 */
export async function ArticleProductCards({ skus }: { skus: readonly string[] }) {
  const { items } = await getCarouselPayload();
  const cards = skus.flatMap((sku) => {
    const key = normalizeCatalogKey(sku);
    const matches = items.filter((candidate) =>
      candidate.isActive &&
      candidate.catalogNumber &&
      normalizeCatalogKey(candidate.catalogNumber) === key,
    );
    // Fail closed: normalization accepts harmless punctuation differences,
    // but two active records with the same normalized SKU are ambiguous.
    const item = matches.length === 1 ? matches[0] : undefined;
    if (!item || !item.coverImagePath || !purchaseUrlFor(item.catalogNumber)) return [];
    return [item];
  });

  if (cards.length === 0) return null;

  return (
    <div className="journal-product-cards">
      {cards.map((item) => <ArticleProductCard key={`${item.id}:${item.catalogNumber}`} item={item} />)}
    </div>
  );
}
