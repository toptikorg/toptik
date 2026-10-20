import { getPublicCarouselPayload } from "@/lib/carousel/public-payload";
import { isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { STORE_MAIN_CATEGORIES } from "@/lib/editorial/store-categories";

// Server-rendered product index for the gallery. The interactive carousel loads
// its catalog in the browser, so the first HTML a crawler receives held only a
// loading message. This list ships every active gallery product, with a link to
// its verified Shopify product page, inside the initial HTML. A product without
// a verified store link is listed without a purchase link, never with a guess.
type IndexEntry = { readonly key: string; readonly title: string; readonly href: string | null };

async function loadEntries(): Promise<readonly IndexEntry[]> {
  try {
    const payload = await getPublicCarouselPayload();
    if (isUnavailableCarouselPayload(payload)) return [];
    const seen = new Set<string>();
    const entries: IndexEntry[] = [];
    for (const item of payload.items) {
      // Crawlable links point at the clean product URL (the store's canonical),
      // without the ?variant= preselection the interactive modal uses.
      const purchaseUrl = purchaseUrlFor(item.catalogNumber, item.shopifyLink);
      const href = purchaseUrl ? purchaseUrl.split("?")[0] : null;
      const key = href ?? `${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, title: item.title, href });
    }
    return entries;
  } catch (error) {
    console.error("CarouselStoreIndex failed", error);
    return [];
  }
}

export async function CarouselStoreIndex() {
  const entries = await loadEntries();
  return (
    <section className="carousel-store-index" aria-labelledby="carousel-store-index-heading" dir="rtl" data-carousel-store-index="">
      <details>
        <summary id="carousel-store-index-heading">כל המוצרים בגלריה, לרכישה בחנות TopTik{entries.length > 0 ? ` (${entries.length})` : ""}</summary>
        {entries.length > 0 && (
          <ul>
            {entries.map((entry) => (
              <li key={entry.key}>{entry.href ? <a href={entry.href}>{entry.title}</a> : <span>{entry.title}</span>}</li>
            ))}
          </ul>
        )}
        <p>לפי קטגוריה בחנות:</p>
        <ul>
          {STORE_MAIN_CATEGORIES.map((link) => <li key={link.href}><a href={link.href}>{link.title}</a></li>)}
        </ul>
      </details>
    </section>
  );
}
