import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import styles from "@/components/editorial/Journal.module.css";
import { getGalleryArticle, getRelatedGalleryArticles, publishableGalleryArticles } from "@/lib/editorial/gallery-articles";
import { absoluteUrl, SITE_NAME, STORE_ORIGIN } from "@/lib/seo/site";
import { getStoreGuides } from "@/lib/editorial/store-guides";
import { getStoreCategoryLinks } from "@/lib/editorial/store-categories";
import { jsonLdString } from "@/lib/seo/structured-data";
import { resolveArticleHero } from '@/lib/editorial/product-reference';
import { MobileStoreBar } from '@/components/commerce/MobileStoreBar';

export const dynamicParams = false;
// Article copy is authored in source, while embedded products are resolved
// from the current active gallery catalog at request time.
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return publishableGalleryArticles.map(({ slug }) => ({ slug }));
}

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = getGalleryArticle(slug);
  if (!article) return { title: "המאמר לא נמצא" };
  const hero = await resolveArticleHero(article.hero);

  return {
    title: article.title,
    description: article.description,
    alternates: { canonical: `/journal/${article.slug}` },
    openGraph: {
      type: "article",
      locale: "he_IL",
      siteName: SITE_NAME,
      title: article.title,
      description: article.description,
      url: absoluteUrl(`/journal/${article.slug}`),
      publishedTime: `${article.publishedAt}T00:00:00+03:00`,
      modifiedTime: `${article.updatedAt}T00:00:00+03:00`,
      ...(hero ? { images: [{ url: absoluteUrl(hero.src), width: hero.width, height: hero.height, alt: hero.alt }] } : {}),
    },
  };
}

function articleStructuredData(article: NonNullable<ReturnType<typeof getGalleryArticle>>) {
  const url = absoluteUrl(`/journal/${article.slug}`);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        headline: article.title,
        description: article.description,
        inLanguage: "he",
        datePublished: article.publishedAt,
        dateModified: article.updatedAt,
        articleSection: article.category,
        ...(article.hero ? { image: absoluteUrl(article.hero.src) } : {}),
        mainEntityOfPage: { "@type": "WebPage", "@id": url },
        author: { "@type": "Organization", name: article.byline },
        publisher: { "@type": "Organization", name: SITE_NAME, url: `${STORE_ORIGIN}/` },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: `גלריית ${SITE_NAME}`, item: absoluteUrl("/") },
          { "@type": "ListItem", position: 2, name: "גלריה", item: absoluteUrl("/carousel") },
          { "@type": "ListItem", position: 3, name: "מגזין", item: absoluteUrl("/journal") },
          { "@type": "ListItem", position: 4, name: article.title, item: url },
        ],
      },
    ],
  };
}

export default async function JournalArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const authored = getGalleryArticle(slug);
  if (!authored) notFound();
  const article = { ...authored, hero: await resolveArticleHero(authored.hero) };
  const storeGuides = getStoreGuides(article.slug);
  const storeCategories = getStoreCategoryLinks(article);
  const related = getRelatedGalleryArticles(article.slug);

  return (
    <main className={styles.article} dir="rtl" data-mobile-store-page="article">
      <MobileStoreBar page="article" />
      <article className={styles.articleInner}>
        <nav className={styles.breadcrumb} aria-label="פירורי לחם">
          <Link href="/">TopTik</Link><span aria-hidden="true">/</span>
          <Link href="/carousel">גלריה</Link><span aria-hidden="true">/</span>
          <Link href="/journal">מגזין</Link><span aria-hidden="true">/</span>
          <span aria-current="page">{article.title}</span>
        </nav>
        <header className={styles.articleHeader}>
          <p className={styles.eyebrow}>{article.category}</p>
          <h1>{article.title}</h1>
          <div className={styles.mobileStoreIntro} data-mobile-store-intro="" />
          <p className={styles.articleStandfirst}>{article.standfirst}</p>
          <div className={styles.articleMeta}>
            <span>{article.byline}</span>
            <time dateTime={article.updatedAt}>עודכן ב־{new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${article.updatedAt}T12:00:00Z`))}</time>
            <span>{article.readingMinutes} דקות קריאה</span>
          </div>
          <div className={styles.articleRule} aria-hidden="true" />
        </header>
        {article.hero && <figure className={styles.heroFigure}>
          {article.hero.href ? <Link href={article.hero.href} data-mobile-store-link={article.hero.href.startsWith("https://www.toptik.co.il/products/") ? '' : undefined} data-product-name={article.hero.alt} aria-label={article.hero.href.startsWith("https://www.toptik.co.il/products/") ? "לפרטי המוצר בחנות" : "לצפייה במוצרים בגלריה"}>
            {article.hero.href.startsWith("https://www.toptik.co.il/products/") && <span className={styles.mobileProductLink}>לפרטי המוצר בחנות ←</span>}
            <Image src={article.hero.src} alt={article.hero.alt} width={article.hero.width} height={article.hero.height} sizes="(max-width: 780px) 94vw, 740px" quality={75} unoptimized />
          </Link> : <Image src={article.hero.src} alt={article.hero.alt} width={article.hero.width} height={article.hero.height} sizes="(max-width: 780px) 94vw, 740px" quality={75} unoptimized />}
          <figcaption>{article.hero.caption}</figcaption>
        </figure>}
        <div className={styles.articleBody}>{article.content}</div>
        <section className={styles.storeGuides} aria-labelledby="store-categories-heading" data-store-categories="">
          <h2 id="store-categories-heading">בחנות TopTik</h2>
          <p>הדגמים מהמאמר ודגמים נוספים, עם מחיר, מלאי ומשלוח חינם לכל הארץ:</p>
          <ul>
            {storeCategories.map((link) => (
              <li key={link.href}><a href={link.href}>{link.title}</a></li>
            ))}
          </ul>
        </section>
        {storeGuides.length > 0 && (
          <section className={styles.storeGuides} aria-labelledby="store-guides-heading">
            <h2 id="store-guides-heading">מדריכי קנייה בחנות TopTik</h2>
            <p>המשך קריאה בחנות, שם מופיעים גם המחיר, המלאי והרכישה:</p>
            <ul>
              {storeGuides.map((guide) => (
                <li key={guide.slug}><a href={guide.href}>{guide.title}</a></li>
              ))}
            </ul>
          </section>
        )}
        {related.length > 0 && (
          <section className={styles.storeGuides} aria-labelledby="related-articles-heading">
            <h2 id="related-articles-heading">עוד במגזין</h2>
            <ul>
              {related.map((item) => (
                <li key={item.slug}><Link href={`/journal/${item.slug}`}>{item.title}</Link></li>
              ))}
            </ul>
          </section>
        )}
        <footer className={styles.articleFooter}>
          <Link className={styles.backLink} href="/carousel">חזרה לגלריה <span aria-hidden="true">←</span></Link>
          <span aria-hidden="true"> · </span>
          <Link className={styles.backLink} href="/journal">לכל המאמרים</Link>
        </footer>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(articleStructuredData(article)) }} />
      </article>
    </main>
  );
}
