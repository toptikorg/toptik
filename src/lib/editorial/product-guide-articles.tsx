import type { GalleryArticle } from "./gallery-articles";
import stories from "./product-guide-stories.json";

export const productGuideArticles: readonly GalleryArticle[] = stories.map((story) => ({
  slug: story.slug,
  category: "תיקים ליום יום ולעבודה",
  title: story.title,
  description: story.description,
  standfirst: story.standfirst,
  publishedAt: "2026-10-04",
  updatedAt: "2026-10-04",
  readingMinutes: 3,
  byline: "מערכת מגזין טופ תיק",
  sourceUrls: story.sourceUrls,
  hero: story.hero,
  content: <>
    {story.sections.map((section) => <section key={section.heading}>
      <h2>{section.heading}</h2>
      {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </section>)}
    <h2>לפרטים ולרכישה בטופ תיק</h2>
    <ul>{story.products.map((product) => <li key={product.url}><a href={product.url}>{product.title}</a></li>)}</ul>
    <h2>להמשך הקריאה</h2>
    <p><a href={story.related.url}>{story.related.title}</a></p>
  </>,
}));
