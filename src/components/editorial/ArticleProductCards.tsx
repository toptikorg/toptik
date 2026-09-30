import { ArticleProductCard } from "@/components/carousel/ArticleProductCard";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { getCarouselPayload } from "@/lib/carousel/repository";

/**
 * Resolve embedded article products from the same read-only active catalog as
 * the gallery. This is a Server Component so the matched product image, name,
 * SKU and exact Shopify product link are emitted in the initial HTML rather
 * than appearing only after a browser-side /api/carousel request.
 */
export async function ArticleProductCards({ skus }: { skus: readonly string[] }) {
  const { items } = await getCarouselPayload();
  const cards = skus.flatMap((sku) => {
    const item = items.find((candidate) => candidate.isActive && candidate.catalogNumber === sku);
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
