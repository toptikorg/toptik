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
  seoTitle?: string | null;
  seoDescription?: string | null;
  copyUpdatedAt?: string | null;
  catalogNumber?: string | null;
  /** Live Shopify navigation binding, hydrated from the narrow public link projection. */
  shopifyLink?: { handle: string; variantId: string; isPublished: boolean } | null;
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
}

export interface CarouselSettings {
  autoplayMs: number;
  transitionMode: TransitionMode;
}

export interface CarouselPayload {
  items: CarouselItem[];
  settings: CarouselSettings;
}

export interface AdminItemInput {
  id?: string;
  title: string;
  description?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  copyUpdatedAt?: string | null;
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
