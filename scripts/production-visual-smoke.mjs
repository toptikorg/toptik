import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://landing.toptik.co.il";
const DEFAULT_STORE_URL = "https://www.toptik.co.il";
const MIN_JOURNAL_IMAGES = 20;
const MIN_CAROUSEL_ITEMS = 300;
const MIN_CAROUSEL_PRODUCT_LINKS = 300;
const MIN_STORE_COLLECTION_PRODUCTS = 8;

export function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');
}

export function extractAttributeValues(html, element, attribute) {
  const expression = new RegExp(`<${element}\\b[^>]*\\b${attribute}="([^"]+)"`, "gi");
  return [...html.matchAll(expression)].map((match) => decodeHtmlAttribute(match[1]));
}

export function assertCarouselTitleTypography(css) {
  for (const selector of [".catalog-card-title", ".product-modal-title"]) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blocks = [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))]
      .map((match) => match[1]);
    if (blocks.length === 0) throw new Error(`Production CSS is missing ${selector}`);
    if (blocks.some((block) => /font-weight\s*:\s*800\b/.test(block))) {
      throw new Error(`${selector} requests unsupported synthetic font weight 800`);
    }
    if (!blocks.some((block) => /font-weight\s*:\s*700\b/.test(block))) {
      throw new Error(`${selector} is not pinned to supported Rubik font weight 700`);
    }
  }
}

export function compareStoreGalleryProductHandles(storeProductUrls, carouselItems) {
  const handleFromUrl = (raw) => {
    try {
      const parts = new URL(raw).pathname.split("/").filter(Boolean);
      return parts[0] === "products" && parts[1] ? decodeURIComponent(parts[1]).toLowerCase() : null;
    } catch { return null; }
  };
  const storeHandles = new Set(storeProductUrls.map(handleFromUrl).filter(Boolean));
  const galleryHandles = new Set(carouselItems.flatMap((item) => {
    const handle = item?.shopifyLink?.isPublished && typeof item.shopifyLink.handle === "string"
      ? item.shopifyLink.handle.trim().toLowerCase()
      : "";
    return handle ? [handle] : [];
  }));
  return {
    storeCount: storeHandles.size,
    galleryLinkedCount: galleryHandles.size,
    missing: [...storeHandles].filter((handle) => !galleryHandles.has(handle)).sort(),
  };
}

function extractXmlLocations(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeHtmlAttribute(match[1]));
}

async function monitoredFetch(url, options = {}) {
  let lastResponse;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResponse = await fetch(url, {
      ...options,
      headers: {
        "user-agent": "TopTik-Production-Monitor/1.0",
        ...options.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (lastResponse.ok) return lastResponse;
    if (![429, 500, 502, 503, 504].includes(lastResponse.status) || attempt === 3) break;
    await lastResponse.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw new Error(`${url} returned HTTP ${lastResponse?.status ?? "unknown"}`);
}

async function fetchText(url) {
  return (await monitoredFetch(url)).text();
}

async function verifyImage(url) {
  let response = await monitoredFetch(url, { method: "HEAD" });
  let contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    response = await monitoredFetch(url, { headers: { range: "bytes=0-1023" } });
    contentType = response.headers.get("content-type") ?? "";
  }
  await response.body?.cancel();
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`${url} returned non-image content type ${contentType || "missing"}`);
  }
}

function absoluteUrl(baseUrl, value) {
  return new URL(value, `${baseUrl}/`).toString();
}

export async function runProductionVisualSmoke(baseUrl = DEFAULT_BASE_URL) {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const storeBase = (process.env.MONITOR_STORE_URL || DEFAULT_STORE_URL).replace(/\/$/, "");
  const journalUrl = `${normalizedBase}/journal`;
  const journalHtml = await fetchText(journalUrl);
  const journalImages = [...new Set(extractAttributeValues(journalHtml, "img", "src"))];
  if (journalImages.length < MIN_JOURNAL_IMAGES) {
    throw new Error(`Journal rendered ${journalImages.length} images, expected at least ${MIN_JOURNAL_IMAGES}`);
  }
  const optimizedImages = journalImages.filter((src) => src.startsWith("/_next/image"));
  if (optimizedImages.length > 0) {
    throw new Error(`Journal routed ${optimizedImages.length} images through the unavailable Next optimizer`);
  }

  const articleLinks = extractAttributeValues(journalHtml, "a", "href").filter((href) => href.startsWith("/journal/"));
  if (articleLinks.length === 0) throw new Error("Journal rendered no article links");
  const articleUrl = absoluteUrl(normalizedBase, articleLinks[0]);
  const articleHtml = await fetchText(articleUrl);
  const articleImages = [...new Set(extractAttributeValues(articleHtml, "img", "src"))];
  if (articleImages.length === 0) throw new Error(`${articleUrl} rendered no images`);
  if (articleImages.some((src) => src.startsWith("/_next/image"))) {
    throw new Error(`${articleUrl} routed an image through the unavailable Next optimizer`);
  }

  const carouselResponse = await monitoredFetch(`${normalizedBase}/api/carousel`);
  const carouselPayload = await carouselResponse.json();
  if (!Array.isArray(carouselPayload.items) || carouselPayload.items.length < MIN_CAROUSEL_ITEMS) {
    throw new Error(`Carousel returned ${carouselPayload.items?.length ?? 0} items, expected at least ${MIN_CAROUSEL_ITEMS}`);
  }

  const carouselHtml = await fetchText(`${normalizedBase}/carousel`);
  const carouselStylesheets = [...new Set(
    extractAttributeValues(carouselHtml, "link", "href").filter((href) => href.includes("/_next/static/css/")),
  )];
  if (carouselStylesheets.length === 0) throw new Error("Carousel rendered without a production stylesheet");
  const carouselCss = (await Promise.all(
    carouselStylesheets.map((href) => fetchText(absoluteUrl(normalizedBase, href))),
  )).join("\n");
  assertCarouselTitleTypography(carouselCss);
  const carouselProductLinks = [...new Set(
    extractAttributeValues(carouselHtml, "a", "href").filter((href) => href.includes("toptik.co.il/products/")),
  )];
  if (carouselProductLinks.length < MIN_CAROUSEL_PRODUCT_LINKS) {
    throw new Error(`Carousel HTML rendered ${carouselProductLinks.length} store product links, expected at least ${MIN_CAROUSEL_PRODUCT_LINKS}`);
  }

  const storeSitemapIndex = await fetchText(`${storeBase}/sitemap.xml`);
  const productSitemaps = extractXmlLocations(storeSitemapIndex).filter((url) => {
    try { return new URL(url).pathname.startsWith("/sitemap_products_"); }
    catch { return false; }
  });
  if (productSitemaps.length === 0) throw new Error("Shopify sitemap index contains no product sitemap");
  const storeProductUrls = (await Promise.all(productSitemaps.map(fetchText)))
    .flatMap(extractXmlLocations)
    .filter((url) => {
      try { return new URL(url).origin === storeBase && new URL(url).pathname.startsWith("/products/"); }
      catch { return false; }
    });
  const catalogCoverage = compareStoreGalleryProductHandles(storeProductUrls, carouselPayload.items);
  if (catalogCoverage.missing.length > 0) {
    throw new Error(`Gallery is missing ${catalogCoverage.missing.length} live Shopify products: ${catalogCoverage.missing.slice(0, 20).join(",")}`);
  }

  const storeHomeHtml = await fetchText(storeBase);
  const storeHomeImages = [...new Set(extractAttributeValues(storeHomeHtml, "img", "src"))];
  const storeCollectionLinks = [...new Set(
    extractAttributeValues(storeHomeHtml, "a", "href").filter((href) => href.startsWith("/collections/")),
  )];
  if (!storeHomeHtml.includes("TopTik") || storeHomeImages.length < 3 || storeCollectionLinks.length < 3) {
    throw new Error(`Store homepage is incomplete: ${storeHomeImages.length} images and ${storeCollectionLinks.length} collection links`);
  }

  const storeCollectionUrl = `${storeBase}/collections/samsonite`;
  const storeCollectionHtml = await fetchText(storeCollectionUrl);
  const storeProductLinks = [...new Set(
    extractAttributeValues(storeCollectionHtml, "a", "href").filter((href) => href.startsWith("/products/")),
  )];
  if (storeProductLinks.length < MIN_STORE_COLLECTION_PRODUCTS) {
    throw new Error(`Shopify Samsonite collection rendered ${storeProductLinks.length} product links, expected at least ${MIN_STORE_COLLECTION_PRODUCTS}`);
  }

  const storeProductUrl = `${storeBase}/products/p10fzta9001`;
  const storeProductHtml = await fetchText(storeProductUrl);
  const storeProductImages = [...new Set(extractAttributeValues(storeProductHtml, "img", "src"))];
  if (!storeProductHtml.includes('"@type":"Product"') && !storeProductHtml.includes('"@type": "Product"')) {
    throw new Error(`${storeProductUrl} rendered without Product structured data`);
  }
  if (storeProductImages.length < 2) {
    throw new Error(`${storeProductUrl} rendered ${storeProductImages.length} product images, expected at least 2`);
  }

  const orderHealthResponse = await monitoredFetch(`${normalizedBase}/api/health/order-automation`);
  const orderHealth = await orderHealthResponse.json();
  if (orderHealth.status !== "healthy") {
    throw new Error(`Order automation health is ${orderHealth.status || "unknown"}: ${(orderHealth.issueCodes || []).join(",")}`);
  }

  const imageUrls = [
    ...journalImages.slice(0, 6).map((src) => absoluteUrl(normalizedBase, src)),
    absoluteUrl(normalizedBase, articleImages[0]),
    ...carouselPayload.items.slice(0, 3).map((item) => item.coverImagePath).filter(Boolean),
    ...storeHomeImages.slice(0, 2).map((src) => absoluteUrl(storeBase, src)),
    ...storeProductImages.slice(0, 2).map((src) => absoluteUrl(storeBase, src)),
  ];
  await Promise.all([...new Set(imageUrls)].map(verifyImage));

  return {
    journalImages: journalImages.length,
    articleImages: articleImages.length,
    carouselItems: carouselPayload.items.length,
    carouselProductLinks: carouselProductLinks.length,
    carouselTitleTypography: "supported-rubik-700",
    storeSitemapProducts: catalogCoverage.storeCount,
    galleryLinkedStoreProducts: catalogCoverage.galleryLinkedCount,
    storeHomeImages: storeHomeImages.length,
    storeCollectionProducts: storeProductLinks.length,
    storeProductImages: storeProductImages.length,
    verifiedImageAssets: new Set(imageUrls).size,
    orderAutomationHealth: orderHealth.status,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runProductionVisualSmoke(process.env.MONITOR_BASE_URL);
    console.log(`TopTik production visual smoke passed: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`TopTik production visual smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
