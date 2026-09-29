import {
  CAROUSEL_PATH,
  CAROUSEL_VISIBLE_HEADING,
  CAROUSEL_DESCRIPTION,
  HOME_PATH,
  SITE_NAME,
  STORE_ORIGIN,
  absoluteUrl,
} from "./site";

// One CollectionPage node describing the page that is actually rendered.
// Deliberately NOT emitted: Product / Offer / AggregateRating / ItemList.
// The gallery has no per-product URL, and price, currency and availability are
// owned by the Shopify store, so any such markup would describe content that
// is not on this page.
export function carouselStructuredData() {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${absoluteUrl(CAROUSEL_PATH)}#page`,
    url: absoluteUrl(CAROUSEL_PATH),
    name: CAROUSEL_VISIBLE_HEADING,
    description: CAROUSEL_DESCRIPTION,
    inLanguage: "he",
    isPartOf: {
      "@type": "WebSite",
      name: SITE_NAME,
      url: absoluteUrl(HOME_PATH),
    },
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      url: `${STORE_ORIGIN}/`,
    },
  };
}

// JSON for a <script type="application/ld+json"> element. "<" is escaped so the
// payload can never terminate the script element.
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
