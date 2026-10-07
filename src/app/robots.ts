import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      // These two public resources are required to render the catalog. Keep
      // catalog JSON out of the index through its existing X-Robots-Tag while
      // allowing crawlers to fetch it and the product images referenced by it.
      allow: ["/", "/api/carousel$", "/api/carousel?", "/api/img-trim?"],
      // Other APIs remain blocked. Admin/account pages stay crawlable so their
      // explicit noindex directives can be read; authentication is unchanged.
      disallow: "/api/",
    },
    sitemap: "https://landing.toptik.co.il/sitemap.xml",
  };
}
