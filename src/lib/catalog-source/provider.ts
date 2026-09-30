import { CatalogSourceProvider } from "@/lib/catalog-source/types";
import { MandarinaDuckScraperProvider } from "@/lib/catalog-source/mandarina-scraper";
import { BricsStoreScraperProvider } from "@/lib/catalog-source/brics-scraper";
import { SamsoniteScraperProvider } from "@/lib/catalog-source/samsonite-scraper";

export type CatalogVendor = "mandarina" | "brics" | "samsonite";

export const CATALOG_VENDORS: CatalogVendor[] = ["mandarina", "brics", "samsonite"];

export function isCatalogVendor(value: string): value is CatalogVendor {
  return (CATALOG_VENDORS as string[]).includes(value);
}

export function createCatalogSourceProvider(
  vendor: CatalogVendor = "mandarina",
): CatalogSourceProvider {
  switch (vendor) {
    case "brics":
      return new BricsStoreScraperProvider();
    case "samsonite":
      return new SamsoniteScraperProvider();
    case "mandarina":
    default:
      return new MandarinaDuckScraperProvider();
  }
}
