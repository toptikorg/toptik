import { EditorialProductFigure, EditorialProductLink } from '@/components/editorial/EditorialProductReference';
import Link from "next/link";
import type { GalleryArticle } from "./gallery-articles";
import stories from "./mandarina-image-stories.json";

// Image-led Mandarina Duck model articles (2026-10-12). Facts come only from
// verified catalog specs; products link to the exact Shopify product pages and
// each article links to its paired store-blog article.
export const mandarinaImageArticles: readonly GalleryArticle[] = stories.map((story) => {
  const words = story.sections.flatMap((section) => section.paragraphs).join(" ").split(/\s+/).length;
  return {
    slug: story.slug,
    category: "מבט מקרוב על הדגם",
    title: story.title,
    description: story.description,
    standfirst: story.standfirst,
    publishedAt: "2026-10-12",
    updatedAt: "2026-10-12",
    readingMinutes: Math.max(2, Math.ceil(words / 180)),
    byline: "מערכת מגזין TopTik",
    sourceUrls: [],
    hero: story.hero,
    content: <>
      {story.sections.map((section) => <section key={section.heading}>
        <h2>{section.heading}</h2>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </section>)}
      {story.images.length > 0 && <section aria-label="צבעים נוספים של הדגם">
        <h2>הדגם בצבעים נוספים</h2>
        {story.images.map(image => {
          const matches = story.products.filter(product => product.color === image.color);
          return matches.length === 1 ? <EditorialProductFigure key={image.src} image={image} href={matches[0].url} /> : null;
        })}
      </section>}
      <h2>לפרטים ולרכישה ב־TopTik</h2>
      <ul>{story.products.map((product) => <li key={product.url}><EditorialProductLink href={product.url}>{product.title}</EditorialProductLink></li>)}</ul>
      <h2>להמשך הקריאה</h2>
      <ul>
        <li><a href={story.store.url}>{story.store.title}</a></li>
        <li><Link href="/carousel">לגלריית TopTik</Link></li>
        <li><Link href="/journal/mandarina-md20-qmtx5-city-day">Mandarina Duck: יום בעיר</Link></li>
      </ul>
    </>,
  };
});
