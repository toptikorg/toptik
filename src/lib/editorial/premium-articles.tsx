import type { GalleryArticle } from "./gallery-articles";
import stories from "./premium-stories.json";

export const premiumArticles: readonly GalleryArticle[] = stories.map((story) => ({
  slug: story.slug,
  category: "נסיעות פרימיום ולייף־סטייל",
  title: story.title,
  description: story.description,
  standfirst: story.standfirst,
  publishedAt: "2026-10-03",
  updatedAt: "2026-10-03",
  readingMinutes: 3,
  byline: "מערכת מגזין טופ תיק",
  sourceUrls: story.sourceUrls,
  hero: {
    src: `/images/journal/premium-20261003/${story.slug}.jpg`,
    alt: story.alt,
    width: 1536,
    height: 1024,
    href: "/carousel",
    caption: "תמונת אווירה שנוצרה בבינה מלאכותית; הדמויות, המקום והכבודה להמחשה. לצפייה בדגמים האמיתיים לחצו על הקישורים בהמשך.",
  },
  content: <>
    {story.sections.map((section) => <section key={section.heading}>
      <h2>{section.heading}</h2>
      {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </section>)}
    <h2>דגמים לעיון בטופ תיק</h2>
    <p>לבדיקת המידות, התמונות והמחיר העדכני בחנות:</p>
    <ul>{story.products.map((product) => <li key={product.url}><a href={product.url}>{product.title}</a></li>)}</ul>
    {story.sourceUrls.length > 0 && <p>תנאי זכאות, זמינות והטבות עשויים להשתנות; בדקו את התנאים העדכניים של הספק והמנפיק שלכם לפני הזמנה.</p>}
    <h2>להמשך הקריאה</h2>
    <p><a href={story.related.url}>{story.related.title}</a> במרכז המידע של החנות.</p>
  </>,
}));
