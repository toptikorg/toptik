// SEO constants for the public gallery and editorial routes.

// Host decision (evidence in docs/seo/SEO-CANDIDATE-REPORT.md): the gallery's
// canonical host is landing.toptik.co.il. site.toptik.co.il, admin.toptik.co.il
// and toptik-iota.vercel.app serve the same app and must canonicalise to it.
export const SITE_ORIGIN = "https://landing.toptik.co.il";
export const STORE_ORIGIN = "https://www.toptik.co.il";
export const SITE_NAME = "TopTik";

export const HOME_PATH = "/";
export const CAROUSEL_PATH = "/carousel";


// The visible heading and metadata title stay identical so structured data and
// the page make the same promise to visitors and search engines.
export const CAROUSEL_VISIBLE_HEADING =
  "קטלוג מזוודות, טרולי ותיקים בתצוגת זוויות: סמסונייט, בריקס ומנדרינה דאק";

export const CAROUSEL_TITLE = CAROUSEL_VISIBLE_HEADING;
export const CAROUSEL_DESCRIPTION =
  "השוו תמונות מכל הזוויות ומפרטי יצרן של מזוודות, טרולי, תיקי גב ותיקי צד מבית סמסונייט, בריקס, מנדרינה דאק ואמריקן טוריסטר, והמשיכו לרכישה בחנות.";

export function absoluteUrl(path: string): string {
  return new URL(path, SITE_ORIGIN).href;
}
