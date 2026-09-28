import type { CarouselItem } from "./types";

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
export const LEGACY_VARIANT_IDS: Readonly<Record<string, string>> = {
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

// Checkout URL only for a currently verified, purchasable public variant.
// Legacy IDs above are identity checks for the projection, never a fallback.
export function purchaseUrlFor(item: Pick<CarouselItem, "commerce">): string | null {
  const commerce = item.commerce;
  if (!commerce?.availableForSale || !/^\d+$/.test(commerce.variantId)) return null;
  // IDs enter commerce only after live Storefront identity verification.
  return `https://www.toptik.co.il/cart/${commerce.variantId}:1`;
}
