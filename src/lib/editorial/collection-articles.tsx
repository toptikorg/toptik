import Link from "next/link";
import { ArticleProductCards } from "@/components/editorial/ArticleProductCards";
import type { GalleryArticle } from "./gallery-articles";
import stories from "./collection-stories.json";
import sources from "./collection-sources.json";

export const collectionArticles: readonly GalleryArticle[] = stories.map((story) => {
  const related = stories.find((candidate) => candidate.slug === story.related);
  const words = story.sections.flatMap((section) => section.paragraphs).join(" ").split(/\s+/).length;
  return {
    slug: story.slug, category: story.category, title: story.title,
    description: story.description, standfirst: story.standfirst,
    publishedAt: "2026-10-01", updatedAt: "2026-10-01",
    readingMinutes: Math.max(2, Math.ceil(words / 180)),
    byline: "מערכת מגזין TopTik",
    sourceUrls: story.skus.map((sku) => sources[sku as keyof typeof sources]),
    hero: {
      src: `/images/journal/collections-20261001/${story.image}.webp`,
      alt: story.alt, width: 1536, height: 1024,
      caption: "המחשת אווירה שנוצרה בבינה מלאכותית; הדמויות בדיוניות והתיקים בתמונה להמחשה. צילומי המוצרים מופיעים בכרטיסים בהמשך.",
    },
    content: <>
      {story.sections.map((section, index) => <section key={section.heading}>
        <h2>{section.heading}</h2>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {index === 2 && <aside aria-label="מוצרים מהגלריה בהקשר למאמר">
          <h2>לראות את ההבדלים מקרוב</h2>
          <p>{story.productIntro}</p>
          <ArticleProductCards skus={story.skus} />
        </aside>}
      </section>)}
      {related && <p>עוד במגזין: <Link href={`/journal/${related.slug}`}>{related.title}</Link></p>}
    </>,
  };
});
