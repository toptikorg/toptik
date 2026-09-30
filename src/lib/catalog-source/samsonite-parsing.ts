import type { SourceProduct } from "./types";

export const SAMSONITE_SOURCE_HOSTS = [
  "www.samsonite.co.uk",
  "www.samsonite.com.au",
  "www.samsonite.com.sg",
  "www.samsonite.de",
  "www.samsonite.fi",
  "www.samsonite.se",
] as const;

export function normalizeSamsoniteSku(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^\d{6}[A-Z0-9]{4}$/.test(compact)
    ? `${compact.slice(0, 6)}-${compact.slice(6)}`
    : null;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function plainText(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function skuFromProduct(product: Record<string, unknown>): string | null {
  const identities = [product.sku, product.mpn, product.productID]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map(normalizeSamsoniteSku)
    .filter((candidate): candidate is string => candidate !== null);
  if (identities.length === 0 || new Set(identities).size !== 1) return null;
  return identities[0];
}

function collectProducts(value: unknown, output: Record<string, unknown>[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectProducts(entry, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
    output.push(record);
  }
  Object.values(record).forEach((entry) => collectProducts(entry, output));
}

export function extractProductSchema(html: string, expectedSku: string): Record<string, unknown> | null {
  const expected = normalizeSamsoniteSku(expectedSku);
  if (!expected) return null;
  const scripts = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const products: Record<string, unknown>[] = [];
  let match: RegExpExecArray | null;
  while ((match = scripts.exec(html)) !== null) {
    try {
      collectProducts(JSON.parse(match[1].trim()), products);
    } catch {
      // Ignore malformed JSON-LD and keep searching other blocks.
    }
  }
  return products.find((product) => skuFromProduct(product) === expected) ?? null;
}

export function extractSamsoniteSearchLinks(html: string, baseUrl: string, sku: string): string[] {
  const canonicalSku = normalizeSamsoniteSku(sku);
  if (!canonicalSku) return [];
  const escapedSku = canonicalSku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const finalSegment = new RegExp(`(?:^|/)${escapedSku}\\.html$`, "i");
  const host = new URL(baseUrl).hostname.toLowerCase();
  const links = new Set<string>();
  const hrefPattern = /\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    try {
      const target = new URL(decodeHtml(match[2]), baseUrl);
      if (target.protocol !== "https:" || target.hostname.toLowerCase() !== host) continue;
      if (finalSegment.test(target.pathname)) {
        target.search = "";
        target.hash = "";
        links.add(target.toString());
      }
    } catch {
      // Ignore malformed or non-URL anchors.
    }
  }
  return [...links];
}

export function extractSamsoniteImageUrls(html: string, pageUrl: string): string[] {
  const pageHost = new URL(pageUrl).hostname.toLowerCase();
  const imageTags = /<img\b[^>]*>/gi;
  const attrs = /\b(?:src|data-src|srcset|data-srcset)\s*=\s*(["'])(.*?)\1/gi;
  const urls = new Map<string, string>();
  let tag: RegExpExecArray | null;
  while ((tag = imageTags.exec(html)) !== null) {
    attrs.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = attrs.exec(tag[0])) !== null) {
      const candidates = decodeHtml(attr[2]).match(/https?:\/\/[^\s,]+/gi) ?? [];
      for (const candidate of candidates) {
        try {
          const target = new URL(candidate);
          if (target.hostname.toLowerCase() !== pageHost) continue;
          if (!target.pathname.includes("/Sites-samsonite-product-catalog/")) continue;
          if (!/\.(?:jpe?g|png|webp)$/i.test(target.pathname)) continue;
          target.hash = "";
          if (!urls.has(target.pathname)) urls.set(target.pathname, target.toString());
        } catch {
          // Ignore malformed images and placeholders.
        }
      }
    }
  }
  return [...urls.values()];
}

function firstText(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      const text = plainText(match[1]);
      if (text) return text;
    }
  }
  return null;
}

export function parseSamsoniteProductPage(
  html: string,
  pageUrl: string,
  expectedSku: string,
): SourceProduct {
  const canonicalSku = normalizeSamsoniteSku(expectedSku);
  if (!canonicalSku) throw new Error("Invalid Samsonite manufacturer SKU");
  const product = extractProductSchema(html, canonicalSku);
  if (!product) throw new Error("Official Samsonite page did not confirm the exact SKU");

  const imageUrls = extractSamsoniteImageUrls(html, pageUrl);
  if (imageUrls.length === 0) throw new Error("No exact-product images found on the Samsonite page");

  const title = firstText(html, [
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i,
  ]) ?? (typeof product.name === "string" ? product.name.trim() : "");
  if (!title) throw new Error("Official Samsonite page did not provide a product title");

  const description = firstText(html, [
    /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)/i,
    /<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i,
  ]);

  return {
    catalogNumber: canonicalSku,
    title,
    description: description && !/\[(?:brand|product)\]/i.test(description) ? description : null,
    imageUrls,
    sourceUrl: pageUrl,
    color: typeof product.color === "string" ? product.color : null,
  };
}
