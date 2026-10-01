import Link from "next/link";
import { ArticleProductCards } from "@/components/editorial/ArticleProductCards";
import type { GalleryArticle } from "./gallery-articles";
import stories from "./practical-stories.json";

export const practicalArticles: readonly GalleryArticle[] = stories.map((story) => {
  const related = stories.find((candidate) => candidate.slug === story.related);
  const words = story.sections.flatMap((section) => section.paragraphs).join(" ").split(/\s+/).length;
  return {
    slug: story.slug, category: story.category, title: story.title,
    description: story.description, standfirst: story.standfirst,
    publishedAt: "2026-10-01", updatedAt: "2026-10-01",
    readingMinutes: Math.max(2, Math.ceil(words / 180)),
    byline: "מערכת מגזין TopTik", sourceUrls: [],
    content: <>
      {story.sections.map((section, index) => <section key={section.heading}>
        <h2>{section.heading}</h2>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {index === 1 && <aside aria-label="מוצרים מהגלריה בהקשר למאמר">
          <p>{story.productIntro}</p>
          <ArticleProductCards skus={[story.productSku, ...(story.secondSku ? [story.secondSku] : [])]} />
        </aside>}
      </section>)}
      {related && <p>עוד במגזין: <Link href={`/journal/${related.slug}`}>{related.title}</Link></p>}
    </>,
  };
});
