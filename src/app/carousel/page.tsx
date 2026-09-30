import type { Metadata } from "next";
import { redirect } from "next/navigation";
import CarouselPageClient from "./CarouselPageClient";
import { GalleryContentSections } from "@/components/carousel/GalleryContentSections";
import { isCarouselEnabled } from "@/lib/carousel/feature-flag";
import {
  CAROUSEL_DESCRIPTION,
  CAROUSEL_PATH,
  CAROUSEL_TITLE,
  SITE_NAME,
  absoluteUrl,
} from "@/lib/seo/site";
import { carouselStructuredData, jsonLdString } from "@/lib/seo/structured-data";

// Indexing directives are inherited from the root layout (noindex, follow) and
// from the X-Robots-Tag header; this module only adds descriptive metadata.
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdString(carouselStructuredData()) }}
      />
      <CarouselPageClient />
      <GalleryContentSections />
    </>
  );
}
