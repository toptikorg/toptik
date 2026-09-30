import type { MetadataRoute } from "next";
import { publishableGalleryArticles } from "@/lib/editorial/gallery-articles";
import { absoluteUrl } from "@/lib/seo/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const mainPages: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), changeFrequency: "monthly", priority: 1 },
    { url: absoluteUrl("/carousel"), changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/journal"), changeFrequency: "weekly", priority: 0.8 },
  ];

  const articles: MetadataRoute.Sitemap = publishableGalleryArticles.map((article) => ({
    url: absoluteUrl(`/journal/${article.slug}`),
    lastModified: article.updatedAt,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [...mainPages, ...articles];
}
