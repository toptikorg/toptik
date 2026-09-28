import { cache } from "react";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicCatalog } from "@/lib/carousel/public-catalog";
import { SHOWROOM_ORIGIN, showroomPath } from "@/lib/carousel/editorial";
import { editorialIdSchema } from "@/lib/carousel/editorial-schema";

export const dynamic = "force-dynamic";
const getItem = cache(async (id: string) => {
  if (!editorialIdSchema.safeParse(id).success) return null;
  const payload = await getPublicCatalog();
  return payload.items.find(item => item.id === id) ?? null;
});
type Props = { params: Promise<{ id: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const item = await getItem((await params).id);
  if (!item) return { title: "המוצר לא נמצא | טופ תיק", robots: { index: false } };
  const url = SHOWROOM_ORIGIN + showroomPath(item.id);
  return { title: item.editorial!.pageTitle, description: item.editorial!.metaDescription,
    alternates: { canonical: url }, robots: { index: item.editorial!.indexable, follow: true },
    openGraph: { title: item.editorial!.pageTitle, description: item.editorial!.metaDescription, url, type: "website", locale: "he_IL",
      images: item.coverImagePath ? [{ url: item.coverImagePath, alt: item.title }] : [] },
  };
}
export default async function ShowroomProduct({ params }: Props) {
  const item = await getItem((await params).id);
  if (!item) notFound();
  const url = SHOWROOM_ORIGIN + showroomPath(item.id);
  const images = [...new Set([item.coverImagePath, ...item.angles.map(a => a.imagePath)].filter(Boolean))];
  const data = { "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", "@id": url, url, name: item.editorial!.pageTitle,
      description: item.editorial!.metaDescription, inLanguage: "he-IL", mainEntity: { "@id": `${url}#product` },
      isPartOf: { "@type": "WebSite", name: "חלון הראווה של טופ תיק", url: SHOWROOM_ORIGIN + "/carousel" } },
    { "@type": "Product", "@id": `${url}#product`, name: item.title, description: item.description,
      sku: item.catalogNumber ?? item.id, productID: item.id, image: images,
      ...(item.commerce ? { brand: { "@type": "Brand", name: item.commerce.vendor }, sameAs: item.commerce.productUrl } : {}) },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "אולם התצוגה", item: SHOWROOM_ORIGIN + "/carousel" },
      { "@type": "ListItem", position: 2, name: item.title, item: url },
    ] },
  ] };
  return <main className="showroom-product-page" dir="rtl">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />
    <nav aria-label="ניווט מוצר"><Link href="/carousel">לכל המוצרים באולם התצוגה</Link><a href="https://www.toptik.co.il/">לחנות טופ תיק</a></nav>
    <article className="showroom-product-panel">
      <p className="showroom-eyebrow">TOPTIK · חלון הראווה של החנות</p>
      <h1>{item.title}</h1>
      <p>מק״ט: <bdi>{item.catalogNumber ?? item.id}</bdi></p>
      <div className="showroom-product-content">
        <div className="showroom-product-photos">{images.map((image, index) => <Image key={image} src={image} alt={`${item.title}, תמונת מוצר ${index + 1}`} width={960} height={960} unoptimized loading={index ? "lazy" : "eager"} />)}</div>
        <div><h2>מבט מקרוב על הדגם</h2><p className="showroom-product-copy">{item.description}</p>
          {item.editorial?.specs?.length ? <section aria-label="פרטי הדגם"><h2>פרטי הדגם</h2><dl className="showroom-product-specs">{item.editorial.specs.map(spec => <div key={spec.label}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>)}</dl></section> : null}
          <p>זהו עמוד ההיכרות החזותית עם המוצר. המחיר והזמינות העדכניים והשלמת הרכישה נמצאים בחנות טופ תיק.</p>
          {item.commerce?.productUrl ? <a className="catalog-card-buy-btn" href={item.commerce.productUrl}>למפרט ולרכישה בחנות</a> : <p>הדגם נשמר לתצוגה בגלריה ואינו מקושר כרגע לרכישה בחנות.</p>}
          <p className="showroom-identity">מזהה גלריה קבוע: <bdi>{item.id}</bdi></p>
        </div>
      </div>
    </article>
  </main>;
}
