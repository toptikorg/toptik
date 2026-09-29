// SEO constants for the gallery. The gallery stays noindex, follow: everything
// here only prepares metadata so that a later, separately approved release can
// lift the hold without further code changes. Nothing in this module changes
// robots directives.

// Host decision (evidence in docs/seo/SEO-CANDIDATE-REPORT.md): the gallery's
// canonical host is landing.toptik.co.il. site.toptik.co.il, admin.toptik.co.il
// and toptik-iota.vercel.app serve the same app and must canonicalise to it.
export const SITE_ORIGIN = "https://landing.toptik.co.il";
export const STORE_ORIGIN = "https://www.toptik.co.il";
export const SITE_NAME = "TopTik";

export const HOME_PATH = "/";
export const CAROUSEL_PATH = "/carousel";

// Public, indexable-quality URLs only. Query variants (?category=...) are client
// filters of the same page and are deliberately absent. "/" is a thin brand
// landing page and is not listed until its content is reviewed.
export const SITEMAP_PATHS: readonly string[] = [CAROUSEL_PATH];

// Visible heading of the collection page ("קולקציה נבחרת"); the structured data
// must not claim anything the visitor cannot read on the page.
export const CAROUSEL_VISIBLE_HEADING = "קולקציה נבחרת";

export const CAROUSEL_TITLE = "קולקציה נבחרת | גלריית TopTik";
export const CAROUSEL_DESCRIPTION =
  "גלריית TopTik: מזוודות, טרולי ותיקי נסיעות מהקולקציה שלנו, עם תמונות מכמה זוויות ומפרט טכני. לרכישה ממשיכים לחנות TopTik.";

export function absoluteUrl(path: string): string {
  return new URL(path, SITE_ORIGIN).href;
}
