import type { Metadata } from "next";
import { redirect } from "next/navigation";
import CarouselPageClient from "./CarouselPageClient";
import { isCarouselEnabled } from "@/lib/carousel/feature-flag";

// GAL-028: owner-approved share and search copy for the showroom. URLs resolve
// against metadataBase (https://landing.toptik.co.il). The share image shows the
// TopTik logo and real gallery products (provenance: docs/OG-SHARE-IMAGE.md).
// The noindex, follow hold stays in force.
export const metadata: Metadata = {
  title: { absolute: "אולם התצוגה של TopTik | מזוודות, טרולי ותיקי נסיעות" },
  description:
    "ברוכים הבאים לאולם התצוגה של TopTik. הגדילו תמונות, עברו בין זוויות והכירו מזוודות, טרולי ותיקי נסיעות לפני שתמשיכו לרכישה באתר TopTik.",
  alternates: { canonical: "/carousel" },
  robots: { index: false, follow: true },
  openGraph: {
    type: "website",
    locale: "he_IL",
    siteName: "TopTik",
    url: "/carousel",
    title: "ברוכים הבאים לאולם התצוגה של TopTik",
    description:
      "הגדילו תמונות, עברו בין זוויות והכירו מזוודות, טרולי ותיקי נסיעות לפני שתמשיכו לרכישה באתר TopTik.",
    images: [
      {
        url: "/og/toptik-showroom-1200x630.jpg",
        width: 1200,
        height: 630,
        type: "image/jpeg",
        alt: "הלוגו של TopTik ומזוודות וטרולי מתוך אולם התצוגה",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ברוכים הבאים לאולם התצוגה של TopTik",
    description:
      "הגדילו תמונות, עברו בין זוויות והכירו מזוודות, טרולי ותיקי נסיעות לפני שתמשיכו לרכישה באתר TopTik.",
    images: [
      {
        url: "/og/toptik-showroom-1200x630.jpg",
        alt: "הלוגו של TopTik ומזוודות וטרולי מתוך אולם התצוגה",
      },
    ],
  },
};

export default function CarouselPage() {
  if (!isCarouselEnabled()) {
    redirect("/");
  }

  return <CarouselPageClient />;
}
