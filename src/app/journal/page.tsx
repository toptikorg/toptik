import type { Metadata } from "next";
import Link from "next/link";
import styles from "@/components/editorial/Journal.module.css";
import { publishableGalleryArticles } from "@/lib/editorial/gallery-articles";
import { absoluteUrl, SITE_NAME } from "@/lib/seo/site";

export const metadata: Metadata = {
  title: "מגזין TopTik | מדריכי מוצרים והשוואות",
  description: "מדריכים והשוואות חזותיות המבוססים על מוצרים ונתוני יצרן בגלריית TopTik.",
  alternates: { canonical: "/journal" },
  openGraph: {
    type: "website",
    locale: "he_IL",
    siteName: SITE_NAME,
    title: "מגזין TopTik | מדריכי מוצרים והשוואות",
    description: "מדריכים והשוואות חזותיות המבוססים על מוצרים ונתוני יצרן בגלריית TopTik.",
    url: absoluteUrl("/journal"),
  },
};

export default function JournalArchivePage() {
  return (
    <main className={styles.archive} dir="rtl">
      <div className={styles.archiveInner}>
        <nav className={styles.topline} aria-label="ניווט ראשי">
          <Link href="/carousel">גלריית TopTik</Link>
          <span>מגזין</span>
        </nav>
        <header className={styles.archiveHero}>
          <p className={styles.eyebrow}>TOPTIK · EDITORIAL</p>
          <h1>מדריכים והשוואות</h1>
          <p>מבט קרוב על דגמים, מידות ופרטים שאפשר לבדוק בגלריה. הנתונים מבוססים על פרטי היצרן והמוצרים המוצגים אצלנו.</p>
        </header>
        <section className={styles.archiveGrid} aria-label="מאמרים במגזין">
          {publishableGalleryArticles.map((article) => (
            <article className={styles.archiveCard} key={article.slug}>
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
      </div>
    </main>
  );
}
