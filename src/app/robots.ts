import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // APIs are not search landing pages; admin and account routes are crawlable
      // so their explicit noindex directives can be read by crawlers.
      disallow: "/api/",
    },
    sitemap: "https://landing.toptik.co.il/sitemap.xml",
  };
}
