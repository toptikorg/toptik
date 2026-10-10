import { STORE_ORIGIN } from "@/lib/seo/site";
import guideTitles from "./store-guide-titles.json";
import articleGuides from "./store-guides.json";

// Editorial cross-links from a gallery journal article to the matching buying
// guides in the Shopify store magazine. The gallery stays the showroom; the
// store keeps price, availability and the purchase flow.
export const STORE_BLOG_HANDLE = "מדריכים";

export type StoreGuideLink = { readonly slug: string; readonly title: string; readonly href: string };

export function storeGuideHref(slug: string): string {
  return `${STORE_ORIGIN}/blogs/${encodeURIComponent(STORE_BLOG_HANDLE)}/${slug}`;
}

const titles: Record<string, string> = guideTitles;
const bySlug: Record<string, readonly string[]> = articleGuides;

export function getStoreGuides(articleSlug: string): readonly StoreGuideLink[] {
  const slugs = bySlug[articleSlug];
  if (!slugs) return [];
  return slugs
    .filter((slug) => typeof titles[slug] === "string")
    .map((slug) => ({ slug, title: titles[slug], href: storeGuideHref(slug) }));
}
