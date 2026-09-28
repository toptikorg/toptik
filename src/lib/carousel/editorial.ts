import curated from "./editorial-curated.json";
import samsonite from "./editorial-samsonite.json";
import other from "./editorial-other.json";
import identities from "./editorial-identities.json";
import type { CarouselPayload } from "./types";
import { editorialSchema, type ProductEditorial } from "./editorial-schema";
import { catalogIdentity } from "./storefront-projection";

export const SHOWROOM_ORIGIN = "https://landing.toptik.co.il";
export const editorialSeeds: Record<string, ProductEditorial> = Object.fromEntries(
  Object.entries({ ...curated, ...samsonite, ...other }).map(([id, value]) => [id, editorialSchema.parse({ ...value, expectedSku: (identities as Record<string, string>)[id] })]),
);
export function showroomPath(id: string) { return `/carousel/products/${encodeURIComponent(id)}`; }

export function applyEditorial(payload: CarouselPayload, overrides: Record<string, ProductEditorial> = {}): CarouselPayload {
  return { ...payload, items: payload.items.map(item => {
    const candidate = overrides[item.id] ?? editorialSeeds[item.id];
    const currentSku = catalogIdentity(item.catalogNumber);
    // A reused Shopify variant ID must never inherit another model's prose.
    const copy = candidate?.expectedSku === currentSku ? candidate : undefined;
    // Future imports are visible but noindex until professionally reviewed.
    const fallback: ProductEditorial = {
      expectedSku: currentSku,
      title: item.title,
      description: "מבט מקרוב על הדגם באולם התצוגה של טופ תיק. אפשר להתרשם מהתמונות ומזוויות המוצר, ולבדוק את המפרט ואת אפשרויות הרכישה בחנות. התיאור המורחב נמצא בעריכה.",
      pageTitle: `${item.title} | חלון הראווה של טופ תיק`.slice(0, 120),
      metaDescription: `היכרות חזותית עם ${item.title}. תמונות המוצר בחלון הראווה של טופ תיק, עם מעבר לחנות לפרטים ולרכישה.`.slice(0, 200),
      indexable: false, sourceUrls: [],
    };
    const editorial = copy ?? fallback;
    const reviewedSpecs = editorial.specs ?? [
      ...(item.commerce?.vendor ? [{ label: "מותג", value: item.commerce.vendor }] : []),
      ...(item.catalogNumber ? [{ label: "מק״ט", value: item.catalogNumber }] : []),
    ];
    return { ...item, title: editorial.title, description: editorial.description, editorial,
      // Legacy translated specs stay in the private editing/source record.
      // Public specifications must come from the reviewed fact set.
      techSpecs: { ...item.techSpecs, colors: item.techSpecs?.colors ?? [], specs: [{ heading: "פרטי הדגם", items: reviewedSpecs }] },
      showroomUrl: showroomPath(item.id) };
  }) };
}
