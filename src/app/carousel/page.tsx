import { redirect } from "next/navigation";
import CarouselPageClient from "./CarouselPageClient";
import { isCarouselEnabled } from "@/lib/carousel/feature-flag";
import { getPublicCatalog } from "@/lib/carousel/public-catalog";
import type { Metadata } from "next";
import { parseCategoryParam } from "@/lib/carousel/categories";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "אולם התצוגה של טופ תיק | מזוודות ותיקים מכל הזוויות",
  description: "גלו את המזוודות והתיקים של טופ תיק בתצוגה חזותית, בחלוקה לקטגוריות. צפו בזוויות המוצר ועברו לפרטים ולרכישה בחנות TopTik.",
  alternates: { canonical: "https://landing.toptik.co.il/carousel" },
  openGraph: { title: "אולם התצוגה של טופ תיק", description: "מזוודות ותיקים מכל הזוויות, עם מעבר ישיר לחנות טופ תיק.", url: "https://landing.toptik.co.il/carousel", locale: "he_IL", type: "website" },
};

export default async function CarouselPage({ searchParams }: { searchParams: Promise<{ category?: string | string[] }> }) {
  if (!isCarouselEnabled()) {
    redirect("/");
  }

  const initialPayload = await getPublicCatalog();
  const params = await searchParams;
  const initialCategory = parseCategoryParam(typeof params.category === "string" ? params.category : null);
  return <CarouselPageClient initialPayload={initialPayload} initialCategory={initialCategory} />;
}
