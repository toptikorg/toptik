import type { MetadataRoute } from "next";
import { SITEMAP_PATHS, absoluteUrl } from "@/lib/seo/site";

// Prepared for a later, separately approved indexing release. It is NOT
// advertised in robots.txt and must not be submitted while the noindex hold is
// active. No modification date is emitted: there is no reliable content date and a
// fabricated one would be worse than none.
export default function sitemap(): MetadataRoute.Sitemap {
  return SITEMAP_PATHS.map((path) => ({ url: absoluteUrl(path) }));
}
