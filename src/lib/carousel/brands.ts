import type { CarouselItem } from "./types";

export type BrandKey = string;
export interface GalleryBrand { key: BrandKey; label: string }

// Legacy approved brands remain visible as before. Tal's 2026-11-09 request
// also includes other brands when their exact shop listing is published.
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
  // Exact published Shopify variant/vendor and manufacturer source URLs
  // rechecked 2026-10-07. These rows have no typed brand specification.
  BAH08450001: "Bric's",
  BAH08450006: "Bric's",
  BAH08451006: "Bric's",
  BAH08454006: "Bric's",
  BAH08454078: "Bric's",
  BXL43756101: "Bric's",
  P10FZT8208Q: "Mandarina Duck",
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

// Exact active Shopify product/variant/handle and vendor evidence captured
// 2026-11-09. This restores missing brand identity only for the same published
// binding. Do not infer future products or revive a withdrawn variant.
export const VERIFIED_STORE_BRAND_BINDINGS_20261109: Record<string, { handle: string; variantId: string; name: string }> = {
  "P10OSN0105J": { handle: "p10osn0105j", variantId: "67616503202042", name: "צהוב" },
  "P10OSN0205J": { handle: "p10osn0205j", variantId: "67616503759098", name: "צהוב" },
  "P10TKTV8001": { handle: "p10tktv8001", variantId: "67616507822330", name: "שחור" },
  "P10QMMM301V": { handle: "p10qmmm301v", variantId: "67616509526266", name: "מנטה" },
  "P10QMMM3B10": { handle: "p10qmmm3b10", variantId: "67616510542074", name: "Cosmic" },
  "P10QMMO1B10": { handle: "p10qmmo1b10", variantId: "67616511394042", name: "Cosmic" },
  "P10QMT2809K": { handle: "p10qmt2809k", variantId: "67616513065210", name: "טאופ" },
  "P10QMT28651": { handle: "p10qmt28651", variantId: "67616513261818", name: "שחור" },
  "P10QMT3901V": { handle: "p10qmt3901v", variantId: "67616514310394", name: "מנטה" },
  "P10QMT3909K": { handle: "p10qmt3909k", variantId: "67616514736378", name: "טאופ" },
  "P10QMT39465": { handle: "p10qmt39465", variantId: "67616515129594", name: "אפור פלדה" },
  "P10QMT39B06": { handle: "p10qmt39b06", variantId: "67616515784954", name: "ענבר" },
  "P10QMT49651": { handle: "p10qmt49651", variantId: "67616516309242", name: "שחור" },
  "P10QMT58465": { handle: "p10qmt58465", variantId: "67616517030138", name: "אפור פלדה" },
  "P10QMT71B09": { handle: "p10qmt71b09", variantId: "67616586793210", name: "Cocoon" },
  "P10QMTT101V": { handle: "p10qmtt101v", variantId: "67616586825978", name: "מנטה" },
  "P10QMTT1B03": { handle: "p10qmtt1b03", variantId: "67616586989818", name: "בורדו" },
  "P10QMTT1B06": { handle: "p10qmtt1b06", variantId: "67616587088122", name: "ענבר" },
  "P10QMTT2B03": { handle: "p10qmtt2b03", variantId: "67616588005626", name: "בורדו" },
  "P10QMTV109K": { handle: "p10qmtv109k", variantId: "67616598130938", name: "טאופ" },
  "P10QMTV8B03": { handle: "p10qmtv8b03", variantId: "67616605929722", name: "בורדו" },
  "P10QMTV8B09": { handle: "p10qmtv8b09", variantId: "67616606585082", name: "Cocoon" },
  "P10QMTZ4B06": { handle: "p10qmtz4b06", variantId: "67616611893498", name: "ענבר" },
  "P10TKTZ4001": { handle: "p10tktz4001", variantId: "67616613531898", name: "שחור" },
  "P10UYT32466": { handle: "p10uyt32466", variantId: "67616615006458", name: "כסוף" },
  "P10UYTT1466": { handle: "p10uytt1466", variantId: "67616631488762", name: "כסוף" },
  "P10UYTT1B04": { handle: "p10uytt1b04", variantId: "67616631783674", name: "Rich Coco" },
  "P10UYTV1B04": { handle: "p10uytv1b04", variantId: "67616632307962", name: "Rich Coco" },
  "P10UYTX5466": { handle: "p10uytx5466", variantId: "67616633979130", name: "כסוף" },
  "P10UYTX5B04": { handle: "p10uytx5b04", variantId: "67616634110202", name: "Rich Coco" },
  "P10FZP61A28": { handle: "p10fzp61a28", variantId: "67616634798330", name: "טאופ חם" },
  "P10FZP61B09": { handle: "p10fzp61b09", variantId: "67616635027706", name: "Cocoon" },
  "P10FZT13001": { handle: "p10fzt13001", variantId: "67616635158778", name: "שחור" },
  "P10FZT46A28": { handle: "p10fzt46a28", variantId: "67616635289850", name: "טאופ חם" },
  "P10FZT69001": { handle: "p10fzt69001", variantId: "67616635453690", name: "שחור" },
  "P10FZT79B01": { handle: "p10fzt79b01", variantId: "67616635814138", name: "אספרסו" },
  "P10FZT82001": { handle: "p10fzt82001", variantId: "67616635846906", name: "שחור" },
  "P10FZT82B09": { handle: "p10fzt82b09", variantId: "67616635879674", name: "Cocoon" },
  "P10FZTA8001": { handle: "p10fzta8001", variantId: "67616635945210", name: "שחור" },
  "P10OXB01645": { handle: "p10oxb01645", variantId: "67616636600570", name: "אדום" },
  "P10OXB01B11": { handle: "p10oxb01b11", variantId: "67616636797178", name: "כחול" },
  "P10OXM02001": { handle: "p10oxm02001", variantId: "67616636829946", name: "שחור" },
  "P10OXM02B11": { handle: "p10oxm02b11", variantId: "67616637124858", name: "כחול" },
  "P10OXM04645": { handle: "p10oxm04645", variantId: "67616638337274", name: "אדום" },
  "P10OXM04A96": { handle: "p10oxm04a96", variantId: "67616638435578", name: "לילך" },
  "P10OXT01001": { handle: "p10oxt01001", variantId: "67616638599418", name: "שחור" },
  "P10OXT0129O": { handle: "p10oxt0129o", variantId: "67616638730490", name: "ירוק עלווה" },
  "P10OXT01A96": { handle: "p10oxt01a96", variantId: "67616639156474", name: "לילך" },
  "P10OXT01B11": { handle: "p10oxt01b11", variantId: "67616639287546", name: "כחול" },
  "P10TKT34A28": { handle: "p10tkt34a28", variantId: "67616639418618", name: "טאופ חם" },
  "P10OXT03645": { handle: "p10oxt03645", variantId: "67616639615226", name: "אדום" },
  "P10OXT04001": { handle: "p10oxt04001", variantId: "67616640073978", name: "שחור" },
  "P10OXT04B11": { handle: "p10oxt04b11", variantId: "67616640106746", name: "כחול" },
  "P10OXT05645": { handle: "p10oxt05645", variantId: "67616640139514", name: "אדום" },
  "P10OXT08001": { handle: "p10oxt08001", variantId: "67616640532730", name: "שחור" },
  "P10OXT0829O": { handle: "p10oxt0829o", variantId: "67616640565498", name: "ירוק עלווה" },
  "P10OXT08A96": { handle: "p10oxt08a96", variantId: "67616640762106", name: "לילך" },
  "P10OTN01651": { handle: "p10otn01651", variantId: "67616640860410", name: "שחור" },
  "P10OTN02651": { handle: "p10otn02651", variantId: "67616641024250", name: "שחור" },
  "P10OTV0508Q": { handle: "p10otv0508q", variantId: "67616641908986", name: "כחול כהה" },
  "P10OTV05651": { handle: "p10otv05651", variantId: "67616641974522", name: "שחור" },
  "P10UKT01A28": { handle: "p10ukt01a28", variantId: "67616643121402", name: "טאופ חם" },
  "P10UKT03001": { handle: "p10ukt03001", variantId: "67616643219706", name: "שחור" },
  "P10UKT07001": { handle: "p10ukt07001", variantId: "67616643481850", name: "שחור" },
  "P10UKT07A28": { handle: "p10ukt07a28", variantId: "67616643580154", name: "טאופ חם" },
  "P10QMT58651": { handle: "p10qmt58651", variantId: "67621581717754", name: "שחור" },
  "P10FZT73B07": { handle: "p10fzt73b07", variantId: "67621582602490", name: "קפוצ׳ינו" },
  "P10FZT03001": { handle: "p10fzt03001", variantId: "67636163641594", name: "שחור" },
  "P10FZT0308Q": { handle: "p10fzt0308q", variantId: "67636209713402", name: "כחול כהה" },
  "P10FZT03A28": { handle: "p10fzt03a28", variantId: "67636209746170", name: "טאופ חם" },
  "P10FZT10001": { handle: "p10fzt10001", variantId: "67636209844474", name: "שחור" },
  "P10FZT1008Q": { handle: "p10fzt1008q", variantId: "67636209910010", name: "כחול כהה" },
  "P10FZT1327O": { handle: "p10fzt1327o", variantId: "67636210335994", name: "לבן" },
  "P10FZT4608Q": { handle: "p10fzt4608q", variantId: "67636210434298", name: "כחול כהה" },
  "P10FZT6908Q": { handle: "p10fzt6908q", variantId: "67636210467066", name: "כחול כהה" },
  "P10FZT72A28": { handle: "p10fzt72a28", variantId: "67636210532602", name: "טאופ חם" },
  "P10FZT79A82": { handle: "p10fzt79a82", variantId: "67636210630906", name: "חום פקאן" },
  "P10FZT73001": { handle: "תיק-פאוץ-מעור-קלאסי-מבית-מנדרינה-דאק", variantId: "42361904398586", name: "שחור" },
  "P10FZT7308Q": { handle: "תיק-פאוץ-מעור-קלאסי-מבית-מנדרינה-דאק", variantId: "42449044799738", name: "כחול" },
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
  if (sku && Object.hasOwn(VERIFIED_STORE_BRAND_BINDINGS_20261109, sku)) {
    const expected = VERIFIED_STORE_BRAND_BINDINGS_20261109[sku];
    const link = item.shopifyLink;
    if (link?.isPublished === true && link.handle === expected.handle && link.variantId === expected.variantId) {
      return brandFromName("Mandarina Duck");
    }
  }
  return sku && Object.hasOwn(REVIEWED_BRAND_BY_SKU, sku)
    ? brandFromName(REVIEWED_BRAND_BY_SKU[sku]) : null;
}

/** Color label verified from the exact Shopify variant/handle; not a hex guess. */
export function verifiedStoreColorName(item: CarouselItem): string | null {
  const sku = item.catalogNumber?.trim().toUpperCase();
  if (!sku || !Object.hasOwn(VERIFIED_STORE_BRAND_BINDINGS_20261109, sku)) return null;
  const expected = VERIFIED_STORE_BRAND_BINDINGS_20261109[sku];
  return item.shopifyLink?.isPublished === true && item.shopifyLink.handle === expected.handle &&
    item.shopifyLink.variantId === expected.variantId ? expected.name : null;
}

function visibleStoreBrandItem(item: CarouselItem, brand: GalleryBrand): boolean {
  if (!item.isActive || item.shopifyLink?.isPublished === false) return false;
  if (PUBLIC_BRAND_KEYS.has(brand.key)) return true;
  const link = item.shopifyLink;
  // New brands are opt-in through an exact public Shopify binding, not a
  // guessed SKU or image. Match purchase-links' handle and variant guards.
  return !!link && link.isPublished === true && typeof link.handle === "string" &&
    typeof link.variantId === "string" && link.handle.length <= 255 &&
    /^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$/.test(link.handle) && /^\d+$/.test(link.variantId);
}

export function availableBrands(items: CarouselItem[]): GalleryBrand[] {
  const brands = new Map<BrandKey, GalleryBrand>();
  for (const item of items) {
    if (!item.isActive) continue;
    const brand = brandForItem(item);
    if (brand && visibleStoreBrandItem(item, brand) && !brands.has(brand.key)) brands.set(brand.key, brand);
  }
  return [...brands.values()];
}

export function publicCollectionItems(items: CarouselItem[]): CarouselItem[] {
  return items.filter(item => {
    const brand = brandForItem(item);
    return brand !== null && visibleStoreBrandItem(item, brand);
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
