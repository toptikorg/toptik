export type TransitionMode = "shatter-particle" | "curtain-fade";

export interface CarouselAngle {
  id: string;
  itemId: string;
  angleKey: string;
  imagePath: string;
  angleOrder: number;
}

export interface CachedTechSpecs {
  specs: Array<{ heading: string; items: Array<{ label: string; value: string }> }>;
  colors: Array<{ name: string; hex: string | null; swatchUrl: string | null }>;
  // Catalog category ("suitcase" | "carryon") set in the admin. Stored here so
  // it round-trips in the tech_specs JSON without a dedicated DB column.
  category?: string | null;
}

// One selectable colour of a product, scraped from Mandarina Duck's sibling
// colour products. `imagePath` is a Supabase-hosted cover image for that colour;
// `angles` is that colour's full re-hosted gallery so the product can be rotated
// while the colour stays selected (clicking the swatch swaps the whole gallery).
export interface CarouselColor {
  name: string;               // Hebrew display name
  hex: string | null;         // swatch fill
  colorCode: string | null;   // global MD colour code (e.g. "465")
  imagePath: string;          // Supabase-hosted cover image in this colour (= angles[0])
  angles?: string[];          // Supabase-hosted gallery for this colour (rotation)
  sourceUrl: string | null;   // that colour's MD product page
  catalogNumber: string | null;
}

export interface CarouselItem {
  id: string;
  title: string;
  description: string | null;
  catalogNumber?: string | null;
  sourceUrl?: string | null;
  coverImagePath: string;
  displayOrder: number;
  isActive: boolean;
  color?: string | null;
  dimensions?: string | null;
  weight?: string | null;
  sizes?: string[] | null;
  availableColors?: string[] | null;
  angles: CarouselAngle[];
  techSpecs?: CachedTechSpecs | null;
  colors?: CarouselColor[] | null;
  // Public read-through projection only. Never submitted to the legacy editor.
  commerce?: CarouselCommerce | null;
  editorial?: import("./editorial-schema").ProductEditorial;
  showroomUrl?: string;
}

export interface CarouselCollection {
  id: string;
  handle: string;
  title: string;
}

export interface CarouselCommerce {
  productId: string;
  variantId: string;
  productUrl: string;
  availableForSale: boolean;
  price: string;
  currency: string;
  vendor: string;
  collectionIds: string[];
  checkedAt: string;
}

export interface CarouselSettings {
  autoplayMs: number;
  transitionMode: TransitionMode;
}

export interface CarouselPayload {
  items: CarouselItem[];
  settings: CarouselSettings;
  collections?: CarouselCollection[];
  sync?: {
    status: "current" | "unavailable";
    checkedAt: string | null;
    productCount: number;
    variantCount: number;
    matchedCount: number;
    addedCount: number;
  };
}

export interface AdminItemInput {
  id?: string;
  title: string;
  description?: string | null;
  catalogNumber?: string | null;
  sourceUrl?: string | null;
  displayOrder: number;
  isActive: boolean;
  coverImagePath: string;
  angles: Array<{
    id?: string;
    angleKey: string;
    angleOrder: number;
    imagePath: string;
  }>;
}
