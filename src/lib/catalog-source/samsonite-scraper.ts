import type { CatalogSourceProvider, SourceProduct } from "@/lib/catalog-source/types";
import { approvedSourceUrl } from "@/lib/catalog-source/source-allowlist";
import { safeSourceFetch } from "@/lib/catalog-source/safe-fetch";
import {
  extractSamsoniteSearchLinks,
  normalizeSamsoniteSku,
  parseSamsoniteProductPage,
  SAMSONITE_SOURCE_HOSTS,
} from "@/lib/catalog-source/samsonite-parsing";

const REQUEST_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "cache-control": "no-cache",
};

async function fetchOfficialPage(url: string): Promise<string> {
  const response = await safeSourceFetch(url, {
    headers: REQUEST_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Samsonite request failed (${response.status})`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) throw new Error("Samsonite returned a non-HTML page");
  return response.text();
}

async function fetchFromHost(host: string, sku: string): Promise<SourceProduct | null> {
  const searchUrl = `https://${host}/search/?q=${encodeURIComponent(sku)}`;
  const searchHtml = await fetchOfficialPage(searchUrl);
  const links = extractSamsoniteSearchLinks(searchHtml, searchUrl, sku);

  for (const productUrl of links.slice(0, 5)) {
    const html = await fetchOfficialPage(productUrl);
    try {
      return parseSamsoniteProductPage(html, productUrl, sku);
    } catch {
      // A search result is not proof of product identity. Ignore this result
      // unless its structured product metadata confirms the exact SKU.
    }
  }
  return null;
}

export async function fetchSamsoniteByUrl(rawUrl: string): Promise<SourceProduct | null> {
  const url = approvedSourceUrl(rawUrl);
  if (!url || !SAMSONITE_SOURCE_HOSTS.includes(url.hostname as (typeof SAMSONITE_SOURCE_HOSTS)[number])) {
    throw new Error("Only approved Samsonite manufacturer pages are supported");
  }
  const skuMatch = /\/(\d{6}-[A-Z0-9]{4})\.html$/i.exec(url.pathname);
  const sku = skuMatch ? normalizeSamsoniteSku(skuMatch[1]) : null;
  if (!sku) throw new Error("Samsonite product URL must end with its manufacturer SKU");
  const html = await fetchOfficialPage(url.toString());
  return parseSamsoniteProductPage(html, url.toString(), sku);
}

export class SamsoniteScraperProvider implements CatalogSourceProvider {
  async fetchByCatalogNumber(catalogNumber: string): Promise<SourceProduct> {
    const sku = normalizeSamsoniteSku(catalogNumber);
    if (!sku) throw new Error("Samsonite SKU must contain a six-digit model and four-character colour code");

    const failures: string[] = [];
    for (const host of SAMSONITE_SOURCE_HOSTS) {
      try {
        const product = await fetchFromHost(host, sku);
        if (product) return product;
      } catch (error) {
        failures.push(`${host}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }
    const suffix = failures.length ? ` (${failures.join("; ")})` : "";
    throw new Error(`Exact Samsonite product ${sku} was not found on the approved manufacturer sites${suffix}`);
  }
}
