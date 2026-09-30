import type { CatalogVendor } from "@/lib/catalog-source/provider";

// Client-safe, pure helpers — imported by the admin UI as well as server code.

// Canonical comparison key for catalog numbers: letters+digits only, uppercase.
// "P10SZV24-05J-TU", "P10SZV2405J" and "p10 szv24 05j" all collapse to the
// same key prefix, so duplicate checks survive any separator style.
export function normalizeCatalogKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Identify the vendor from the catalog number itself, so imports route
// correctly no matter which admin section (or Excel file) they came from.
// Mandarina Duck catalogs start with P + 2 digits (P10QMC01-465-TU),
// Samsonite manufacturer SKUs use six model digits plus a four-character
// colour suffix (150700-9199), and Bric's SKUs start with letter groups.
export function detectVendorFromCatalog(
  catalogNumber: string,
  fallback: CatalogVendor = "brics",
): CatalogVendor {
  const token = normalizeCatalogKey(catalogNumber);
  if (/^P\d{2}/.test(token)) return "mandarina";
  if (/^\d{10}$/.test(token)) return "samsonite";
  if (/^(?:BXL|BAH|BBG|BOE|ORI)/.test(token)) return "brics";
  return fallback;
}
