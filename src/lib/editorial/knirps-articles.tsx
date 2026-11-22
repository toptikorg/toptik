import type { GalleryArticle } from "./gallery-articles";
import stories from "./knirps-stories.json";
import { EditorialProductLink } from "@/components/editorial/EditorialProductReference";

export const knirpsArticles: readonly GalleryArticle[] = stories.map(story => ({
  slug: story.slug,
  category: "מטריות ליום יום",
  title: story.title,
  description: story.description,
  standfirst: story.standfirst,
  publishedAt: "2026-11-22",
  updatedAt: "2026-11-22",
  readingMinutes: 3,
  byline: "מערכת מגזין טופ תיק",
  sourceUrls: story.sourceUrls,
  hero: story.hero,
  content: <>
    {story.sections.map(section => <section key={section.heading}>
      <h2>{section.heading}</h2>
      {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
    </section>)}
    <h2>לפרטים ולרכישה בטופ תיק</h2>
    <ul>{story.products.map(product => <li key={product.url}><EditorialProductLink href={product.url}>{product.title}</EditorialProductLink></li>)}</ul>
    <h2>להמשך הקריאה</h2>
    <ul>{story.related.map(link => <li key={link.url}><a href={link.url}>{link.title}</a></li>)}</ul>
    <p><a href="/knirps">למבחר המטריות ולמדריכי הבחירה</a></p>
  </>,
}));
