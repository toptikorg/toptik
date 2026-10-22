import { STORE_ORIGIN } from "@/lib/seo/site";

// Category and brand links from the gallery magazine into the Shopify store.
// The magazine brings readers in from search; the store keeps price, stock and
// checkout. Every link points at a live collection handle on www.toptik.co.il.
export type StoreCategoryLink = { readonly title: string; readonly href: string };

function collection(handle: string, title: string): StoreCategoryLink {
  return { title, href: `${STORE_ORIGIN}/collections/${encodeURIComponent(handle)}` };
}

export const STORE_MAIN_CATEGORIES: readonly StoreCategoryLink[] = [
  collection("מזוודות", "מזוודות"),
  collection("טרולי-carry-on", "טרולי לעלייה למטוס"),
  collection("fashion-bags", "תיקי צד ותיקי כתף"),
  collection("backpacks", "תיקי גב"),
  collection("wallets", "ארנקים"),
  collection("toiletry-pouches", "תיקי רחצה ונרתיקים"),
];

export const STORE_BRANDS: readonly StoreCategoryLink[] = [
  collection("samsonite", "סמסונייט"),
  collection("mandarina-duck", "מנדרינה דאק"),
  collection("brics", "בריקס"),
  collection("american-tourister", "אמריקן טוריסטר"),
];

// Brand rules come first so a model article links to its brand page before the
// generic product type. Matching runs on the article slug, title, description
// and category only, never on body copy.
const RULES: ReadonlyArray<readonly [RegExp, StoreCategoryLink]> = [
  [/samsonite|סמסונייט|intuo|upscape|urbify|c-lite|respark|biz2go|pro-dlx/i, collection("samsonite", "סמסונייט")],
  [/mandarina|מנדרינה|mellow|md20|revival|logoduck|zephyr|eco coated|daisy/i, collection("mandarina-duck", "מנדרינה דאק")],
  [/bric|בריקס|taormina|volterra|x-collection/i, collection("brics", "בריקס")],
  [/american tourister|אמריקן טוריסטר/i, collection("american-tourister", "אמריקן טוריסטר")],
  [/טרולי|carry-?on|55 ס|עלייה למטוס|כבודת יד/i, collection("טרולי-carry-on", "טרולי לעלייה למטוס")],
  [/מזוודה|מזוודות|suitcase|luggage/i, collection("מזוודות", "מזוודות")],
  [/תיק גב|תיקי גב|backpack/i, collection("backpacks", "תיקי גב")],
  [/תיק צד|תיקי צד|תיק כתף|קרוסבודי|crossbody|shoulder/i, collection("fashion-bags", "תיקי צד ותיקי כתף")],
  [/ארנק|wallet/i, collection("wallets", "ארנקים")],
  [/נרתיק|תיק רחצה|תיקי רחצה|איפור|toiletry|beauty|pouch/i, collection("toiletry-pouches", "תיקי רחצה ונרתיקים")],
];

const FALLBACK: readonly StoreCategoryLink[] = [
  collection("מזוודות-וטרולי", "מזוודות וטרולי"),
  collection("fashion-bags", "תיקי צד ותיקי כתף"),
  collection("all", "כל המוצרים בחנות"),
];

export function getStoreCategoryLinks(
  article: { readonly slug: string; readonly title: string; readonly description: string; readonly category: string; readonly storeCategoryLinks?: readonly StoreCategoryLink[] },
  limit = 4,
): readonly StoreCategoryLink[] {
  if (article.storeCategoryLinks?.length) return article.storeCategoryLinks.slice(0, limit);
  const text = [article.slug, article.title, article.description, article.category].join(" ");
  const links: StoreCategoryLink[] = [];
  for (const [pattern, link] of RULES) {
    if (pattern.test(text) && !links.some((existing) => existing.href === link.href)) links.push(link);
    if (links.length >= limit) break;
  }
  return links.length > 0 ? links : FALLBACK;
}
