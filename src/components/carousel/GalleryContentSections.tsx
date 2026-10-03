import Link from "next/link";
import styles from "@/components/editorial/Journal.module.css";

// Keep the collection page focused on browsing products. Full editorial pieces
// live at crawlable, independently addressable URLs in the Gallery journal.
const features = [
  {
    slug: "samsonite-carry-on-55-sku-dimensions",
    category: "מידות לפי מק״ט",
    title: "מידות טרולי Samsonite בגודל 55 ס״מ",
    summary: "טבלת יצרן לפי דגם וגרסה, כולל Easy Access ומידות בהרחבה.",
  },
  {
    slug: "samsonite-intuo-55-vs-easy-access",
    category: "השוואה חזותית",
    title: "Intuo 55 מול Easy Access",
    summary: "ההבדלים בעומק ובנפח, לצד תמונות של שתי הגרסאות.",
  },
];

export function GalleryContentSections() {
  return (
    <section className={styles.collectionTeasers} aria-labelledby="gallery-journal-heading" dir="rtl">
      <div className={styles.collectionTeasersHeader}>
        <div>
          <p className={styles.eyebrow}><Link href="/journal" className={styles.magazineHomeLink}>TopTik · מגזין</Link></p>
          <h2 id="gallery-journal-heading">לראות את ההבדלים מקרוב</h2>
        </div>
        <Link className={styles.textLink} href="/journal">לכל הכתבות במגזין <span aria-hidden="true">←</span></Link>
      </div>
      <div className={styles.teaserGrid}>
        {features.map((article) => (
          <article className={styles.teaserCard} key={article.slug}>
            <p className={styles.cardCategory}>{article.category}</p>
            <h3><Link href={`/journal/${article.slug}`}>{article.title}</Link></h3>
            <p>{article.summary}</p>
            <Link className={styles.cardLink} href={`/journal/${article.slug}`}>לקריאה <span aria-hidden="true">←</span></Link>
          </article>
        ))}
      </div>
    </section>
  );
}
