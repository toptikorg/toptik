import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import CarouselPageClient from "./CarouselPageClient";
import { GalleryContentSections } from "@/components/carousel/GalleryContentSections";
import { CarouselStoreIndex } from "@/components/carousel/CarouselStoreIndex";
import { Suspense } from "react";
import { isCarouselEnabled } from "@/lib/carousel/feature-flag";
import {
  CAROUSEL_DESCRIPTION,
  CAROUSEL_PATH,
  CAROUSEL_TITLE,
  SITE_NAME,
  absoluteUrl,
} from "@/lib/seo/site";
import { carouselStructuredData, jsonLdString } from "@/lib/seo/structured-data";

// The server-rendered store index below reads the live catalog; refresh it
// every five minutes so the crawlable list follows catalog changes.
export const revalidate = 300;

// Public indexing directives are inherited from the root layout. Admin and API
// paths receive separate noindex headers in next.config.ts.
export const metadata: Metadata = {
  title: CAROUSEL_TITLE,
  description: CAROUSEL_DESCRIPTION,
  alternates: { canonical: CAROUSEL_PATH },
  openGraph: {
    type: "website",
    locale: "he_IL",
    siteName: SITE_NAME,
    title: CAROUSEL_TITLE,
    description: CAROUSEL_DESCRIPTION,
    url: absoluteUrl(CAROUSEL_PATH),
  },
  twitter: {
    card: "summary",
    title: CAROUSEL_TITLE,
    description: CAROUSEL_DESCRIPTION,
  },
};

export default function CarouselPage() {
  if (!isCarouselEnabled()) {
    redirect("/");
  }

  return (
    <>
      <link rel="preload" href="/api/carousel" as="fetch" crossOrigin="anonymous" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdString(carouselStructuredData()) }}
      />
      <CarouselPageClient />
      <GalleryContentSections />
      <section aria-label="סרטוני TopTik" dir="rtl" style={{ textAlign: "center", padding: "28px 18px", background: "#f5f2ed", color: "#252220" }}>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: 8 }}>מכירים מקרוב בסרטונים</h2>
        <p style={{ marginBottom: 12 }}>מזוודות ותיקים, טיפים לבחירה וקישורים לרכישה.</p>
        <Link href="/videos" style={{ display: "inline-block", padding: "12px 20px", background: "#1d2626", color: "#fff", fontWeight: 700 }}>לגלריית הסרטונים</Link>
      </section>
      <Suspense fallback={null}>
        <CarouselStoreIndex />
      </Suspense>
      <footer className="carousel-footer-links" aria-label="קישורי שירות בגלריה" dir="rtl">
        <Link href="/accessibility">הצהרת נגישות</Link>
        <Link className="carousel-footer-home" href="https://www.toptik.co.il/">חזרה לחנות</Link>
        <nav className="carousel-social-links" aria-label="עקבו אחרינו">
          <span>עקבו אחרינו</span>
          <a href="https://www.facebook.com/TopTik.il/">פייסבוק</a>
          <a href="https://www.instagram.com/toptikltd/">אינסטגרם</a>
          <a href="https://www.youtube.com/user/MandarinaDuck09">יוטיוב</a>
        </nav>
      </footer>
    </>
  );
}
