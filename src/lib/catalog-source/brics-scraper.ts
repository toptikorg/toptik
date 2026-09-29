import { CatalogSourceProvider, SourceColorVariant, SourceProduct } from "@/lib/catalog-source/types";

const BRICS_BASE_URL = "https://bricstore.com";
// Secondary Bric's source: an official stockist whose Shopify catalog carries
// Bric's models that bricstore.com doesn't list (e.g. BXL38124101). Product
// images there use the SAME official Bric's file naming (BXL38124.101.01.jpg),
// and each colour is its own single-variant product.
const HUNT_BASE_URL = "https://huntleather.com";
const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
};
const MAX_IMPORTED_IMAGES = 20;
const MAX_CATALOG_PAGES = 6;
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;

type ShopifyOption = {
  name: string;
  position: number;
  values: string[];
};

type ShopifyVariant = {
  id?: number;
  sku?: string | null;
  title?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  // Shopify's authoritative per-colour image for this variant.
  featured_image?: { src?: string | null } | null;
};

type ShopifyImage = {
  src: string;
  position?: number;
  // Variant ids this image is explicitly assigned to (Shopify colour linkage).
  variant_ids?: number[];
};

type ShopifyProduct = {
  title: string;
  handle: string;
  vendor?: string | null;
  body_html?: string | null;
  options?: ShopifyOption[];
  variants?: ShopifyVariant[];
  images?: ShopifyImage[];
};

let catalogCache: { products: ShopifyProduct[]; fetchedAt: number } | null = null;
let huntCatalogCache: { products: ShopifyProduct[]; fetchedAt: number } | null = null;

function normalizeSku(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function stripHtml(input: string) {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url: string) {
  const res = await fetch(url, {
    headers: DEFAULT_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Brics request failed (${res.status}) for ${url}`);
  }
  return res;
}

async function fetchCatalogProducts(): Promise<ShopifyProduct[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.products;
  }

  const products: ShopifyProduct[] = [];
  for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
    const res = await fetchWithTimeout(
      `${BRICS_BASE_URL}/products.json?limit=250&page=${page}`,
    );
    const data = (await res.json()) as { products?: ShopifyProduct[] };
    const batch = data.products ?? [];
    products.push(...batch);
    if (batch.length < 250) break;
  }

  if (products.length > 0) {
    catalogCache = { products, fetchedAt: Date.now() };
  }
  return products;
}

async function fetchHuntCatalogProducts(): Promise<ShopifyProduct[]> {
  if (huntCatalogCache && Date.now() - huntCatalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return huntCatalogCache.products;
  }

  const products: ShopifyProduct[] = [];
  for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
    const res = await fetchWithTimeout(`${HUNT_BASE_URL}/products.json?limit=250&page=${page}`);
    const data = (await res.json()) as { products?: ShopifyProduct[] };
    const batch = data.products ?? [];
    products.push(...batch);
    if (batch.length < 250) break;
  }

  if (products.length > 0) {
    huntCatalogCache = { products, fetchedAt: Date.now() };
  }
  return products;
}

// Hunt titles end with the colour ("Bric's X-Travel Pilot Cabin Case - Black").
function huntColorFromTitle(title: string): string | null {
  const match = title.match(/-\s*([^-]+)\s*$/);
  return match ? match[1].trim() : null;
}

// Bric's SKU convention: 8-char base (model) + 3-char colour code, with or
// without a separating dot (BXL38124.101 / BXL38124101).
function bricsBaseSku(sku: string) {
  return normalizeSku(sku).slice(0, 8);
}

function bricsColorCode(sku: string): string | null {
  const code = normalizeSku(sku).slice(8, 11);
  return code.length === 3 ? code : null;
}

function huntSpecsFromBody(bodyText: string): SpecBlock {
  const dims =
    /(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*cm/i.exec(
      bodyText,
    );
  const kg = /(\d+(?:[.,]\d+)?)\s*kg\b/i.exec(bodyText);
  return {
    dimensions: dims
      ? `${dims[1].replace(",", ".")}x${dims[2].replace(",", ".")}x${dims[3].replace(",", ".")} cm`
      : null,
    weight: kg ? `${kg[1].replace(",", ".")} kg` : null,
  };
}

// Colour-sibling products on Hunt: same 8-char SKU base, different colour code.
function huntColorSiblings(products: ShopifyProduct[], baseSku: string) {
  return products.filter((product) =>
    (product.variants ?? []).some((variant) => {
      const sku = variant.sku?.trim();
      return Boolean(sku && bricsBaseSku(sku) === baseSku);
    }),
  );
}

function findProductBySku(products: ShopifyProduct[], catalogNumber: string) {
  const target = normalizeSku(catalogNumber);
  if (!target) return null;

  let prefixMatch: { product: ShopifyProduct; variant: ShopifyVariant } | null = null;

  for (const product of products) {
    for (const variant of product.variants ?? []) {
      const sku = variant.sku?.trim();
      if (!sku) continue;
      const normalized = normalizeSku(sku);
      if (normalized === target) {
        return { product, variant };
      }
      if (!prefixMatch && (normalized.startsWith(target) || target.startsWith(normalized))) {
        prefixMatch = { product, variant };
      }
    }
  }

  return prefixMatch;
}

function findProductByHandle(products: ShopifyProduct[], handle: string) {
  return products.find((product) => product.handle === handle) ?? null;
}

function handleFromSourceUrl(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const match = sourceUrl.match(/\/products\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function optionIndex(product: ShopifyProduct, optionName: string) {
  return (product.options ?? []).findIndex(
    (option) => option.name.toLowerCase() === optionName.toLowerCase(),
  );
}

function optionValueForVariant(
  product: ShopifyProduct,
  variant: ShopifyVariant,
  optionName: string,
) {
  const index = optionIndex(product, optionName);
  if (index === -1) return null;
  const key = `option${index + 1}` as "option1" | "option2" | "option3";
  return variant[key] ?? null;
}

function optionValues(product: ShopifyProduct, optionName: string) {
  const option = (product.options ?? []).find(
    (entry) => entry.name.toLowerCase() === optionName.toLowerCase(),
  );
  return option?.values ?? [];
}

// SKU suffix = the colour code (BOE58117·`050`).
function colorCodeFromSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const segments = sku.split(".");
  return segments.length > 1 ? segments[segments.length - 1].toUpperCase() : null;
}

function imageFileName(url: string) {
  const [withoutQuery] = url.split("?");
  const segments = withoutQuery.split("/");
  return (segments[segments.length - 1] ?? "").toUpperCase();
}

// Resolve the images that belong to THIS colour variant using Shopify's own
// linkage — never a mixed-colour fallback. Order:
//   1. the variant's featured_image (authoritative per-colour cover),
//   2. images explicitly assigned to the variant id (Shopify colour linkage),
//   3. images whose filename is prefixed with the exact SKU (Bric's per-colour
//      gallery naming `<baseSku>.<colorCode>.<view>.jpg`) — a full rotation set
//      when the store names files that way.
// If nothing matches it returns [] rather than the whole (multi-colour) gallery,
// so a wrong colour is never shown. This fixes SKUs whose files are named
// `p_<uuid>.jpg` / `download.jpg` (no SKU in the name), which previously fell
// back to ALL images and made every colour share one cover.
function resolveVariantImages(product: ShopifyProduct, variant: ShopifyVariant): string[] {
  const isHttp = (src: string) => /^https?:\/\//i.test(src);
  const out: string[] = [];
  const push = (src?: string | null) => {
    if (src && isHttp(src) && !out.includes(src)) out.push(src);
  };

  push(variant.featured_image?.src ?? null);

  if (variant.id != null) {
    for (const image of product.images ?? []) {
      if ((image.variant_ids ?? []).includes(variant.id)) push(image.src);
    }
  }

  const sku = variant.sku?.trim();
  if (sku) {
    const exactPrefix = `${sku.toUpperCase()}.`;
    for (const image of product.images ?? []) {
      if (isHttp(image.src) && imageFileName(image.src).startsWith(exactPrefix)) push(image.src);
    }
  }

  return out;
}

type SpecBlock = {
  dimensions: string | null;
  weight: string | null;
};

function inchesToCm(value: number) {
  return Math.round(value * 2.54);
}

function lbsToKg(value: number) {
  return Math.round(value * 0.45359237 * 10) / 10;
}

function parseSpecBlocks(html: string): SpecBlock[] {
  const text = stripHtml(html);
  const blocks: SpecBlock[] = [];
  const dimensionRegex =
    /Dimensions:\s*([\d.]+)\s*(?:"|in(?:ch(?:es)?)?)?\s*w?\s*[x×]\s*([\d.]+)\s*(?:"|in(?:ch(?:es)?)?)?\s*h?\s*[x×]\s*([\d.]+)\s*(?:"|in(?:ch(?:es)?)?)?\s*d?/gi;

  let match: RegExpExecArray | null = null;
  while ((match = dimensionRegex.exec(text)) !== null) {
    const [w, h, d] = [match[1], match[2], match[3]].map((raw) => Number.parseFloat(raw));
    const dimensions =
      Number.isFinite(w) && Number.isFinite(h) && Number.isFinite(d)
        ? `${inchesToCm(w)}x${inchesToCm(h)}x${inchesToCm(d)} cm`
        : null;

    const tail = text.slice(match.index, match.index + 260);
    const weightMatch = tail.match(/Weight:\s*([\d.]+)\s*(lbs?|kg)/i);
    let weight: string | null = null;
    if (weightMatch) {
      const value = Number.parseFloat(weightMatch[1]);
      if (Number.isFinite(value)) {
        weight = weightMatch[2].toLowerCase().startsWith("kg")
          ? `${value} kg`
          : `${lbsToKg(value)} kg`;
      }
    }

    blocks.push({ dimensions, weight });
  }

  if (blocks.length === 0) {
    const weightMatch = text.match(/Weight:\s*([\d.]+)\s*(lbs?|kg)/i);
    if (weightMatch) {
      const value = Number.parseFloat(weightMatch[1]);
      blocks.push({
        dimensions: null,
        weight: Number.isFinite(value)
          ? weightMatch[2].toLowerCase().startsWith("kg")
            ? `${value} kg`
            : `${lbsToKg(value)} kg`
          : null,
      });
    }
  }

  return blocks;
}

function pickSpecBlock(blocks: SpecBlock[], sizeValues: string[], currentSize: string | null) {
  if (blocks.length === 0) return { dimensions: null, weight: null };
  if (currentSize && sizeValues.length > 1) {
    const sizeIndex = sizeValues.findIndex(
      (value) => value.toLowerCase() === currentSize.toLowerCase(),
    );
    if (sizeIndex >= 0 && sizeIndex < blocks.length) {
      return blocks[sizeIndex];
    }
  }
  return blocks[0];
}

// ─── Colour variant enumeration (same product, per-colour SKUs) ──────────────

export interface BricsColorEnumerationInput {
  sourceUrl: string | null;
  catalogNumber: string | null;
}

// Unlike Mandarina (a separate product page per colour), Bric's keeps every
// colour as a variant of ONE Shopify product, so enumeration is a lookup in the
// already-cached catalog — no extra page fetches.
export async function enumerateBricsColorVariants(
  input: BricsColorEnumerationInput,
): Promise<SourceColorVariant[]> {
  const products = await fetchCatalogProducts().catch(() => [] as ShopifyProduct[]);

  let product: ShopifyProduct | null = null;
  if (input.catalogNumber) {
    product = findProductBySku(products, input.catalogNumber)?.product ?? null;
  }
  if (!product) {
    const handle = handleFromSourceUrl(input.sourceUrl);
    if (handle) product = findProductByHandle(products, handle);
  }
  if (!product) return enumerateHuntColorVariants(input);

  const colorIdx = optionIndex(product, "color");
  if (colorIdx === -1) return [];
  const optionKey = `option${colorIdx + 1}` as "option1" | "option2" | "option3";

  // One Shopify product can bundle MORE than one model (e.g. BXL58139.* and
  // BXL58145.* live on the same page). Only enumerate colours of the SAME base
  // model as the imported catalog number, so a card never shows another model's
  // colours.
  const baseKey = input.catalogNumber ? bricsBaseSku(input.catalogNumber) : "";

  const variants: SourceColorVariant[] = [];
  const seenColors = new Set<string>();

  for (const variant of product.variants ?? []) {
    const colorValue = variant[optionKey]?.trim();
    const sku = variant.sku?.trim();
    if (!colorValue || !sku) continue;
    if (baseKey && bricsBaseSku(sku) !== baseKey) continue;
    const colorKey = colorValue.toLowerCase();
    if (seenColors.has(colorKey)) continue;

    const imageUrls = resolveVariantImages(product, variant).slice(0, MAX_IMPORTED_IMAGES);
    if (imageUrls.length === 0) continue;

    seenColors.add(colorKey);
    const colorCode = colorCodeFromSku(sku);
    variants.push({
      // The maker's complete colour value, casing kept (source value, GAL-009).
      colorWord: colorValue,
      colorCode,
      title: `${product.title} ${colorValue}`,
      catalogNumber: sku.toUpperCase(),
      sourceUrl: `${BRICS_BASE_URL}/products/${product.handle}${variant.id ? `?variant=${variant.id}` : ""}`,
      // Unique per colour; also used as the storage subfolder name, so keep it
      // path-safe.
      handle: `${product.handle}-${(colorCode ?? colorKey).toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
      coverImageUrl: imageUrls[0],
      imageUrls,
    });
  }

  return variants;
}

// Hunt colour enumeration: each colour is a separate single-variant product
// sharing the 8-char SKU base — like Mandarina's sibling pages, but resolvable
// from the already-cached catalog JSON.
async function enumerateHuntColorVariants(
  input: BricsColorEnumerationInput,
): Promise<SourceColorVariant[]> {
  const products = await fetchHuntCatalogProducts().catch(() => [] as ShopifyProduct[]);
  if (products.length === 0) return [];

  let product: ShopifyProduct | null = null;
  if (input.catalogNumber) {
    product = findProductBySku(products, input.catalogNumber)?.product ?? null;
  }
  if (!product) {
    const handle = handleFromSourceUrl(input.sourceUrl);
    if (handle) product = findProductByHandle(products, handle);
  }
  if (!product) return [];

  const primarySku = product.variants?.[0]?.sku?.trim();
  if (!primarySku) return [];

  const variants: SourceColorVariant[] = [];
  const seenColors = new Set<string>();

  for (const sibling of huntColorSiblings(products, bricsBaseSku(primarySku))) {
    const sku = sibling.variants?.[0]?.sku?.trim();
    const colorValue = huntColorFromTitle(sibling.title);
    if (!sku || !colorValue) continue;
    const colorKey = colorValue.toLowerCase();
    if (seenColors.has(colorKey)) continue;

    const imageUrls = (sibling.images ?? [])
      .map((image) => image.src)
      .filter((src) => /^https?:\/\//i.test(src))
      .slice(0, MAX_IMPORTED_IMAGES);
    if (imageUrls.length === 0) continue;

    seenColors.add(colorKey);
    const colorCode = bricsColorCode(sku);
    variants.push({
      colorWord: colorValue,
      colorCode,
      title: sibling.title,
      catalogNumber: normalizeSku(sku),
      sourceUrl: `${HUNT_BASE_URL}/products/${sibling.handle}`,
      handle: `${sibling.handle}-${(colorCode ?? colorKey).toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
      coverImageUrl: imageUrls[0],
      imageUrls,
    });
  }

  return variants;
}

// ─── Import by direct product URL ────────────────────────────────────────────

async function fetchSingleProductJson(baseUrl: string, handle: string): Promise<ShopifyProduct | null> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/products/${handle}.json`);
    const data = (await res.json()) as { product?: ShopifyProduct };
    return data.product ?? null;
  } catch {
    return null;
  }
}

// Build a SourceProduct straight from a bricstore.com or huntleather.com
// product URL (optionally with ?variant=<id> to pick a colour on bricstore).
export async function fetchBricsByUrl(url: string): Promise<SourceProduct | null> {
  const handle = handleFromSourceUrl(url);
  if (!handle) return null;
  const isHunt = url.includes("huntleather.com");
  const baseUrl = isHunt ? HUNT_BASE_URL : BRICS_BASE_URL;

  const product = await fetchSingleProductJson(baseUrl, handle);
  if (!product) return null;

  if (isHunt) {
    return buildHuntSourceProduct(product);
  }

  // bricstore: pick the DISPLAYED colour variant. Priority:
  //   1. ?variant=<id> (what the site puts in the URL when a colour is chosen)
  //   2. a SKU/colour-catalog embedded anywhere in the URL (query/hash/path) —
  //      e.g. a pasted "…spinner?variant=BBG38303.078" or "…spinner#BBG38303078"
  //   3. the first variant that has a SKU
  let variantId: number | null = null;
  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get("variant");
    if (raw && /^\d+$/.test(raw)) variantId = Number.parseInt(raw, 10) || null;
  } catch {
    // keep null
  }
  const variants = product.variants ?? [];
  const urlKey = normalizeSku(decodeURIComponent(url));
  const bySkuInUrl = variants.find((v) => {
    const sku = v.sku?.trim();
    return Boolean(sku && normalizeSku(sku).length >= 8 && urlKey.includes(normalizeSku(sku)));
  });
  const variant =
    (variantId ? variants.find((v) => v.id === variantId) : null) ??
    bySkuInUrl ??
    variants.find((v) => v.sku?.trim()) ??
    variants[0];
  if (!variant?.sku?.trim()) return null;

  return buildBricstoreSourceProduct(product, variant);
}

// ─── Provider ────────────────────────────────────────────────────────────────

// Shared builder for a bricstore.com product+variant → SourceProduct.
async function buildBricstoreSourceProduct(
  product: ShopifyProduct,
  variant: ShopifyVariant,
): Promise<SourceProduct> {
  const variantSku = variant.sku?.trim() || null;
  const sourceUrl = `${BRICS_BASE_URL}/products/${product.handle}`;

  const imageUrls = resolveVariantImages(product, variant).slice(0, MAX_IMPORTED_IMAGES);
  if (imageUrls.length === 0) {
    throw new Error("No product gallery images detected on source page");
  }

  const color = optionValueForVariant(product, variant, "color");
  const availableColors = optionValues(product, "color");
  const sizeValues = optionValues(product, "size");
  const currentSize = optionValueForVariant(product, variant, "size");
  const sizes = sizeValues.map((value) =>
    currentSize && value.toLowerCase() === currentSize.toLowerCase() ? `*${value}` : value,
  );

  let dimensions: string | null = null;
  let weight: string | null = null;
  try {
    const pageRes = await fetchWithTimeout(sourceUrl);
    const pageHtml = await pageRes.text();
    const specBlocks = parseSpecBlocks(pageHtml);
    const spec = pickSpecBlock(specBlocks, sizeValues, currentSize);
    dimensions = spec.dimensions;
    weight = spec.weight;
  } catch {
    // specs are best-effort; the import should not fail because of them
  }

  return {
    catalogNumber: variantSku?.toUpperCase() || normalizeSku(product.handle),
    title: product.title?.trim() || `Bric's ${product.handle}`,
    description: product.body_html ? stripHtml(product.body_html) : null,
    imageUrls,
    sourceUrl,
    color,
    dimensions,
    weight,
    sizes,
    availableColors,
  };
}

// Shared builder for a huntleather.com single-variant product → SourceProduct.
// The full catalog (cached) supplies the colour-sibling list.
async function buildHuntSourceProduct(product: ShopifyProduct): Promise<SourceProduct | null> {
  const variantSku = product.variants?.[0]?.sku?.trim();
  if (!variantSku) return null;
  const sourceUrl = `${HUNT_BASE_URL}/products/${product.handle}`;

  const imageUrls = (product.images ?? [])
    .map((image) => image.src)
    .filter((src) => /^https?:\/\//i.test(src))
    .slice(0, MAX_IMPORTED_IMAGES);
  if (imageUrls.length === 0) {
    return null;
  }

  const color = huntColorFromTitle(product.title);
  const bodyText = product.body_html ? stripHtml(product.body_html) : "";
  const spec = huntSpecsFromBody(bodyText);

  // Available colours = the colour-sibling products of the same SKU base.
  const catalog = await fetchHuntCatalogProducts().catch(() => [] as ShopifyProduct[]);
  const availableColors = huntColorSiblings(catalog, bricsBaseSku(variantSku))
    .map((sibling) => huntColorFromTitle(sibling.title))
    .filter((value): value is string => Boolean(value));

  return {
    catalogNumber: normalizeSku(variantSku),
    title: product.title.replace(/\s*-\s*[^-]+\s*$/, "").trim() || product.title,
    description: bodyText || null,
    imageUrls,
    sourceUrl,
    color,
    dimensions: spec.dimensions,
    weight: spec.weight,
    sizes: [],
    availableColors: [...new Set(availableColors)],
  };
}

export class BricsStoreScraperProvider implements CatalogSourceProvider {
  async fetchByCatalogNumber(catalogNumber: string): Promise<SourceProduct> {
    const normalizedInput = catalogNumber.trim().toUpperCase();
    if (!normalizedInput) {
      throw new Error("Catalog number is required");
    }

    const products = await fetchCatalogProducts().catch(() => [] as ShopifyProduct[]);
    const match = findProductBySku(products, normalizedInput);
    if (!match) {
      // Secondary source: official stockist carrying Bric's models that
      // bricstore.com doesn't list.
      const huntProducts = await fetchHuntCatalogProducts().catch(() => [] as ShopifyProduct[]);
      const huntMatch = findProductBySku(huntProducts, normalizedInput);
      const huntProduct = huntMatch ? await buildHuntSourceProduct(huntMatch.product) : null;
      if (huntProduct) return huntProduct;
      throw new Error("Product not found on Bric's sources (bricstore.com / huntleather.com)");
    }

    return buildBricstoreSourceProduct(match.product, match.variant);
  }
}
