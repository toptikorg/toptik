import Link from "next/link";
import { ArticleProductCards } from "@/components/editorial/ArticleProductCards";
import type { GalleryArticle } from "./gallery-articles";
import stories from "./lifestyle-stories.json";

// Original editorial essays. Product identity and destination come from the
// same live catalog resolver as existing articles, never from the AI images.
export const lifestyleArticles: readonly GalleryArticle[] = stories.map((story) => {
  const related = stories.find((candidate) => candidate.slug === story.related);
  const words = story.sections.flatMap((section) => section.paragraphs).join(" ").split(/\s+/).length;
  return {
    slug: story.slug,
    category: story.category,
    title: story.title,
    description: story.description,
    standfirst: story.standfirst,
    publishedAt: "2026-10-01",
    updatedAt: "2026-10-01",
    readingMinutes: Math.max(2, Math.ceil(words / 180)),
    byline: "מערכת מגזין TopTik",
    sourceUrls: [],
    hero: {
      src: `/images/journal/lifestyle-20261001/${story.image}.png`,
      alt: story.alt,
      width: 1536,
      height: 1024,
      caption: "המחשת אווירה שנוצרה בבינה מלאכותית; הדמויות והמקום בדיוניים.",
    },
    content: <>
      {story.sections.map((section) => <section key={section.heading}>
        <h2>{section.heading}</h2>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </section>)}
      <aside aria-label="מוצר מהגלריה בהקשר לכתבה">
        <h2>מהגלריה, לדרך שלכם</h2>
        <p>{story.productIntro}</p>
        <ArticleProductCards skus={[story.productSku]} descriptionOverrides={{ [story.productSku.replace(/[^A-Z0-9]/g, "").replace(/TU$/, "")]: story.productIntro }} />
      </aside>
      {related && <p>עוד במגזין: <Link href={`/journal/${related.slug}`}>{related.title}</Link></p>}
    </>,
  };
});
