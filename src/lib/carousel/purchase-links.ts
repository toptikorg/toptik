import { normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";
import samsoniteVariantIds from "./samsonite-variants.json";
import previewPackage from "./american-tourister-preview.json";

// Per-SKU Shopify VARIANT IDs — from the owner's "Products_urls" sheet
// (2026-08-17). Keys are normalized catalog keys (letters+digits, uppercase,
// Mandarina "-TU" suffix dropped), so "BAH08451.001" and "P10SZV24-05J-TU"
// resolve regardless of dot/dash notation.
//
// The sheet's original "/checkout?quantity=1&id=…" links only worked on the
// first click — on later visits Shopify bounced them to the storefront
// homepage (where the site popup then traps the buyer). The documented stable
// form is the CART PERMALINK, /cart/<variantId>:<qty>, which adds the item and
// jumps straight into checkout, skipping the storefront entirely.
const VARIANT_IDS: Record<string, string> = {
  // Exact public Shopify variant identities verified on 2026-09-29.
  ...samsoniteVariantIds,
  P10SZV2405J: "42465754808570",
  P10JNV0508Q: "42466128494842",
  P10JNV05465: "42624928415994",
  BAH08451001: "50083958882554",
  BAH08453001: "50083958980858",
  BAH08453006: "50083959046394",
  BAH08453078: "50083959111930",
  BAH08454001: "50083959177466",
  BXL38124078: "50083959243002",
  BXL38124101: "50083959341306",
  BXL58117101: "50083959406842",
  BXL58145050: "50083959505146",
  BXL58145078: "50083959603450",
  BXL58145101: "50083959668986",
  ORI05500024: "50083959767290",
  ORI05500909: "50083959832826",
  P10GXV24A32: "50083959898362",
  P10OUN01A89: "50083959963898",
  P10OUV24A89: "50083959996666",
  P10SZV24A81: "50083960291578",
  P10SZV24A83: "50083960389882",
  P10UJN01A92: "50083960717562",
  P10UJV24A92: "50083960783098",
};

// Checkout URL for an item's catalog number, or null when no verified store
// listing is mapped. Callers must not display a purchase action in that case.
// Exact Shopify variant identities of the Preview-only package
// (preview-packages.ts). Kept apart from VARIANT_IDS: those products are only
// ever listed on a Preview deployment, so on Production these IDs are inert.
const PREVIEW_PACKAGE_VARIANT_IDS: Record<string, string> = Object.fromEntries(
  previewPackage.records.map((record) => [normalizeCatalogKey(record.sku).replace(/TU$/, ""), record.variantId]),
);

export function purchaseUrlFor(catalogNumber: string | null | undefined): string | null {
  if (!catalogNumber) return null;
  const key = normalizeCatalogKey(catalogNumber).replace(/TU$/, "");
  const variantId = Object.prototype.hasOwnProperty.call(VARIANT_IDS, key)
    ? VARIANT_IDS[key]
    : Object.prototype.hasOwnProperty.call(PREVIEW_PACKAGE_VARIANT_IDS, key)
      ? PREVIEW_PACKAGE_VARIANT_IDS[key]
      : undefined;
  return variantId ? `https://www.toptik.co.il/cart/${variantId}:1` : null;
}
