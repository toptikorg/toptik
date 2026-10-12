import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import styles from "@/components/editorial/Journal.module.css";
import { publishableGalleryArticles } from "@/lib/editorial/gallery-articles";
import { absoluteUrl, SITE_NAME } from "@/lib/seo/site";
import { jsonLdString } from "@/lib/seo/structured-data";
import { resolveArticleHero } from '@/lib/editorial/product-reference';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "מגזין TopTik | מסעות, סגנון ומבט מקרוב",
  description: "סיפורי לייפסטייל על נסיעות, מלונות וחופשות משפחתיות, לצד מדריכים והשוואות מהגלריה של TopTik.",
  alternates: { canonical: "/journal" },
  openGraph: {
    type: "website",
    locale: "he_IL",
    siteName: SITE_NAME,
    title: "מגזין TopTik | מסעות, סגנון ומבט מקרוב",
    description: "נסיעות, מלונות, זמן משפחתי וסגנון אישי — לצד מבט קרוב על מוצרי הגלריה.",
    url: absoluteUrl("/journal"),
  },
};

function archiveStructuredData() {
  const url = absoluteUrl("/journal");
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${url}#page`,
    url,
    name: "מגזין TopTik",
    inLanguage: "he",
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: absoluteUrl("/") },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: publishableGalleryArticles.map((article, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: absoluteUrl(`/journal/${article.slug}`),
        name: article.title,
      })),
    },
  };
}

export default async function JournalArchivePage() {
  const articles = await Promise.all(publishableGalleryArticles.map(async article => ({ ...article, hero: await resolveArticleHero(article.hero) })));
  return (
    <main className={styles.archive} dir="rtl">
      <div className={styles.archiveInner}>
        <nav className={styles.topline} aria-label="ניווט ראשי">
          <Link href="/carousel">גלריית TopTik</Link>
          <span>מגזין</span>
        </nav>
        <header className={styles.archiveHero}>
          <p className={styles.eyebrow}>TOPTIK · EDITORIAL</p>
          <h1>מסעות, סגנון ומבט מקרוב</h1>
          <p>רגעים בדרך, מקומות לעצור וסיפורים לקחת הביתה. לייפסטייל של נסיעות, לצד מדריכים והשוואות מהגלריה.</p>
        </header>
        <section className={styles.archiveGrid} aria-label="מאמרים במגזין">
          {articles.map((article) => (
            <article className={styles.archiveCard} key={article.slug}>
              {article.hero && <Link className={styles.archiveImageLink} href={`/journal/${article.slug}`} tabIndex={-1} aria-hidden="true">
                <Image className={styles.archiveImage} src={article.hero.src} alt="" width={article.hero.width} height={article.hero.height} sizes="(max-width: 680px) 90vw, 480px" quality={75} />
              </Link>}
              <p className={styles.cardCategory}>{article.category}</p>
              <h2><Link href={`/journal/${article.slug}`}>{article.title}</Link></h2>
              <p>{article.description}</p>
              <div className={styles.archiveCardFooter}>
                <span>{article.readingMinutes} דקות קריאה</span>
                <Link className={styles.cardLink} href={`/journal/${article.slug}`}>לקריאה <span aria-hidden="true">←</span></Link>
              </div>
            </article>
          ))}
        </section>
        <footer className={styles.articleFooter}>
          <Link className={styles.backLink} href="/carousel">חזרה לגלריה <span aria-hidden="true">←</span></Link>
        </footer>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(archiveStructuredData()) }} />
      </div>
    </main>
  );
}
