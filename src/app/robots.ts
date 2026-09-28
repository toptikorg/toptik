import type { MetadataRoute } from "next";
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/dashboard", "/settings", "/setup", "/login", "/reset", "/api/admin/", "/api/panel/"] },
    sitemap: "https://landing.toptik.co.il/sitemap.xml" };
}
