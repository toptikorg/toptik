import type { CarouselItem } from "./types";

export type BrandKey = string;
export interface GalleryBrand { key: BrandKey; label: string }

// Public collection selection approved by the owner on 2026-09-29.
// This is a presentation policy, not a deletion or a brand-identity rewrite.
const PUBLIC_BRAND_KEYS = new Set(["mandarina-duck", "brics", "samsonite", "american-tourister"]);

const NAMED_BRANDS: Record<string, GalleryBrand> = {
  "american tourister": { key: "american-tourister", label: "American Tourister" },
  "mandarina duck": { key: "mandarina-duck", label: "Mandarina Duck" },
  "מנדרינה דאק": { key: "mandarina-duck", label: "Mandarina Duck" },
  "bric's": { key: "brics", label: "Bric's" },
  brics: { key: "brics", label: "Bric's" },
  "בריקס": { key: "brics", label: "Bric's" },
  "porsche design": { key: "porsche-design", label: "Porsche Design" },
  "פורשה דיזיין": { key: "porsche-design", label: "Porsche Design" },
  samsonite: { key: "samsonite", label: "Samsonite" },
  "סמסונייט": { key: "samsonite", label: "Samsonite" },
};

// Exact SKU identity from reviewed-copy.json. Do not infer a brand from a title,
// SKU prefix, image filename or the previous Mandarina-only heading.
const REVIEWED_BRAND_BY_SKU: Record<string, string> = {
  // Exact Shopify-owned MD20 color projections. Their typed specs omit the
  // brand label, so public filtering still needs verified identity evidence.
  P10QMMM1651: "Mandarina Duck",
  P10QMMM1465: "Mandarina Duck",
  P10QMMM109K: "Mandarina Duck",
  P10JNV05465: "Mandarina Duck",
  P10GXV24A32: "Mandarina Duck",
  P10JNV0508Q: "Mandarina Duck",
  BXL38124078: "Bric's",
  "BAH08453.001": "Bric's",
  "BAH08453.006": "Bric's",
  "BAH08451.001": "Bric's",
  "BAH08454.001": "Bric's",
  "BAH08453.078": "Bric's",
  "BXL58117.101": "Bric's",
  BXL38124101: "Bric's",
  "BXL58145.101": "Bric's",
  "BXL58145.050": "Bric's",
  "BXL58145.078": "Bric's",
  "P10SZV24-05J-TU": "Mandarina Duck",
  "P10SZV24-A83-TU": "Mandarina Duck",
  "P10UJV24-A92-TU": "Mandarina Duck",
  "P10SZV24-A81-TU": "Mandarina Duck",
  "P10OUV24-A89-TU": "Mandarina Duck",
  "P10OUN01-A89-TU": "Mandarina Duck",
  "P10UJN01-A92-TU": "Mandarina Duck",
  "ORI05500.909": "Porsche Design",
  "ORI05500.024": "Porsche Design",
  "P10OSV04-05J-TU": "Mandarina Duck",
  "P10ZJT06-24U-TU": "Mandarina Duck",
};

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ");
}

function brandFromName(value: string): GalleryBrand | null {
  const label = normalized(value);
  if (!label) return null;
  const key = label.toLowerCase();
  return Object.hasOwn(NAMED_BRANDS, key)
    ? NAMED_BRANDS[key]
    : { key: `brand:${key}`, label };
}

export function brandForItem(item: CarouselItem): GalleryBrand | null {
  const explicit = (item.techSpecs?.specs ?? []).flatMap(section => section.items)
    .filter(spec => ["מותג", "brand"].includes(normalized(spec.label).replace(/:$/, "").trim().toLowerCase()))
    .map(spec => brandFromName(spec.value))
    .filter((brand): brand is GalleryBrand => brand !== null);
  if (explicit.length > 0) {
    const unique = new Map(explicit.map(brand => [brand.key, brand]));
    // Conflicting explicit values must not silently fall back to an old SKU map.
    return unique.size === 1 ? [...unique.values()][0] : null;
  }
  const sku = item.catalogNumber?.trim().toUpperCase();
  return sku && Object.hasOwn(REVIEWED_BRAND_BY_SKU, sku)
    ? brandFromName(REVIEWED_BRAND_BY_SKU[sku]) : null;
}

export function availableBrands(items: CarouselItem[]): GalleryBrand[] {
  const brands = new Map<BrandKey, GalleryBrand>();
  for (const item of items) {
    if (!item.isActive) continue;
    const brand = brandForItem(item);
    if (brand && PUBLIC_BRAND_KEYS.has(brand.key) && !brands.has(brand.key)) brands.set(brand.key, brand);
  }
  return [...brands.values()];
}

export function publicCollectionItems(items: CarouselItem[]): CarouselItem[] {
  return items.filter(item => {
    const brand = brandForItem(item);
    return item.isActive && brand !== null && PUBLIC_BRAND_KEYS.has(brand.key);
  });
}

export function defaultBrand(brands: GalleryBrand[]): BrandKey {
  return brands.some(brand => brand.key === "mandarina-duck") ? "mandarina-duck" : "all";
}

export function parseBrandParam(raw: string | null | undefined, brands: GalleryBrand[]): BrandKey {
  const key = raw?.trim().toLowerCase();
  if (key === "all") return "all";
  return brands.find(brand => brand.key.toLowerCase() === key)?.key ?? defaultBrand(brands);
}

export function filterByBrand(items: CarouselItem[], brand: BrandKey): CarouselItem[] {
  return brand === "all" ? items : items.filter(item => brandForItem(item)?.key === brand);
}

export function urlWithBrand(href: string, brand: BrandKey): string {
  const url = new URL(href);
  // Keep explicit "all": an absent parameter intentionally defaults to Mandarina.
  url.searchParams.set("brand", brand);
  return url.toString();
}
