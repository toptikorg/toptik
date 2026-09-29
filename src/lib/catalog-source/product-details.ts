import { safeSourceFetch } from "./safe-fetch";
import { approvedSourceUrl } from "./source-allowlist";

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
};

export interface SpecItem {
  label: string;
  value: string;
}

export interface SpecSection {
  heading: string;
  items: SpecItem[];
}

export interface ColorSwatch {
  name: string;
  hex: string | null;
  swatchUrl: string | null;
}

export interface ProductDetails {
  specs: SpecSection[];
  colors: ColorSwatch[];
}

// ─── Sanitization ────────────────────────────────────────────────────────────

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function clean(text: string): string {
  return decodeHtmlEntities(stripTags(text)).trim();
}

function splitLines(html: string): string[] {
  return decodeHtmlEntities(
    html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(?:p|li|div)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// ─── Metric extraction (cm + kg only — imperial silently discarded) ──────────

function normalizeNum(s: string): string {
  return s.replace(",", ".");
}

// Returns "A × B × C ס\"מ" if the text contains a 3-dim cm measurement, else null.
function extractDimensionsCm(text: string): string | null {
  const m = /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*cm\b/i.exec(text);
  if (!m) return null;
  return `${normalizeNum(m[1])} × ${normalizeNum(m[2])} × ${normalizeNum(m[3])} ס"מ`;
}

// Returns "X ק\"ג" if the text contains a kg measurement, else null.
function extractWeightKg(text: string): string | null {
  const m = /(\d+(?:[.,]\d+)?)\s*kg\b/i.exec(text);
  if (!m) return null;
  return `${normalizeNum(m[1])} ק"ג`;
}

// Returns "X ק\"ג" converted from a lbs measurement (Bric's US site), else null.
function extractWeightLbs(text: string): string | null {
  const m = /(\d+(?:[.,]\d+)?)\s*lbs?\b/i.exec(text);
  if (!m) return null;
  const kg = Math.round(parseFloat(normalizeNum(m[1])) * 0.45359237 * 10) / 10;
  return `${kg} ק"ג`;
}

// Bric's dimension format: `14" w x 21" h x 9" d` (inches, w/h/d suffixes).
// Returns "A × B × C ס\"מ" converted to centimeters, else null.
function extractDimensionsInchesWHD(text: string): string | null {
  const m =
    /(\d+(?:[.,]\d+)?)\s*(?:"|″|in\b)?\s*w\.?\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(?:"|″|in\b)?\s*h\.?\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(?:"|″|in\b)?\s*d\b/i.exec(
      text,
    );
  if (!m) return null;
  const toCm = (s: string) => Math.round(parseFloat(normalizeNum(s)) * 2.54);
  return `${toCm(m[1])} × ${toCm(m[2])} × ${toCm(m[3])} ס"מ`;
}

// Returns "X ס\"מ" if the text contains a single cm measurement (length/strap/etc).
function extractLengthCm(text: string): string | null {
  const m = /(\d+(?:[.,]\d+)?)\s*cm\b/i.exec(text);
  if (!m) return null;
  return `${normalizeNum(m[1])} ס"מ`;
}

// Returns "X ליטר" if the text contains a liter volume measurement.
function extractVolumeLiters(text: string): string | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:l|lt|liters?|litres?)\b/i.exec(text);
  if (!m) return null;
  return `${normalizeNum(m[1])} ליטר`;
}

// Shell materials, most specific first (polyamide before the bare "poly" forms)
// so "recycled polyamide" doesn't resolve to polyester. Used only as a fallback
// when the composition accordion gave nothing.
const MATERIAL_WORDS: Array<[RegExp, string]> = [
  [/polycarbonate|policarbonato/i, "פוליקרבונט"],
  [/polypropylene/i, "פוליפרופילן"],
  [/polyamide|poliammide/i, "פוליאמיד"],
  [/polyester|poliestere/i, "פוליאסטר"],
  [/\bnylon\b/i, "ניילון"],
  [/\bABS\b/, "ABS"],
  [/alumini?um/i, "אלומיניום"],
  [/genuine leather|\bleather\b|\bpelle\b/i, "עור"],
];

function extractMaterialWord(text: string): string | null {
  for (const [pattern, hebrew] of MATERIAL_WORDS) {
    if (pattern.test(text)) return hebrew;
  }
  return null;
}

// ─── Hebrew translation ──────────────────────────────────────────────────────

// Used for whole-line replacement of common Mandarina descriptive items
// (typically bullet items under Exterior:/Interior:). Keys are lowercase.
const LINE_TRANSLATIONS: Record<string, string> = {
  "double compartment": "תא כפול",
  "single compartment": "תא יחיד",
  "triple compartment": "תא משולש",
  "divider mesh": "מחיצת רשת",
  "internal divider": "מחיצה פנימית",
  "padded compartment": "תא מרופד",
  "padded laptop compartment": "תא מרופד למחשב נייד",
  "italian leather": "עור איטלקי",
  "calf leather": "עור עגל",
  "real leather": "עור אמיתי",
  "genuine leather": "עור אמיתי",
  "designed in italy": "",  // dropped
  "made in italy": "תוצרת איטליה",
};

// Bullet noun translations. Each entry: [regex matching the English form,
// singular Hebrew form, plural Hebrew form]. Singular is used when the
// bullet has a leading count of 1, plural otherwise. More specific patterns
// must come before less specific ones.
const NOUN_TRANSLATIONS: Array<[RegExp, string, string]> = [
  // pocket variants — most specific first
  [/external front pockets? with flap and zippers?/gi, "כיס חיצוני קדמי עם דש ורוכסן", "כיסים חיצוניים קדמיים עם דש ורוכסן"],
  [/external front pockets? with flap/gi, "כיס חיצוני קדמי עם דש", "כיסים חיצוניים קדמיים עם דש"],
  [/external front pockets? with zippers?/gi, "כיס חיצוני קדמי עם רוכסן", "כיסים חיצוניים קדמיים עם רוכסן"],
  [/external front pockets?/gi, "כיס חיצוני קדמי", "כיסים חיצוניים קדמיים"],
  [/front external pockets? with zippers?/gi, "כיס חיצוני קדמי עם רוכסן", "כיסים חיצוניים קדמיים עם רוכסן"],
  [/front external pockets?/gi, "כיס חיצוני קדמי", "כיסים חיצוניים קדמיים"],
  [/flat front external pockets? with zippers?/gi, "כיס חיצוני קדמי שטוח עם רוכסן", "כיסים חיצוניים קדמיים שטוחים עם רוכסן"],
  [/side external pockets? with zippers?/gi, "כיס חיצוני בצד עם רוכסן", "כיסים חיצוניים בצד עם רוכסן"],
  [/side external pockets?/gi, "כיס חיצוני בצד", "כיסים חיצוניים בצד"],
  [/back internal pockets? with flap and zippers?/gi, "כיס פנימי אחורי עם דש ורוכסן", "כיסים פנימיים אחוריים עם דש ורוכסן"],
  [/back internal pockets?/gi, "כיס פנימי אחורי", "כיסים פנימיים אחוריים"],
  [/internal applied (?:cell |mobile )?phone pockets?/gi, "כיס טלפון פנימי", "כיסי טלפון פנימיים"],
  [/applied internal (?:cell |mobile )?phone pockets?/gi, "כיס טלפון פנימי", "כיסי טלפון פנימיים"],
  [/internal (?:cell |mobile )?phone pockets?/gi, "כיס טלפון פנימי", "כיסי טלפון פנימיים"],
  [/internal pockets? with (?:flap and )?zippers?/gi, "כיס רוכסן פנימי", "כיסי רוכסן פנימיים"],
  [/internal zip pockets?/gi, "כיס רוכסן פנימי", "כיסי רוכסן פנימיים"],
  [/internal pockets?/gi, "כיס פנימי", "כיסים פנימיים"],
  [/front zip pockets?/gi, "כיס רוכסן קדמי", "כיסי רוכסן קדמיים"],
  [/back zip pockets?/gi, "כיס רוכסן אחורי", "כיסי רוכסן אחוריים"],
  [/rear pockets? with velcro closure/gi, "כיס אחורי עם סגירת סקוץ׳", "כיסים אחוריים עם סגירת סקוץ׳"],
  [/rear pockets?/gi, "כיס אחורי", "כיסים אחוריים"],
  [/zip pockets?/gi, "כיס רוכסן", "כיסי רוכסן"],
  [/(?:cell |mobile )?phone pockets?/gi, "כיס טלפון", "כיסי טלפון"],
  [/front pockets?/gi, "כיס קדמי", "כיסים קדמיים"],
  [/back pockets?/gi, "כיס אחורי", "כיסים אחוריים"],
  [/external pockets?/gi, "כיס חיצוני", "כיסים חיצוניים"],
  [/pockets?/gi, "כיס", "כיסים"],
  // strap / handle / accessory items
  [/adjustable straps? with buckle/gi, "רצועה מתכווננת עם אבזם", "רצועות מתכווננות עם אבזם"],
  [/adjustable straps?/gi, "רצועה מתכווננת", "רצועות מתכווננות"],
  [/top handles?/gi, "ידית עליונה", "ידיות עליונות"],
  [/luggage cover/gi, "כיסוי מזוודה", "כיסויי מזוודה"],
  [/address tag/gi, "תווית כתובת", "תוויות כתובת"],
  [/integrated tsa/gi, "מנעול TSA משולב", "מנעולי TSA משולבים"],
  [/tsa lock/gi, "מנעול TSA", "מנעולי TSA"],
];

// Key labels in "Key: value" lines. Lowercase keys → Hebrew label.
const KEY_TRANSLATIONS: Record<string, string> = {
  closure: "סגירה",
  "shoulder strap": "רצועת כתף",
  "shoulder straps": "רצועות כתף",
  "shoulder strap length": "אורך רצועת כתף",
  strap: "רצועה",
  "strap length": "אורך רצועה",
  length: "אורך",
  size: "גודל",
  type: "סוג",
  weight: "משקל",
  dimensions: "מידות",
  volume: "נפח",
  capacity: "קיבולת",
  width: "רוחב",
  height: "גובה",
  depth: "עומק",
  handles: "ידיות",
  handle: "ידית",
  "handle system": "מערכת ידיות",
  lock: "מנעול",
  accessories: "אבזרים",
  lining: "בטנה",
  material: "חומר",
  materials: "חומרים",
  composition: "הרכב",
};

// Generic phrase replacements applied to values (free text after a colon).
const VALUE_PHRASE_TRANSLATIONS: Array<[RegExp, string]> = [
  [/with zipper/gi, "רוכסן"],
  [/with flap/gi, "עם דש"],
  [/jacquard tape/gi, "סרט ז׳קארד"],
  [/jacquard/gi, "ז׳קארד"],
  [/adjustable with sliding ring/gi, "מתכוונן עם טבעת הזזה"],
  [/adjustable/gi, "מתכוונן"],
  [/sliding ring/gi, "טבעת הזזה"],
  [/velcro closure/gi, "סגירת סקוץ׳"],
  [/dual rods, retractable, multi-step/gi, "מוטות כפולים נשלפים רב-שלביים"],
  [/dual rods/gi, "מוטות כפולים"],
  [/retractable/gi, "נשלף"],
  [/multi-step/gi, "רב-שלבי"],
  [/integrated tsa/gi, "מנעול TSA משולב"],
  [/tsa lock/gi, "מנעול TSA"],
  [/top handles?/gi, "ידית עליונה"],
  [/side handles?/gi, "ידיות צד"],
  [/customized, tone-on-tone resin details/gi, "אביזרי שרף בגוון תואם"],
  [/customized tone-on-tone resin details/gi, "אביזרי שרף בגוון תואם"],
  [/tone-on-tone resin details/gi, "אביזרי שרף בגוון תואם"],
  [/tone-on-tone printed lettering logo/gi, "לוגו מודפס בגוון תואם"],
  [/tone-on-tone/gi, "בגוון תואם"],
  [/printed lettering logo/gi, "לוגו אותיות מודפס"],
  [/k-ring logoed/gi, "טבעת K עם לוגו"],
  [/k-ring/gi, "טבעת K"],
  [/expandable hard-shell cabin trolley/gi, "טרולי קבינה מתרחב עם מעטפת קשיחה"],
  [/hard-shell/gi, "מעטפת קשיחה"],
  [/expandable/gi, "מתרחב"],
  [/4 wheels/gi, "4 גלגלים"],
  [/crossbody bag with double front pockets/gi, "תיק צד עם שני כיסים קדמיים"],
  [/crossbody bag/gi, "תיק צד"],
  [/crossbody and shoulder/gi, "צד וכתף"],
  [/crossbody/gi, "צד"],
  [/dual portability/gi, "נשיאה כפולה"],
  [/polyester/gi, "פוליאסטר"],
  [/polycarbonate/gi, "פוליקרבונט"],
  [/polyurethane/gi, "פוליאוריתן"],
  [/100\s*%\s*([a-zA-Zא-ת]+)/g, "100% $1"],
];

function translateValue(text: string): string {
  let out = text;
  for (const [re, hebrew] of VALUE_PHRASE_TRANSLATIONS) {
    out = out.replace(re, hebrew);
  }
  return out.trim();
}

function translateNouns(text: string, singular: boolean): string {
  let out = text;
  for (const [re, sing, plur] of NOUN_TRANSLATIONS) {
    out = out.replace(re, singular ? sing : plur);
  }
  return out;
}

function translateKey(label: string): string {
  const k = label.trim().toLowerCase();
  return KEY_TRANSLATIONS[k] ?? label;
}

// Translate a whole-line bullet item (e.g. "1 zip pocket", "Double compartment").
function translateLineItem(line: string): string {
  let s = line.trim();
  const lower = s.toLowerCase();
  if (LINE_TRANSLATIONS[lower] !== undefined) return LINE_TRANSLATIONS[lower];
  // Detect leading count; if present, place it after the Hebrew noun
  // (e.g. "1 zip pocket" → "כיס רוכסן 1") and pick singular vs plural Hebrew.
  const countMatch = /^(\d{1,2})\s+(.+)$/.exec(s);
  let suffix = "";
  let singular = false;
  if (countMatch) {
    const n = parseInt(countMatch[1], 10);
    suffix = ` ${n}`;
    singular = n === 1;
    s = countMatch[2];
  }
  let translated = translateNouns(s, singular);
  translated = translated.replace(/\bwith\b/gi, "עם");
  return (translated + suffix).trim();
}

// ─── Junk filter ─────────────────────────────────────────────────────────────

function isJunkLine(line: string): boolean {
  if (!line || line.length < 2 || line.length > 200) return true;
  if (/^https?:\/\//i.test(line)) return true;
  if (/^designed in /i.test(line)) return true;
  if (/^made in /i.test(line)) return true;
  if (/^\s*warranty\b/i.test(line)) return true;
  if (/[€$£¥₪]\s*\d/.test(line)) return true;
  if (/instagram|facebook|twitter|youtube|tiktok|pinterest|newsletter|subscribe|follow us|shop now/i.test(line)) return true;
  if (/^k-ring logoed$/i.test(line)) return true;
  if (/^tone-on-tone printed lettering logo$/i.test(line)) return true;
  return false;
}

// ─── Body HTML structured parser ─────────────────────────────────────────────

// Lowercase keys whose values belong on the EXTERIOR side.
const EXT_KEYS = new Set([
  "closure", "shoulder strap", "shoulder straps", "shoulder strap length", "strap", "strap length",
  "handles", "handle", "handle system", "lock", "accessories",
]);

// Lowercase keys whose values belong on the INTERIOR side.
const INT_KEYS = new Set(["lining"]);

// Lowercase keys that belong under composition/material.
const COMP_KEYS = new Set(["material", "materials", "composition"]);

// Lowercase keys that are dimensional facts.
const DIM_KEYS = new Set(["size", "weight", "dimensions", "volume", "capacity", "length"]);

interface ParsedBody {
  exterior: SpecItem[];
  interior: SpecItem[];
  composition: SpecItem[];
  dimensions: SpecItem[];
}

function parseStructuredBody(html: string): ParsedBody {
  const lines = splitLines(html);
  const out: ParsedBody = { exterior: [], interior: [], composition: [], dimensions: [] };
  let bullet: "exterior" | "interior" | null = null;

  const pushKeyValue = (key: string, value: string) => {
    const k = key.trim().toLowerCase();
    const trimmedValue = value.trim();
    if (!trimmedValue) return;

    // Length-style keys → extract single cm value. Belong on EXTERIOR (strap)
    // even though they look dimensional.
    if (k === "shoulder strap length" || k === "strap length" || k === "length") {
      const len = extractLengthCm(trimmedValue);
      if (len) out.exterior.push({ label: translateKey(key), value: len });
      return;
    }

    // "Shoulder Straps" with plural — extract length if embedded
    if (k === "shoulder straps") {
      const v = translateValue(trimmedValue);
      out.exterior.push({ label: translateKey(key), value: v });
      const len = extractLengthCm(trimmedValue);
      if (len && !out.exterior.some((it) => it.label === "אורך רצועה" || it.label === "אורך רצועת כתף")) {
        out.exterior.push({ label: "אורך רצועת כתף", value: len });
      }
      return;
    }

    if (DIM_KEYS.has(k)) {
      // For dimension keys, prefer cm/kg parsed value over translated text.
      let displayValue: string | null = null;
      if (k === "weight") displayValue = extractWeightKg(trimmedValue);
      else if (k === "size" || k === "dimensions") displayValue = extractDimensionsCm(trimmedValue);
      else if (k === "volume" || k === "capacity")
        displayValue = extractVolumeLiters(trimmedValue) ?? extractLengthCm(trimmedValue);
      // If size/dimensions has no actual cm measurement, drop it — "Size: Expandable Cabin" is noise.
      if (!displayValue) return;
      out.dimensions.push({ label: translateKey(key), value: displayValue });
      return;
    }
    if (EXT_KEYS.has(k)) {
      const v = translateValue(trimmedValue);
      out.exterior.push({ label: translateKey(key), value: v });
      // Also detect strap length embedded inside the value (e.g. "Jacquard ... 135 cm")
      const len = extractLengthCm(trimmedValue);
      if (len && (k === "shoulder strap" || k === "strap")) {
        if (!out.exterior.some((it) => it.label === "אורך רצועה" || it.label === "אורך רצועת כתף")) {
          out.exterior.push({ label: "אורך רצועה", value: len });
        }
      }
      return;
    }
    if (INT_KEYS.has(k)) {
      out.interior.push({ label: translateKey(key), value: translateValue(trimmedValue) });
      return;
    }
    if (COMP_KEYS.has(k)) {
      out.composition.push({ label: translateKey(key), value: translateValue(trimmedValue) });
      return;
    }
    // Unknown key — ignore (Type, Dual Portability, etc.)
  };

  for (const raw of lines) {
    if (isJunkLine(raw)) continue;

    // Section markers
    if (/^exterior:?$/i.test(raw)) { bullet = "exterior"; continue; }
    if (/^interior:?$/i.test(raw)) { bullet = "interior"; continue; }

    // Bullet items
    if (/^[-•*]\s*/.test(raw)) {
      const text = raw.replace(/^[-•*]\s*/, "").trim();
      if (!text) continue;
      const translated = translateLineItem(text);
      if (!translated) continue;
      if (bullet === "interior") out.interior.push({ label: translated, value: "" });
      else out.exterior.push({ label: translated, value: "" });
      continue;
    }

    // Key: value lines
    const kvMatch = /^([A-Za-z][A-Za-z ]{1,40}?):\s*(.+)$/.exec(raw);
    if (kvMatch) {
      pushKeyValue(kvMatch[1], kvMatch[2]);
      continue;
    }

    // Bare line — only keep if it's a known full-line translation (e.g. "Italian leather")
    const lower = raw.toLowerCase();
    if (LINE_TRANSLATIONS[lower] !== undefined) {
      const t = LINE_TRANSLATIONS[lower];
      if (!t) continue;
      // Italian leather / Calf leather etc. → interior (lining-like) if Interior section active, else composition
      if (bullet === "interior") out.interior.push({ label: t, value: "" });
      else out.composition.push({ label: t, value: "" });
    }
  }

  return out;
}

// ─── Mandarina accordion parser (page-level) ─────────────────────────────────

interface AccordionBlock {
  heading: string;
  content: string;
}

function parseAccordions(pageHtml: string): AccordionBlock[] {
  const blocks: AccordionBlock[] = [];
  const detailsRe = /<details[^>]*>([\s\S]*?)<\/details>/gi;
  let m: RegExpExecArray | null;
  while ((m = detailsRe.exec(pageHtml)) !== null) {
    const inner = m[1];
    const sumMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
    if (!sumMatch) continue;
    // Mandarina's theme wraps content in .accordion__content; other themes
    // (Bric's) don't — fall back to everything after the summary. The capture
    // is GREEDY (to the last </div>) because the content div can contain nested
    // divs (Bric's per-size spec blocks) that a lazy match would truncate.
    const contentMatch = /<div[^>]*class="[^"]*accordion__content[^"]*"[^>]*>([\s\S]*)<\/div>/i.exec(inner);
    const content = contentMatch?.[1] ?? inner.slice(sumMatch.index + sumMatch[0].length);
    blocks.push({
      heading: clean(sumMatch[1]).toLowerCase(),
      content,
    });
  }
  return blocks;
}

function pickAccordion(blocks: AccordionBlock[], aliases: string[]): string | null {
  // Exact heading match wins (e.g. Bric's "size and features" alias must beat
  // the substring pass, where a nav accordion like "shop by size" would match
  // first purely by page order).
  for (const b of blocks) {
    for (const alias of aliases) {
      if (b.heading === alias.toLowerCase()) return b.content;
    }
  }
  for (const b of blocks) {
    // Navigation menus are also <details> accordions ("SHOP BY SIZE",
    // "SHOP BY MATERIAL") — never treat them as product spec sections.
    if (b.heading.includes("shop")) continue;
    for (const alias of aliases) {
      if (b.heading.includes(alias.toLowerCase())) return b.content;
    }
  }
  return null;
}

// ─── Dimensions/Composition extractors (accordion content) ───────────────────

function extractFromDimensionsAccordion(content: string): SpecItem[] {
  const text = clean(content);
  const items: SpecItem[] = [];

  // Mandarina sometimes mis-labels cm/inch (e.g. "8,7x11,0x4,7 cm - 22x28x12 inc"
  // for a crossbody where the bag is actually 22×28×12 cm). Compare the cm and
  // inch triples — true cm value should be ~2.54× the inch value. If cm < inch,
  // the labels are swapped and the inch values are the real centimeters.
  const cmRe = /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*cm\b/i;
  const incRe = /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(?:inc|inches?|in)\b/i;
  const cmMatch = cmRe.exec(text);
  const incMatch = incRe.exec(text);
  let dim: string | null = null;
  if (cmMatch && incMatch) {
    const cmFirst = parseFloat(normalizeNum(cmMatch[1]));
    const incFirst = parseFloat(normalizeNum(incMatch[1]));
    const swap = cmFirst > 0 && incFirst > 0 && cmFirst < incFirst;
    const src = swap ? incMatch : cmMatch;
    dim = `${normalizeNum(src[1])} × ${normalizeNum(src[2])} × ${normalizeNum(src[3])} ס"מ`;
  } else if (cmMatch) {
    dim = `${normalizeNum(cmMatch[1])} × ${normalizeNum(cmMatch[2])} × ${normalizeNum(cmMatch[3])} ס"מ`;
  } else if (incMatch) {
    // Only inches present — convert
    const toCm = (s: string) => Math.round(parseFloat(normalizeNum(s)) * 2.54 * 10) / 10;
    dim = `${toCm(incMatch[1])} × ${toCm(incMatch[2])} × ${toCm(incMatch[3])} ס"מ`;
  } else {
    // Bric's `14" w x 21" h x 9" d` inch format
    dim = extractDimensionsInchesWHD(text);
  }

  const kg = extractWeightKg(text) ?? extractWeightLbs(text);
  if (kg) items.push({ label: "משקל", value: kg });
  if (dim) items.push({ label: "מידות", value: dim });
  const volume = extractVolumeLiters(text);
  if (volume) items.push({ label: "נפח", value: volume });
  return items;
}

function extractFromCompositionAccordion(content: string): SpecItem[] {
  const lines = splitLines(content);
  const items: SpecItem[] = [];
  for (const raw of lines) {
    if (isJunkLine(raw)) continue;
    const translated = translateValue(raw);
    if (!translated) continue;
    items.push({ label: translated, value: "" });
  }
  return items;
}

// ─── Color extraction from page HTML (Shopify variant pattern) ────────────────

const COLOR_NAME_MAP: Record<string, string> = {
  black: "שחור", white: "לבן", red: "אדום", blue: "כחול", green: "ירוק",
  yellow: "צהוב", orange: "כתום", purple: "סגול", pink: "ורוד", brown: "חום",
  grey: "אפור", gray: "אפור", navy: "נייבי", beige: "בז'", taupe: "טאופ",
  camel: "גמל", tan: "שזוף", khaki: "חאקי", ivory: "שנהב", cream: "קרם",
  silver: "כסף", gold: "זהב", steel: "פלדה", pirite: "פיריט", diva: "דיווה",
  stone: "אבן", sand: "חול", teal: "טיל", wine: "יין", bordeaux: "בורדו",
  burgundy: "בורגונדי", latte: "לאטה", vanilla: "וניל", forest: "יער",
  sage: "מרווה", coral: "אלמוג", rust: "חלודה", terracotta: "טרקוטה",
  mustard: "חרדל", olive: "זית", cobalt: "קובלט", turquoise: "טורקיז",
  lilac: "לילך", lavender: "לבנדר", rose: "ורד", copper: "נחושת",
  bronze: "ברונזה", charcoal: "פחם", "dress blue": "כחול",
  ocean: "אוקיינוס", cappuccino: "קפוצ'ינו", eucalyptus: "אקליפטוס",
  espresso: "אספרסו", "fire red": "אדום אש", grafite: "גרפיט",
};

const COLOR_HEX_MAP: Record<string, string> = {
  black: "#1a1a1a", white: "#f5f5f5", red: "#cc2222", blue: "#1e4d9c",
  navy: "#1a2d5a", green: "#2d6e3a", yellow: "#f0c040", orange: "#e07020",
  purple: "#6b3fa0", pink: "#e8789a", brown: "#7a4228", grey: "#888888",
  gray: "#888888", beige: "#d4c4a8", taupe: "#8d7966", camel: "#c19a6b",
  tan: "#c4a264", khaki: "#8e8060", ivory: "#fffff0", cream: "#fffdd0",
  silver: "#c0c0c0", gold: "#d4a017", steel: "#6e7b8b", pirite: "#6e7060",
  diva: "#a52828", stone: "#9e9e8e", sand: "#d4b896", teal: "#2e8b8b",
  wine: "#6b1a2c", bordeaux: "#7c1c2c", burgundy: "#800020", latte: "#c4a882",
  vanilla: "#f3e5ab", coral: "#e07060", rust: "#b74e1a", mustard: "#c8a028",
  olive: "#6b7028", cobalt: "#0050a0", charcoal: "#3c3c3c",
  ocean: "#1f4e6b", cappuccino: "#a58a6f", eucalyptus: "#6f8f7f",
  espresso: "#4a342a", "fire red": "#c22b2b", grafite: "#555555",
};

function translateColorName(name: string): string {
  const key = name.trim().toLowerCase();
  if (COLOR_NAME_MAP[key]) return COLOR_NAME_MAP[key];
  const words = key.split(/\s+/);
  const translated = words.map((w) => COLOR_NAME_MAP[w] ?? w).join(" ");
  return translated !== key ? translated : name;
}

function colorToHex(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (COLOR_HEX_MAP[key]) return COLOR_HEX_MAP[key];
  for (const word of key.split(/\s+/)) {
    if (COLOR_HEX_MAP[word]) return COLOR_HEX_MAP[word];
  }
  return null;
}

function extractColorsFromPageHtml(html: string): ColorSwatch[] {
  const swatches: ColorSwatch[] = [];
  let colorOptionIndex = 0;
  const optionMatch = /"options"\s*:\s*\[([^\]]{0,500})\]/i.exec(html);
  if (optionMatch) {
    const opts = optionMatch[1].toLowerCase();
    const colorIdx = opts.indexOf('"color"');
    const colourIdx = opts.indexOf('"colour"');
    if (colorIdx >= 0 || colourIdx >= 0) {
      const before = opts.slice(0, Math.max(colorIdx, colourIdx));
      colorOptionIndex = (before.match(/"/g) ?? []).length / 2;
    }
  }
  const seenColors = new Set<string>();
  const variantOptionKey = colorOptionIndex === 0 ? "option1" : colorOptionIndex === 1 ? "option2" : "option3";
  const variantRegex = new RegExp(`"${variantOptionKey}"\\s*:\\s*"([^"]+)"`, "gi");
  let variantMatch: RegExpExecArray | null;
  while ((variantMatch = variantRegex.exec(html)) !== null) {
    const colorName = variantMatch[1].trim();
    if (!colorName || seenColors.has(colorName.toLowerCase())) continue;
    // Single-variant Shopify products expose "Default Title" as option1.
    if (/^default title$/i.test(colorName)) continue;
    seenColors.add(colorName.toLowerCase());
    swatches.push({
      name: translateColorName(colorName),
      hex: colorToHex(colorName),
      swatchUrl: null,
    });
  }
  return swatches;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  // Approved manufacturer HTTPS hosts only; redirects re-validated (GAL-025).
  const res = await safeSourceFetch(url, {
    headers: DEFAULT_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(14000),
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.text();
}

function buildShopifyJsonUrls(sourceUrl: string): string[] {
  try {
    const url = new URL(sourceUrl);
    const urls = new Set<string>();
    urls.add(`${url.origin}${url.pathname.replace(/\/$/, "")}.json`);
    const parts = url.pathname.split("/").filter(Boolean);
    const productsIdx = parts.lastIndexOf("products");
    if (productsIdx !== -1 && parts[productsIdx + 1]) {
      const handle = parts[productsIdx + 1].split("?")[0];
      urls.add(`${url.origin}/products/${handle}.json`);
    }
    return [...urls];
  } catch {
    return [];
  }
}

interface ShopifyProduct {
  body_html?: string;
  options?: Array<{ name?: string; values?: string[] }>;
}

async function tryShopifyProductData(sourceUrl: string): Promise<{ bodyHtml: string | null; colors: ColorSwatch[] }> {
  for (const jsonUrl of buildShopifyJsonUrls(sourceUrl)) {
    try {
      const res = await safeSourceFetch(jsonUrl, {
        headers: { ...DEFAULT_HEADERS, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { product?: ShopifyProduct };
      const product = data?.product;
      if (!product) continue;
      const colors: ColorSwatch[] = [];
      const colorOption = product.options?.find((o) => /colou?r/i.test(o?.name ?? ""));
      if (colorOption?.values?.length) {
        const seen = new Set<string>();
        for (const value of colorOption.values) {
          const v = String(value).trim();
          const key = v.toLowerCase();
          if (!v || seen.has(key)) continue;
          seen.add(key);
          colors.push({ name: translateColorName(v), hex: colorToHex(v), swatchUrl: null });
        }
      }
      return { bodyHtml: product.body_html ?? null, colors };
    } catch {
      continue;
    }
  }
  return { bodyHtml: null, colors: [] };
}

// ─── Google Translate fallback (anything left in English) ────────────────────

// Letters-only test: an item that still contains [a-zA-Z] after the dictionary
// pass needs a runtime translation. We preserve common technical tokens
// (TSA, K-RING, etc.) by skipping pure-acronym strings.
function needsTranslation(text: string): boolean {
  if (!/[a-zA-Z]/.test(text)) return false;
  // Pure acronym / single uppercase token like "TSA" — keep as is.
  if (/^[A-Z][A-Z0-9-]{1,6}$/.test(text.trim())) return false;
  return true;
}

// Retained but disconnected (GAL-009): no code path may call these.
async function translateOne(text: string): Promise<string> {
  try {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=he&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      cache: "force-cache",
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": DEFAULT_HEADERS["user-agent"] },
    });
    if (!res.ok) return text;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || !Array.isArray(data[0])) return text;
    const segs = data[0] as unknown[];
    const out = segs
      .map((s) => (Array.isArray(s) ? String(s[0] ?? "") : ""))
      .join("")
      .trim();
    return out || text;
  } catch {
    return text;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function batchTranslateSpecs(specs: SpecSection[]): Promise<void> {
  const unique = new Set<string>();
  for (const section of specs) {
    for (const item of section.items) {
      if (needsTranslation(item.label)) unique.add(item.label);
      if (item.value && needsTranslation(item.value)) unique.add(item.value);
    }
  }
  if (unique.size === 0) return;
  const entries = [...unique];
  const translations = await Promise.all(entries.map((s) => translateOne(s)));
  const map = new Map<string, string>();
  entries.forEach((src, i) => map.set(src, translations[i]));
  for (const section of specs) {
    for (const item of section.items) {
      if (map.has(item.label)) item.label = map.get(item.label)!;
      if (item.value && map.has(item.value)) item.value = map.get(item.value)!;
    }
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────────

const SECTION_ORDER = ["חיצוני", "פנימי", "הרכב", "מידות"];

function dedupeItems(items: SpecItem[]): SpecItem[] {
  const seen = new Set<string>();
  const out: SpecItem[] = [];
  for (const it of items) {
    const key = `${it.label}|${it.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export async function fetchProductDetails(sourceUrl: string): Promise<ProductDetails> {
  // Only approved manufacturer sources are fetched; anything else yields no
  // details, so callers keep their existing cached specs (GAL-025).
  if (!approvedSourceUrl(sourceUrl)) {
    return { specs: [], colors: [] };
  }

  const [shopify, pageHtml] = await Promise.all([
    tryShopifyProductData(sourceUrl),
    fetchHtml(sourceUrl).catch(() => ""),
  ]);

  const bodyHtml = shopify.bodyHtml ?? "";
  const accordions = pageHtml ? parseAccordions(pageHtml) : [];

  // Description accordion content is identical to body_html in practice;
  // body_html is the cleaner source so prefer it.
  const descBody = bodyHtml || pickAccordion(accordions, ["description"]) || "";
  const body = descBody ? parseStructuredBody(descBody) : { exterior: [], interior: [], composition: [], dimensions: [] };

  // Composition accordion (e.g. "100% Polycarbonate", "100% Polyester")
  const compContent = pickAccordion(accordions, ["composition", "materials", "material"]);
  if (compContent) body.composition.push(...extractFromCompositionAccordion(compContent));

  // Dimensions accordion (e.g. "55x40x20 cm - ... - 2,4 KG / ...";
  // Bric's uses a "Size and Features" accordion with inch/lbs values)
  const dimContent = pickAccordion(accordions, [
    "size and features",
    "dimensions",
    "measurements",
    "size",
  ]);
  if (dimContent) body.dimensions.push(...extractFromDimensionsAccordion(dimContent));

  // Last-resort capture. Capacity and composition are not always inside the
  // accordions we name above — Mandarina publishes a litre volume that never
  // reached any parsed block, so every Mandarina product ended up with an empty
  // נפח while Bric's (which states it in its dimensions block) came out fine.
  // Scan the product's OWN accordions plus its description; NOT the whole page,
  // which would pick up figures from related-product blocks.
  const ownText = `${accordions.map((b) => clean(b.content)).join(" \n ")} \n ${clean(descBody)}`;
  if (!body.dimensions.some((it) => it.label === "נפח")) {
    const volume = extractVolumeLiters(ownText);
    if (volume) body.dimensions.push({ label: "נפח", value: volume });
  }
  if (body.composition.length === 0) {
    const material = extractMaterialWord(ownText);
    if (material) body.composition.push({ label: "חומר", value: material });
  }

  const sectionItems: Record<string, SpecItem[]> = {
    "חיצוני": dedupeItems(body.exterior),
    "פנימי": dedupeItems(body.interior),
    "הרכב": dedupeItems(body.composition),
    "מידות": dedupeItems(body.dimensions),
  };

  const specs: SpecSection[] = SECTION_ORDER
    .filter((h) => sectionItems[h].length > 0)
    .map((h) => ({ heading: h, items: sectionItems[h] }));

  // GAL-009: no automatic machine translation. Specs keep the manufacturer's
  // wording (plus the fixed dictionary above); reviewed Hebrew copy is applied
  // per exact SKU elsewhere. The retained translation helpers must never be
  // called from here, import, warm-up, save or sync
  // (tests/no-machine-translation.test.mjs).

  const colors = shopify.colors.length > 0 ? shopify.colors : extractColorsFromPageHtml(pageHtml);

  return { specs, colors };
}
