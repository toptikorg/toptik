import { ArticleProductCard } from "@/components/carousel/ArticleProductCard";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { getPublicCarouselPayload } from "@/lib/carousel/public-payload";
import { normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";
import { referencePolicy } from '@/lib/editorial/product-reference-core';
import { resolveArticleProduct } from '@/lib/editorial/product-reference';

/**
 * Resolve embedded article products from the same read-only active catalog as
 * the gallery. This is a Server Component so the matched product image, name,
 * SKU and exact Shopify product link are emitted in the initial HTML rather
 * than appearing only after a browser-side /api/carousel request.
 */
export async function ArticleProductCards({
  skus,
  descriptionOverrides = {},
}: {
  skus: readonly string[];
  descriptionOverrides?: Readonly<Record<string, string>>;
}) {
  const { items } = await getPublicCarouselPayload();
  const resolved = await Promise.all(skus.map(async (sku) => {
    const key = normalizeCatalogKey(sku);
    const matches = items.filter((candidate) =>
      candidate.isActive &&
      candidate.catalogNumber &&
      normalizeCatalogKey(candidate.catalogNumber) === key,
    );
    // Fail closed: normalization accepts harmless punctuation differences,
    // but two active records with the same normalized SKU are ambiguous.
    let item = matches.length === 1 ? matches[0] : undefined;
    if (matches.length > 1) return null;
    const handles = Object.entries(referencePolicy).filter(([, rule]) => rule.skus.some(value => normalizeCatalogKey(value) === key)).map(([handle]) => handle);
    const handle = item?.shopifyLink?.handle ?? (handles.length === 1 ? handles[0] : null);
    if (!handle) return null;
    const live = await resolveArticleProduct(handle);
    if (!live.product) return null;
    if (live.replaced) {
      const replacements = items.filter(candidate => candidate.shopifyLink?.isPublished === true && candidate.shopifyLink.handle === live.product!.handle);
      item = replacements.length === 1 ? replacements[0] : undefined;
    }
    if (!item || !item.coverImagePath || !purchaseUrlFor(item.catalogNumber, item.shopifyLink)) return null;
    return {
      item,
      replaced: live.replaced,
      descriptionOverride: live.replaced ? undefined : descriptionOverrides[key],
    };
  }));
  const seen = new Set<string>();
  const cards = resolved.filter(card => { if (!card || seen.has(card.item.id)) return false; seen.add(card.item.id); return true; });

  if (cards.length === 0) return null;

  return (
    <div className="journal-product-cards">
      {cards.map(card => card && <div key={card.item.id}>
        {card.replaced && <p>דוגמה זמינה נוספת. מפרט הדגם המתואר במאמר אינו מפרט החלופה.</p>}
        <ArticleProductCard
          item={card.descriptionOverride ? { ...card.item, description: card.descriptionOverride } : card.item}
        />
      </div>)}
    </div>
  );
}
