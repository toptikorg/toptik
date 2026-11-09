import type { SourceColorVariant } from "@/lib/catalog-source/types";
import type { CarouselColor, CarouselItem } from "./types";
import { COLOR_HEX, COLOR_HEBREW, extractColorWord } from "./color-groups";
import { detectVendorFromCatalog } from "@/lib/catalog-source/vendor-detect";
import { verifiedStoreColorName } from "./brands";

// Global Mandarina Duck colour codes — the middle segment of the catalog number
// (P10·QMC01·`465`·TU). The code is stable across every model, so it's the most
// reliable colour key. Derived from the live 28-product catalog; hex is an
// approximate swatch fill. Extend as new codes are observed.
export const MANDARINA_COLOR_CODES: Record<string, { he: string; hex: string }> = {
  "465": { he: "פלדה", hex: "#6e7b8b" }, // steel
  "09K": { he: "טאופ", hex: "#8d7966" }, // taupe
  "024": { he: "פיריט", hex: "#6e7060" }, // pirite
  A74: { he: "אויל", hex: "#3d4a1e" }, // oil
  A89: { he: "לונר", hex: "#b8b8c0" }, // lunar
  "29U": { he: "גרפיט", hex: "#555555" }, // graphite
  "08Q": { he: "כחול", hex: "#1a2d5a" }, // dress blue
  "05J": { he: "צהוב", hex: "#f0c040" }, // duck yellow
  A92: { he: "מוארה", hex: "#6b6f76" }, // moire
  A93: { he: "דיווה", hex: "#a52828" }, // diva
  "651": { he: "שחור", hex: "#1a1a1a" }, // black
  "07X": { he: "כחול עמוק", hex: "#1c3a6e" }, // deep blue
  "02F": { he: "אמרלד", hex: "#2e7d52" }, // emerald
  "24N": { he: "פנינה", hex: "#eae6da" }, // pearl
  A82: { he: "אגוז פקאן", hex: "#8a5a3b" }, // pecan nut
  A32: { he: "טורקיז נצנצים", hex: "#3fb8ae" }, // glitter green/turquoise
  A83: { he: "שוקולד", hex: "#6b4b3e" }, // choco ice
  A81: { he: "מוקה לבן", hex: "#d9cdbf" }, // white mocha
};

// Bric's colour codes — the SKU suffix (BXL58145·`078`). Kept SEPARATE from the
// Mandarina table on purpose: the numeric codes collide (Mandarina 465 = steel,
// Bric's 465 would be something else entirely), so the two must never share a
// lookup. Derived from the colour names already scraped for this catalog.
export const BRICS_COLOR_CODES: Record<string, { he: string; hex: string }> = {
  "001": { he: "שחור", hex: "#1a1a1a" },
  "006": { he: "כחול", hex: "#1f3a6e" },
  "014": { he: "קרם", hex: "#e6dcc8" },
  "050": { he: "נייבי", hex: "#1c2a4a" },
  "078": { he: "זית", hex: "#6b6f4a" },
  "101": { he: "שחור", hex: "#1a1a1a" },
  "254": { he: "ורוד", hex: "#d98ba6" },
};

// Exact Roadster SKU colors verified against the current store and Bric's
// Porsche Carry-On. Code 024 belongs to a different color in Mandarina's map.
const REVIEWED_ITEM_SWATCHES: Record<string, { name: string; hex: string }> = {
  "ORI05500.909": { name: "שחור מבריק", hex: "#1a1a1a" },
  "ORI05500.024": { name: "צהוב רייסינג", hex: "#f0c040" },
};

// Exact Shopify product/variant identities and color labels verified 2026-11-09.
// Not a global color-code map: labels apply only to this exact published binding.
export const VERIFIED_PUBLISHED_COLOR_BINDINGS_20261109: Record<string, {handle:string;variantId:string;name:string}> = {
  "BAH08453.001": {handle:"bah08453-001",variantId:"50083958980858",name:"שחור"},
  "BAH08453.006": {handle:"bah08453-006",variantId:"50083959046394",name:"כחול"},
  "BAH08453.078": {handle:"bah08453-078",variantId:"50083959111930",name:"זית"},
  "BXL58145.101": {handle:"bxl58145-101",variantId:"50083959668986",name:"שחור"},
  "BXL58145.050": {handle:"bxl58145-050",variantId:"50083959505146",name:"נייבי"},
  "BXL58145.078": {handle:"bxl58145-078",variantId:"50083959603450",name:"זית"},
  "P10OSV0416Q": {handle:"p10osv0416q",variantId:"67616505266426",name:"ירוק כהה"},
  "P10QMMM3B03": {handle:"p10qmmm3b03",variantId:"67616509690106",name:"בורדו"},
  "P10QMMM3B06": {handle:"p10qmmm3b06",variantId:"67616510017786",name:"ענבר"},
  "P10QMMM3B09": {handle:"p10qmmm3b09",variantId:"67616510083322",name:"Cocoon"},
  "P10QMMO1B09": {handle:"p10qmmo1b09",variantId:"67616510673146",name:"Cocoon"},
  "P10QMN01B09": {handle:"p10qmn01b09",variantId:"67616511459578",name:"Cocoon"},
  "P10QMN01B10": {handle:"p10qmn01b10",variantId:"67616511885562",name:"Cosmic"},
  "P10QMT17B06": {handle:"p10qmt17b06",variantId:"67616512639226",name:"ענבר"},
  "P10QMT3201V": {handle:"p10qmt3201v",variantId:"67616513327354",name:"מנטה"},
  "P10QMT32B09": {handle:"p10qmt32b09",variantId:"67616514015482",name:"Cocoon"},
  "P10QMT39B09": {handle:"p10qmt39b09",variantId:"67616516079866",name:"Cocoon"},
  "P10QMT49B09": {handle:"p10qmt49b09",variantId:"67616516407546",name:"Cocoon"},
  "P10QMT71B06": {handle:"p10qmt71b06",variantId:"67616519586042",name:"ענבר"},
  "P10QMTT1B09": {handle:"p10qmtt1b09",variantId:"67616587251962",name:"Cocoon"},
  "P10QMTT2B06": {handle:"p10qmtt2b06",variantId:"67616588202234",name:"ענבר"},
  "P10OXT05001": {handle:"p10oxt05001",variantId:"67616590299386",name:"שחור"},
  "P10QMTV1B03": {handle:"p10qmtv1b03",variantId:"67616602947834",name:"בורדו"},
  "P10OXT0529O": {handle:"p10oxt0529o",variantId:"67616604881146",name:"ירוק עלווה"},
  "P10QMTV1B09": {handle:"p10qmtv1b09",variantId:"67616605307130",name:"Cocoon"},
  "P10QMTV8B06": {handle:"p10qmtv8b06",variantId:"67616606093562",name:"ענבר"},
  "P10QMTX501V": {handle:"p10qmtx501v",variantId:"67616606617850",name:"מנטה"},
  "P10QMTX5B06": {handle:"p10qmtx5b06",variantId:"67616607207674",name:"ענבר"},
  "P10QMTX5B09": {handle:"p10qmtx5b09",variantId:"67616607305978",name:"Cocoon"},
  "P10QMTX6B03": {handle:"p10qmtx6b03",variantId:"67616609042682",name:"בורדו"},
  "P10QMTX6B09": {handle:"p10qmtx6b09",variantId:"67616609632506",name:"Cocoon"},
  "P10QMTZ401V": {handle:"p10qmtz401v",variantId:"67616610615546",name:"מנטה"},
  "P10QMTZ4B03": {handle:"p10qmtz4b03",variantId:"67616611238138",name:"בורדו"},
  "P10QMTZ4B09": {handle:"p10qmtz4b09",variantId:"67616612155642",name:"Cocoon"},
  "P10TKT34001": {handle:"p10tkt34001",variantId:"67616612614394",name:"שחור"},
  "P10TKTV8A28": {handle:"p10tktv8a28",variantId:"67616612811002",name:"טאופ חם"},
  "P10TKTZ4A28": {handle:"p10tktz4a28",variantId:"67616614514938",name:"טאופ חם"},
  "P10UYT39466": {handle:"p10uyt39466",variantId:"67616619135226",name:"כסוף"},
  "P10UYT39B04": {handle:"p10uyt39b04",variantId:"67616625590522",name:"Rich Coco"},
  "P10UYTV1466": {handle:"p10uytv1466",variantId:"67616631881978",name:"כסוף"},
  "P10UYTV8466": {handle:"p10uytv8466",variantId:"67616633323770",name:"כסוף"},
  "P10UYTZ4466": {handle:"p10uytz4466",variantId:"67616634470650",name:"כסוף"},
  "P10FZP61B01": {handle:"p10fzp61b01",variantId:"67616634962170",name:"אספרסו"},
  "P10FZT12001": {handle:"p10fzt12001",variantId:"67616635060474",name:"שחור"},
  "P10FZT69A28": {handle:"p10fzt69a28",variantId:"67616635715834",name:"טאופ חם"},
  "P10FZT79001": {handle:"p10fzt79001",variantId:"67616635748602",name:"שחור"},
  "P10FZT79A28": {handle:"p10fzt79a28",variantId:"67616635781370",name:"טאופ חם"},
  "P10FZTA7001": {handle:"p10fzta7001",variantId:"67616635912442",name:"שחור"},
  "P10FZTA8B01": {handle:"p10fzta8b01",variantId:"67616636010746",name:"אספרסו"},
  "P10FZTA8B09": {handle:"p10fzta8b09",variantId:"67616636043514",name:"Cocoon"},
  "P10FZTA9001": {handle:"p10fzta9001",variantId:"67616636076282",name:"שחור"},
  "P10FZTA9B09": {handle:"p10fzta9b09",variantId:"67616636207354",name:"Cocoon"},
  "P10OXB01001": {handle:"p10oxb01001",variantId:"67616636371194",name:"שחור"},
  "P10OXB0129O": {handle:"p10oxb0129o",variantId:"67616636567802",name:"ירוק עלווה"},
  "P10OXB01A96": {handle:"p10oxb01a96",variantId:"67616636731642",name:"לילך"},
  "P10OXM0229O": {handle:"p10oxm0229o",variantId:"67616636993786",name:"ירוק עלווה"},
  "P10OXM02645": {handle:"p10oxm02645",variantId:"67616637059322",name:"אדום"},
  "P10OXM02A96": {handle:"p10oxm02a96",variantId:"67616637092090",name:"לילך"},
  "P10OXM04001": {handle:"p10oxm04001",variantId:"67616637190394",name:"שחור"},
  "P10OXM0429O": {handle:"p10oxm0429o",variantId:"67616638042362",name:"ירוק עלווה"},
  "P10OXM04B11": {handle:"p10oxm04b11",variantId:"67616638501114",name:"כחול"},
  "P10OXT01645": {handle:"p10oxt01645",variantId:"67616639058170",name:"אדום"},
  "P10OXT03001": {handle:"p10oxt03001",variantId:"67616639484154",name:"שחור"},
  "P10OXT0329O": {handle:"p10oxt0329o",variantId:"67616639516922",name:"ירוק עלווה"},
  "P10OXT03A96": {handle:"p10oxt03a96",variantId:"67616639975674",name:"לילך"},
  "P10OXT03B11": {handle:"p10oxt03b11",variantId:"67616640008442",name:"כחול"},
  "P10OXT05A96": {handle:"p10oxt05a96",variantId:"67616640172282",name:"לילך"},
  "P10OXT05B11": {handle:"p10oxt05b11",variantId:"67616640434426",name:"כחול"},
  "P10OXT08645": {handle:"p10oxt08645",variantId:"67616640729338",name:"אדום"},
  "P10OXT08B11": {handle:"p10oxt08b11",variantId:"67616640827642",name:"כחול"},
  "P10SZV24466": {handle:"טרולי-כחול-logoduck-m",variantId:"42624917340410",name:"כסוף"},
  "P10UKT01001": {handle:"p10ukt01001",variantId:"67616642007290",name:"שחור"},
  "P10UKT03A28": {handle:"p10ukt03a28",variantId:"67616643252474",name:"טאופ חם"},
  "P10UKT04001": {handle:"p10ukt04001",variantId:"67616643285242",name:"שחור"},
  "P10UKT04A28": {handle:"p10ukt04a28",variantId:"67616643449082",name:"טאופ חם"},
  "P10QMT49B06": {handle:"p10qmt49b06",variantId:"67621581652218",name:"ענבר"},
  "P10QMT17A46": {handle:"p10qmt17a46",variantId:"67621581455610",name:"Scarab"},
  "P10QMTX5A46": {handle:"p10qmtx5a46",variantId:"67621582340346",name:"Scarab"},
  "P10FZT73209": {handle:"p10fzt73209",variantId:"67621582536954",name:"הוואנה"},
  "P10FZT73B01": {handle:"p10fzt73b01",variantId:"67621582569722",name:"אספרסו"},
  "P10FZT05001": {handle:"p10fzt05001",variantId:"67636209778938",name:"שחור"},
  "P10FZT05A28": {handle:"p10fzt05a28",variantId:"67636209811706",name:"טאופ חם"},
  "P10FZT10A28": {handle:"p10fzt10a28",variantId:"67636209942778",name:"טאופ חם"},
  "P10FZT12A28": {handle:"p10fzt12a28",variantId:"67636210008314",name:"טאופ חם"},
  "P10FZT8206M": {handle:"p10fzt8206m",variantId:"67636210729210",name:"חום שוקולד"},
  "P10FZT11001": {handle:"p10fzt11001",variantId:"67637048115450",name:"שחור"},
  "P10FZT1127O": {handle:"p10fzt1127o",variantId:"67637581578490",name:"לבן"},
  "P10FZT1106M": {handle:"p10fzt1106m",variantId:"67637616378106",name:"חום שוקולד"},
  "P10FZT11A28": {handle:"p10fzt11a28",variantId:"67637862924538",name:"טאופ חם"},
  "P10FZT13A28": {handle:"p10fzt13a28",variantId:"67637864890618",name:"טאופ חם"},
  "P10FZT7525G": {handle:"p10fzt7525g",variantId:"67637913518330",name:"Balsamic"},
  "P10FZT4628S": {handle:"p10fzt4628s",variantId:"67638515302650",name:"Almond"},
  "P10FZT12B09": {handle:"p10fzt12b09",variantId:"67638525133050",name:"Cocoon"},
  "P10FZT13B09": {handle:"p10fzt13b09",variantId:"67638525165818",name:"Cocoon"},
  "P10FZT12A38": {handle:"p10fzt12a38",variantId:"67638551544058",name:"Marmalade"},
  "P10FZT0528S": {handle:"p10fzt0528s",variantId:"67638557212922",name:"Almond"},
  "P10FZT12A43": {handle:"p10fzt12a43",variantId:"67638558654714",name:"December Sky"},
  "P10FZT0328S": {handle:"p10fzt0328s",variantId:"67638812868858",name:"Almond"},
  "P10FZT11B09": {handle:"p10fzt11b09",variantId:"67638853796090",name:"Cocoon"},
  "P10FZT1306M": {handle:"p10fzt1306m",variantId:"67638855074042",name:"Milk Chocolate"},
  "P10FZT05B09": {handle:"p10fzt05b09",variantId:"67638855139578",name:"Cocoon"},
  "P10FZT7524X": {handle:"p10fzt7524x",variantId:"67638855860474",name:"Ochre"},
  "P10FZT0327O": {handle:"p10fzt0327o",variantId:"67638855991546",name:"Blanc"},
  "P10FZT7928S": {handle:"p10fzt7928s",variantId:"67638856679674",name:"Almond"},
  "P10FZT69A01": {handle:"p10fzt69a01",variantId:"67638934143226",name:"Nimbus Cloud"},
  "P10FZT1228S": {handle:"p10fzt1228s",variantId:"67639110861050",name:"Almond"},
  "P10FZT8229J": {handle:"p10fzt8229j",variantId:"67639426056442",name:"Mistral"},
  "P10FZT7326R": {handle:"p10fzt7326r",variantId:"67641074385146",name:"אפור כהה"},
  "P10FZT7313U": {handle:"p10fzt7313u",variantId:"67641158271226",name:"חום כהה"},
  "P10QMT49209": {handle:"תיק-גב-mandarina-duck-md20-qmt49-בצבע-חמרה-havana",variantId:"68127716999418",name:"חמרה Havana"},
  "P10QMT58209": {handle:"תיק-צד-mandarina-duck-md20-qmt58-בצבע-חמרה",variantId:"68127717490938",name:"חמרה"},
  "P10QMT58B03": {handle:"תיק-צד-mandarina-duck-md20-qmt58-בצבע-בורדו-sin",variantId:"68127928156410",name:"בורדו Sin"},
  "P10QMTX5B03": {handle:"תיק-צד-mandarina-duck-md20-qmtx5-בצבע-בורדו-sin",variantId:"68127943917818",name:"בורדו Sin"},
  "P10QMN01B03": {handle:"תיק-רחצה-mandarina-duck-md20-qmn01-בצבע-בורדו-sin",variantId:"68127949914362",name:"בורדו Sin"},
  "P10QMT39209": {handle:"תיק-גב-mandarina-duck-md20-qmt39-בצבע-חמרה-havana",variantId:"68127817859322",name:"חמרה Havana"},
  "P10QMT71209": {handle:"תיק-גב-mandarina-duck-md20-qmt71-בצבע-חמרה-havana",variantId:"68127817892090",name:"חמרה Havana"},
  "P10QMT58B09": {handle:"תיק-צד-mandarina-duck-md20-qmt58-בצבע-cocoon",variantId:"68127817924858",name:"Cocoon"},
  "P10QMT32B06": {handle:"תיק-צד-mandarina-duck-md20-qmt32-בצבע-ענבר-amber",variantId:"68127978094842",name:"ענבר Amber"},
  "P10FZP61209": {handle:"ארנק-עור-mandarina-duck-mellow-leather-fzp61-בצבע-חמרה-havana",variantId:"68128017711354",name:"חמרה Havana"},
  "P10FZP61B03": {handle:"ארנק-עור-mandarina-duck-mellow-leather-fzp61-בצבע-בורדו-sin",variantId:"68128030785786",name:"בורדו Sin"},
  "P10FZP61B07": {handle:"ארנק-עור-mandarina-duck-mellow-leather-fzp61-בצבע-קפוצ-ינו",variantId:"68128038322426",name:"קפוצ׳ינו"},
  "P10FZP61B08": {handle:"ארנק-עור-mandarina-duck-mellow-leather-fzp61-בצבע-זית-חורפי",variantId:"68128046252282",name:"זית חורפי"},
  "P10FZTA9209": {handle:"תיק-צד-mandarina-duck-mellow-leather-fzta9-בצבע-חמרה-havana",variantId:"68128085016826",name:"חמרה Havana"},
  "P10UKT03B03": {handle:"תיק-צד-מעור-mandarina-duck-daisy-ukt03-בצבע-בורדו-sin",variantId:"68128211960058",name:"בורדו Sin"},
  "P10UYT32B04": {handle:"תיק-צד-mandarina-duck-md20-lux-2-0-uyt32-בצבע-rich-coco",variantId:"68132296196346",name:"Rich Coco"},
  "P10UYTV8B04": {handle:"תיק-צד-mandarina-duck-md20-lux-2-0-uytv8-בצבע-rich-coco",variantId:"68132347740410",name:"Rich Coco"},
  "P10UYTZ4B04": {handle:"תיק-גב-mandarina-duck-md20-lux-2-0-uytz4-בצבע-rich-coco",variantId:"68132370678010",name:"Rich Coco"},
  "P10TKTZ4B03": {handle:"תיק-גב-מעור-mandarina-duck-md20-leather-tktz4-בצבע-בורדו-sin",variantId:"68132660576506",name:"בורדו Sin"},
  "P10FZTA8B03": {handle:"תיק-צד-מעור-mandarina-duck-mellow-leather-fzta8-בצבע-בורדו-sin",variantId:"68132762452218",name:"בורדו Sin"},
  "P10FZT12209": {handle:"תיק-צד-מעור-mandarina-duck-mellow-leather-fzt12-בצבע-חמרה-havana",variantId:"68132814192890",name:"חמרה Havana"},
};

export function verifiedPublishedColorName(item: CarouselItem): string | null {
  const sku=item.catalogNumber?.trim().toUpperCase();
  if(!sku || !Object.hasOwn(VERIFIED_PUBLISHED_COLOR_BINDINGS_20261109,sku)) return null;
  const expected=VERIFIED_PUBLISHED_COLOR_BINDINGS_20261109[sku],link=item.shopifyLink;
  return link?.isPublished===true && link.handle===expected.handle && link.variantId===expected.variantId ? expected.name : null;
}

// Resolve a Hebrew name + swatch hex from the colour code (preferred, global)
// or the colour word parsed from the title (fallback).
export function resolveColorMeta(
  colorWord: string | null,
  colorCode: string | null,
): { name: string; hex: string | null } {
  const code = colorCode?.toUpperCase() ?? null;
  if (code && MANDARINA_COLOR_CODES[code]) {
    return { name: MANDARINA_COLOR_CODES[code].he, hex: MANDARINA_COLOR_CODES[code].hex };
  }
  const word = colorWord?.toLowerCase() ?? null;
  if (word) {
    return { name: COLOR_HEBREW[word] ?? colorWord!, hex: COLOR_HEX[word] ?? null };
  }
  return { name: code ?? "צבע", hex: null };
}

// Vendor-aware resolution from a catalog number: pick the colour table that
// belongs to the brand that issued the number, then fall back to a colour word
// in the title. `named` is false when nothing resolved and `name` is only the
// raw code — callers that must not show a code can check it.
export function resolveColorMetaForCatalog(
  catalogNumber: string | null | undefined,
  title: string | null | undefined,
): { name: string; hex: string | null; named: boolean } {
  const code = colorCodeFromCatalog(catalogNumber)?.toUpperCase() ?? null;
  const table =
    catalogNumber && detectVendorFromCatalog(catalogNumber) === "brics"
      ? BRICS_COLOR_CODES
      : MANDARINA_COLOR_CODES;
  if (code && table[code]) return { ...table[code], name: table[code].he, named: true };
  const word = title ? extractColorWord(title) : null;
  if (word) {
    return { name: COLOR_HEBREW[word.toLowerCase()] ?? word, hex: COLOR_HEX[word.toLowerCase()] ?? null, named: true };
  }
  return { name: code ?? "צבע", hex: null, named: false };
}

// Map scraped colour variants → persisted colours, attaching the Supabase-hosted
// gallery re-hosted for each variant (its rotation angles). Variants whose images
// couldn't be re-hosted are dropped (a swatch with no image can't drive a swap).
export function toCarouselColors(
  variants: SourceColorVariant[],
  galleryByHandle: Map<string, string[]>,
): CarouselColor[] {
  const colors: CarouselColor[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const angles = galleryByHandle.get(variant.handle) ?? [];
    if (angles.length === 0) continue;
    const { name, hex } = resolveColorMeta(variant.colorWord, variant.colorCode);
    const key = (variant.colorCode || variant.colorWord || variant.handle).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({
      name,
      hex,
      colorCode: variant.colorCode,
      imagePath: angles[0],
      angles,
      sourceUrl: variant.sourceUrl,
      catalogNumber: variant.catalogNumber,
    });
  }
  return colors;
}

// Bric's colour naming: the colour is a plain English word/phrase from the
// Shopify "Color" option (Ocean, Bordeaux, Cappuccino...), and the colour code
// is the SKU suffix (BOE58117·050). Never consult MANDARINA_COLOR_CODES here —
// Bric's numeric codes can collide with Mandarina's and would resolve to the
// wrong Hebrew name.
function bricsColorMeta(colorWord: string | null): { name: string; hex: string | null } {
  const word = colorWord?.trim().toLowerCase() ?? null;
  if (!word) return { name: "צבע", hex: null };
  if (COLOR_HEBREW[word]) return { name: COLOR_HEBREW[word], hex: COLOR_HEX[word] ?? null };
  const translated = word
    .split(/\s+/)
    .map((w) => COLOR_HEBREW[w] ?? w)
    .join(" ");
  const hex = word.split(/\s+/).map((w) => COLOR_HEX[w]).find(Boolean) ?? null;
  return { name: translated !== word ? translated : colorWord!, hex };
}

export function toBricsCarouselColors(
  variants: SourceColorVariant[],
  galleryByHandle: Map<string, string[]>,
): CarouselColor[] {
  const colors: CarouselColor[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const angles = galleryByHandle.get(variant.handle) ?? [];
    if (angles.length === 0) continue;
    const { name, hex } = bricsColorMeta(variant.colorWord);
    const key = (variant.colorCode || variant.colorWord || variant.handle).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({
      name,
      hex,
      colorCode: variant.colorCode,
      imagePath: angles[0],
      angles,
      sourceUrl: variant.sourceUrl,
      catalogNumber: variant.catalogNumber,
    });
  }
  return colors;
}

// Guarantee a product's OWN colour is present — a product always exists at least
// in the colour it was imported in. Uses the item's existing cover so it never
// ends up with zero colours even when sibling scraping fails entirely.
export function ensureOwnColor(
  colors: CarouselColor[],
  item: { catalogNumber: string | null; title?: string | null; coverImagePath: string },
): CarouselColor[] {
  if (!item.coverImagePath) return colors;
  const ownCode = colorCodeFromCatalog(item.catalogNumber);
  const hasOwn =
    (ownCode != null && colors.some((c) => c.colorCode?.toUpperCase() === ownCode)) ||
    colors.some((c) => c.imagePath === item.coverImagePath);
  if (hasOwn) return colors;
  // Vendor-aware: a Bric's suffix must not be read off the Mandarina table.
  const { name, hex } = resolveColorMetaForCatalog(item.catalogNumber, item.title);
  const own: CarouselColor = {
    name,
    hex,
    colorCode: ownCode,
    imagePath: item.coverImagePath,
    angles: [item.coverImagePath],
    sourceUrl: null,
    catalogNumber: item.catalogNumber,
  };
  return [own, ...colors];
}

// ─── UI swatch resolution ────────────────────────────────────────────────────

// A swatch ready to render. `imagePath` non-null ⇒ clicking swaps the displayed
// product image to that colour; null ⇒ a passive colour dot (title fallback).
export interface ResolvedSwatch {
  key: string;
  itemId?: string; // the catalog item this colour IS (drives navigation on click)
  name: string;
  hex: string | null;
  imagePath: string | null; // cover (= angles[0])
  angles: string[]; // this colour's full gallery — drives rotation while selected
  isCurrent: boolean;
  useProductImageAsSwatch?: boolean;
}

export function colorSwatchStyle(swatch: ResolvedSwatch): { background?: string; backgroundImage?: string; backgroundSize?: string; backgroundPosition?: string } | undefined {
  if (swatch.hex) return { background: swatch.hex };
  if (!swatch.useProductImageAsSwatch || !swatch.imagePath) return undefined;
  try {
    const url = new URL(swatch.imagePath);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return { backgroundImage: `url(${JSON.stringify(url.href)})`, backgroundSize: "cover", backgroundPosition: "center" };
  } catch { return undefined; }
}

// Middle segment of a catalog number = the colour code. Handles both catalog
// styles: Mandarina dash-separated (P10·QMC01·`465`·TU) and Bric's dot-separated
// (BOE58117·`050`) — plus the un-separated forms some rows were saved in
// (P10JNV05·465, BXL38124·078), where the colour is the trailing 3 characters.
// Without that fallback those products resolve to no colour at all.
export function colorCodeFromCatalog(catalogNumber: string | null | undefined): string | null {
  if (!catalogNumber) return null;
  const parts = catalogNumber.toUpperCase().split(/[-_/.]/).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  const token = parts[0]?.replace(/TU$/, "") ?? "";
  // Mandarina: P + 2 digits + 5-char model + 3-char colour.
  // Bric's: 2-4 letters + 5 digits + 3-digit colour.
  if (/^P\d{2}[A-Z0-9]{5}[A-Z0-9]{3}$/.test(token) || /^[A-Z]{2,4}\d{8}$/.test(token)) {
    return token.slice(-3);
  }
  return null;
}

// Model code = first catalog segment minus the P-prefix (P10·`QMC01`·465·TU).
// Every colour of a product shares this code; the colour is the second segment.
export function modelCodeFromCatalog(catalogNumber: string | null | undefined): string | null {
  if (!catalogNumber) return null;
  // Compact Mandarina SKUs keep the 5-character model before the 3-character
  // colour (P10FZT73A46). Match the whole SKU so separated formats stay intact.
  const compactModel = catalogNumber.toUpperCase().match(/^P10([A-Z0-9]{5})[A-Z0-9]{3}(?:TU)?$/);
  if (compactModel) return compactModel[1];
  // Split on Bric's dot too (BXL58145.101 → base "BXL58145"), so every colour of
  // a model shares one model code (Mandarina P10SZV24-05J-TU → "SZV24").
  const head = catalogNumber.toUpperCase().split(/[-_/.]/)[0] ?? "";
  const stripped = head.replace(/^P\d+/, "");
  return stripped.length >= 4 ? stripped : null;
}

// Swatches for a card come ONLY from colour-sibling ITEMS that actually exist in
// the catalog (built by buildModelSiblingSwatches, grouped by model code). A
// colour that has no product of its own is never shown, and clicking a swatch
// navigates to that colour's product. A model with a single colour in the
// catalog therefore has no swatch selector at all.
export function resolveItemSwatches(modelSiblings?: ResolvedSwatch[]): ResolvedSwatch[] {
  return modelSiblings ?? [];
}

// Fallback swatches (pre-warm) built from colour-variant ITEMS already in the
// catalog, grouped by EXACT model code so only true colour siblings merge — a
// swatch can never resolve to a different product (the wrong-product bug). Each
// swatch carries that sibling's own angle gallery, so colours stay rotatable
// without any scraped data.
export function buildModelSiblingSwatches(items: CarouselItem[]): Map<string, ResolvedSwatch[]> {
  const families = new Map<string, CarouselItem[]>();
  for (const item of items) {
    const model = modelCodeFromCatalog(item.catalogNumber);
    if (!model) continue;
    if (!families.has(model)) families.set(model, []);
    families.get(model)!.push(item);
  }

  const result = new Map<string, ResolvedSwatch[]>();
  for (const members of families.values()) {
    const seen = new Set<string>();
    const base: Array<{ code: string; swatch: Omit<ResolvedSwatch, "isCurrent"> }> = [];
    for (const member of members) {
      const code = (colorCodeFromCatalog(member.catalogNumber) ?? member.id).toUpperCase();
      if (seen.has(code)) continue;
      seen.add(code);
      const reviewed = member.catalogNumber ? REVIEWED_ITEM_SWATCHES[member.catalogNumber.trim().toUpperCase()] : undefined;
      const resolved = reviewed ?? resolveColorMeta(
        member.color?.trim() || extractColorWord(member.title),
        colorCodeFromCatalog(member.catalogNumber),
      );
      const verifiedName = verifiedStoreColorName(member) ?? verifiedPublishedColorName(member);
      const name = verifiedName ?? resolved.name;
      const hex = resolved.hex;
      const angles =
        member.angles.length > 0
          ? [...member.angles].sort((a, b) => a.angleOrder - b.angleOrder).map((a) => a.imagePath)
          : [member.coverImagePath];
      base.push({
        code,
        swatch: { key: code, itemId: member.id, name, hex, imagePath: member.coverImagePath, angles,
          useProductImageAsSwatch: !!verifiedName && hex === null },
      });
    }
    if (base.length < 2) continue; // need 2+ colours to form a selector

    for (const member of members) {
      const ownCode = (colorCodeFromCatalog(member.catalogNumber) ?? member.id).toUpperCase();
      result.set(
        member.id,
        base.map((b) => ({ ...b.swatch, isCurrent: b.code === ownCode })),
      );
    }
  }
  return result;
}
