import type { MetadataRoute } from "next";
import { publishableGalleryArticles } from "@/lib/editorial/gallery-articles";
import { absoluteUrl } from "@/lib/seo/site";
import { galleryVideos } from "@/lib/video-gallery";

export default function sitemap(): MetadataRoute.Sitemap {
  const latestArticleUpdate = publishableGalleryArticles.reduce(
    (latest, article) => article.updatedAt > latest ? article.updatedAt : latest,
    "1970-01-01",
  );
  const mainPages: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), changeFrequency: "monthly", priority: 1 },
    { url: absoluteUrl("/carousel"), changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/videos"), changeFrequency: "weekly", priority: 0.7 },
    { url: absoluteUrl("/journal"), lastModified: latestArticleUpdate, changeFrequency: "weekly", priority: 0.8 },
    { url: absoluteUrl("/accessibility"), changeFrequency: "monthly", priority: 0.3 },
  ];

  const articles: MetadataRoute.Sitemap = publishableGalleryArticles.map((article) => ({
    url: absoluteUrl(`/journal/${article.slug}`),
    lastModified: article.updatedAt,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const videos: MetadataRoute.Sitemap = galleryVideos.map((video) => ({
    url: absoluteUrl(`/videos/${video.slug}`),
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  return [...mainPages, ...articles, ...videos];
}
