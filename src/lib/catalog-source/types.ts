export interface SourceProduct {
  catalogNumber: string;
  title: string;
  description: string | null;
  imageUrls: string[];
  sourceUrl: string;
  color?: string | null;
  dimensions?: string | null;
  weight?: string | null;
  sizes?: string[];
  availableColors?: string[];
}

// One colour of a product, discovered by enumerating the sibling product pages
// that share the same 5-char model token (every colour is its own MD product).
export interface SourceColorVariant {
  // Bric's: the maker's complete colour value ("Black", "Racing Yellow").
  // Mandarina: a colour word found in the page title — kept for de-duplication
  // only; it never becomes a Hebrew name (./carousel/color-names rules).
  colorWord: string | null;
  colorCode: string | null;   // global MD colour code — middle catalog segment (e.g. "465")
  title: string;
  catalogNumber: string | null;
  sourceUrl: string;
  handle: string;
  coverImageUrl: string;      // representative (first) image on that colour's product page
  imageUrls: string[];        // full gallery for this colour — its rotation angles
}

export interface CatalogSourceProvider {
  fetchByCatalogNumber(catalogNumber: string): Promise<SourceProduct>;
}
