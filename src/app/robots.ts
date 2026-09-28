import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      // Public pages must remain crawlable for their noindex directives to be seen.
      allow: "/",
      disallow: [
        "/admin",
        "/dashboard",
        "/settings",
        "/setup",
        "/login",
        "/reset",
        "/auth",
        "/api/admin",
        "/api/panel",
      ],
    },
    // Deliberately do not advertise a sitemap during the indexing hold.
  };
}
