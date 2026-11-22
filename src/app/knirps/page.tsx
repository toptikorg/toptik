import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import products from "@/lib/editorial/knirps-products.json";
import stories from "@/lib/editorial/knirps-stories.json";
import styles from "@/components/editorial/Journal.module.css";
import local from "./page.module.css";

export const metadata: Metadata = {
  title: "מטריות Knirps: דגמים, מנגנוני פתיחה וצבעים | TopTik",
  description: "מטריות קנירפס מתקפלות, השוואת פתיחה ידנית ו־Duomatic, תמונות פתוחות וסגורות ומדריכים לבחירה ולטיפול. לפרטים ולרכישה בחנות טופ תיק.",
  alternates: { canonical: "/knirps" },
  robots: { index: true, follow: true },
};

export default function KnirpsPage() {
  return <main className={styles.archive} dir="rtl"><div className={styles.archiveInner}>
    <nav className={styles.topline} aria-label="ניווט ראשי">
      <Link href="/carousel">גלריית TopTik</Link>
      <Link href="/journal">המגזין</Link>
      <a href="https://www.toptik.co.il/">לחנות TopTik</a>
    </nav>
    <header className={styles.archiveHero}>
      <p className={styles.eyebrow}>KNIRPS</p>
      <h1>מטריות Knirps ליום בעיר</h1>
      <p>לדרך לעבודה, ליום בעיר ולתיק שמלווה אותך. כאן אפשר להשוות מנגנוני פתיחה, לראות את המטרייה פתוחה וסגורה ולבחור דגם וצבע. המחיר, המפרט והזמינות העדכניים מופיעים בחנות.</p>
    </header>
    <section aria-labelledby="knirps-video"><h2 id="knirps-video" className={local.heading}>מטרייה ליום גשום בעיר</h2><p>צפו במטריית Knirps US.050 האדומה ובתמונות שלה פתוחה וסגורה.</p><Link href="/videos/knirps-umbrella-in-the-city" className={styles.cardLink}>לצפייה בסרטון ולפרטי המטרייה</Link></section>
    <section aria-labelledby="knirps-guides">
      <h2 id="knirps-guides" className={local.heading}>לפני שבוחרים מטרייה</h2>
      <div className={styles.archiveGrid}>{stories.map(story => <article className={styles.archiveCard} key={story.slug}>
        <h2><Link href={`/journal/${story.slug}`}>{story.title}</Link></h2>
        <p>{story.description}</p>
        <Link className={styles.cardLink} href={`/journal/${story.slug}`}>למדריך המלא</Link>
      </article>)}</div>
    </section>
    <section aria-labelledby="knirps-products"><h2 id="knirps-products" className={local.heading}>דגמים וצבעים בחנות טופ תיק</h2>
      <div className={styles.archiveGrid}>{products.map(product => <article className={styles.archiveCard} key={product.sku}>
        <div className={local.images}>{product.images.map(image => <a href={product.purchaseUrl} key={image.src}><Image src={image.src} alt={image.alt} width={750} height={750} sizes="(max-width: 767px) 40vw, 230px" className={local.productImage} /></a>)}</div>
        <h2><a href={product.purchaseUrl}>{product.title}</a></h2>
        <p>למפרט, למחיר העדכני ולרכישה בחנות:</p>
        <a href={product.purchaseUrl} className={styles.cardLink}>לבחירת המטרייה</a>
      </article>)}</div>
    </section>
  </div></main>;
}
