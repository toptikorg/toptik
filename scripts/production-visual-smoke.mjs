import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DEFAULT_BASE_URL = "https://landing.toptik.co.il";
const DEFAULT_STORE_URL = "https://www.toptik.co.il";
const MIN_JOURNAL_IMAGES = 20;
const MIN_CAROUSEL_ITEMS = 300;
const MIN_CAROUSEL_PRODUCT_LINKS = 300;
const MIN_STORE_COLLECTION_PRODUCTS = 8;
const MONITORED_BRANDS = ["mandarina-duck", "brics", "samsonite", "american-tourister"];
const VIDEO_MEDIA_BASELINES = JSON.parse(readFileSync(new URL("../data/video-media-baselines.json", import.meta.url), "utf8")).assets;
const STALE_SHIPPING_COPY = [
  "עלות הסופית מוצגת בקופה",
  "דואר שליחים בתיאום",
  "משלוחים לכל הארץ מ־TopTik",
  "משלוחים לכל הארץ מ-TopTik",
  "65 ₪",
  "85 ₪",
  "155 ₪",
];

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

export function assertStoreBrandSeriesNavigation(html, brand, expectedSeries = []) {
  const section = html.match(/<details\b[^>]*class="[^"]*\btt-series-nav\b[^"]*"[^>]*>[\s\S]*?<\/details>/i)?.[0];
  if (!section) throw new Error(`${brand}: series navigation is missing`);
  const hrefs = extractAttributeValues(section, "a", "href");
  if (!hrefs.some((href) => href.startsWith(`/collections/${brand}-`))) {
    throw new Error(`${brand}: series navigation has no brand collection links`);
  }
  const available = new Set(hrefs.map((href) => href.split("?")[0]));
  const missing = expectedSeries.filter((key) => !available.has(`/collections/${key}`));
  if (missing.length) throw new Error(`${brand}: series links missing for gallery products: ${missing.join(", ")}`);
  if (extractAttributeValues(html, "a", "href").filter((href) => href.startsWith("/products/")).length === 0) {
    throw new Error(`${brand}: collection has no product links`);
  }
}

export function assertRelevantCategoryLinks(html, handle) {
  const match = html.match(/<div\b[^>]*class="[^"]*\btt-side__list\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!match) throw new Error(`${handle}: category navigation missing`);
  const links = extractAttributeValues(match[1], 'a', 'href').map((url) => decodeURI(url.split('?')[0]));
  const rules = {
    'all-bags': { required: ['/collections/fashion-bags', '/collections/backpacks', '/collections/תיקי-נסיעות', '/collections/תיקי-גב-למחשב'], forbidden: ['/collections/wallets', '/collections/מזוודות'] },
    'wallets-and-accessories': { required: ['/collections/wallets', '/collections/toiletry-pouches'], forbidden: ['/collections/fashion-bags', '/collections/backpacks', '/collections/מזוודות'] },
    'מזוודות': { required: ['/collections/מזוודות', '/collections/טרולי-carry-on'], forbidden: ['/collections/wallets', '/collections/fashion-bags', '/collections/backpacks'] },
    'samsonite': { required: ['/collections/מזוודות-סמסונייט', '/collections/טרולי-carry-on/samsonite', '/collections/תיקי-נסיעות/samsonite', '/collections/תיקי-גב-למחשב/samsonite'], forbidden: [] },
  };
  const rule = rules[handle];
  if (!rule) return;
  for (const expected of rule.required) if (!links.includes(expected)) throw new Error(`${handle}: relevant category link missing: ${expected}`);
  for (const forbidden of rule.forbidden) if (links.includes(forbidden)) throw new Error(`${handle}: unrelated category link: ${forbidden}`);
}

export function assertCategorySeriesNavigation(html, handle, products, handles) {
  const known = new Set(handles);
  const series = new Set(products.flatMap((p) => Array.isArray(p.tags) ? p.tags : []).filter((t) => t.startsWith('tt-series:')).map((t) => t.slice(10)).filter((h) => known.has(h)));
  if (!series.size) return;
  const section = html.match(/<details\b[^>]*class="[^"]*\btt-series-nav\b[^"]*"[^>]*>[\s\S]*?<\/details>/i)?.[0];
  if (!section) throw new Error(`${handle}: series selection missing despite tagged products`);
  const links = extractAttributeValues(section, 'a', 'href').map((href) => decodeURI(href.split('?')[0]));
  for (const key of series) {
    const categoryLink = `/collections/${handle}/tt-series-${key}`;
    if (!links.includes(categoryLink) && !links.includes(`/collections/${key}`)) throw new Error(`${handle}: missing series ${key}`);
  }
}

async function fetchCollectionProducts(storeBase, handle) {
  const products = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await (await monitoredFetch(`${storeBase}/collections/${encodeURIComponent(handle)}/products.json?limit=250&page=${page}`)).json();
    if (!Array.isArray(result.products)) throw new Error(`${handle}: invalid product response`);
    products.push(...result.products);
    if (result.products.length < 250) return products;
  }
  throw new Error(`${handle}: series scan incomplete`);
}

export function assertGalleryBrandSeries(items) {
  for (const brand of MONITORED_BRANDS) {
    const series = items.filter((item) => item?.isActive && item?.series?.brand === brand && item.series.key && item.series.label);
    if (series.length === 0) throw new Error(`Gallery ${brand}: active products with series are missing`);
  }
}

export function assertShippingPolicyConsistency(html, label, { requireDoorstep = false } = {}) {
  const required = requireDoorstep ? "משלוח חינם עד הבית" : "משלוח חינם לכל הארץ";
  if (!html.includes(required)) {
    throw new Error(`${label} is missing the canonical shipping statement: ${required}`);
  }
  const stale = STALE_SHIPPING_COPY.filter((phrase) => html.includes(phrase));
  if (stale.length > 0) {
    throw new Error(`${label} contains stale shipping copy: ${stale.join(", ")}`);
  }
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

export function retainPublicMissingHandles(missingHandles, statusByHandle) {
  return missingHandles.filter((handle) => {
    const status = statusByHandle.get(handle);
    return status === undefined || status === 200;
  });
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

async function fetchStoreProductStatus(url) {
  let lastResponse;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResponse = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": "TopTik-Production-Monitor/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (lastResponse.status === 200 || [301, 302, 303, 307, 308, 404, 410].includes(lastResponse.status)) {
      await lastResponse.body?.cancel();
      return lastResponse.status;
    }
    if (![429, 500, 502, 503, 504].includes(lastResponse.status) || attempt === 3) break;
    await lastResponse.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw new Error(`${url} returned HTTP ${lastResponse?.status ?? "unknown"} while checking product publication`);
}

async function fetchText(url) {
  return (await monitoredFetch(url)).text();
}

export function assertVideoMediaHash(filename, bytes, expectedHash = VIDEO_MEDIA_BASELINES[filename]) {
  if (!expectedHash || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
    throw new Error(`Video media baseline changed: ${filename}; review content before updating the baseline`);
  }
}

async function checkVideoMediaBaselines(baseUrl) {
  for (const filename of Object.keys(VIDEO_MEDIA_BASELINES)) {
    const response = await monitoredFetch(`${baseUrl}/videos/${filename}`);
    assertVideoMediaHash(filename, Buffer.from(await response.arrayBuffer()));
  }
}

export function assertNoUnavailableVariants(products) {
  const unavailable = products.flatMap((product) => {
    if (!Array.isArray(product.variants) || product.variants.length === 0) {
      throw new Error(`Store product ${product.handle} is missing variant data`);
    }
    return product.variants.filter((variant) => {
      if (typeof variant.available !== "boolean") throw new Error(`Missing availability for ${product.handle}`);
      return !variant.available;
    }).map((variant) => `${product.handle} (${variant.sku || variant.id})`);
  });
  if (unavailable.length) throw new Error(`Unavailable variants visible in Shopify catalog: ${unavailable.join(", ")}`);
}

export function assertHomeGalleryLink(html) {
  const content = html.split('<footer')[0];
  if (!/<a\b[^>]*href="https:\/\/landing\.toptik\.co\.il\/carousel"[^>]*>[^<]*(?:גלריה|גלריית)[^<]*<\/a>/i.test(content)) {
    throw new Error("Store homepage is missing the prominent gallery link");
  }
}

export function assertVideoNavigation(html) {
  if (!/<a\b[^>]*aria-label="טופ תיק, לדף הבית"[^>]*>\s*<b\b[^>]*>TOPTIK<\/b>/i.test(html)) throw new Error('Video page live text brand logo is missing');
  if (!/<title>\s*[^<\s][^<]*<\/title>/i.test(html)) throw new Error('Video SEO title is missing');
  if (!/<meta\b(?=[^>]*name="description")(?=[^>]*content="[^"\s][^"]*")[^>]*>/i.test(html)) throw new Error('Video SEO description is missing');
  if (!/<h1\b[^>]*>\s*[^<\s][\s\S]*?<\/h1>/i.test(html)) throw new Error('Video SEO heading is missing');
  if (!/<video\b/i.test(html)) throw new Error('Video player is missing');
  const videoCards = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)].map(([card]) => card).filter(card => /<video\b/i.test(card));
  if (!videoCards.length) throw new Error('Video card is missing');
  for (const card of videoCards) {
    if (!/<h[12]\b[^>]*\bdata-video-live-title(?:="[^"]*")?[^>]*>\s*[^<\s][\s\S]*?<\/h[12]>/i.test(card)) throw new Error('Visible video live title is missing');
    if (!/<p\b[^>]*\bdata-video-live-copy(?:="[^"]*")?[^>]*>\s*[^<\s][\s\S]*?<\/p>/i.test(card)) throw new Error('Visible video live copy is missing');
  }
  if (/rel="canonical"[^>]*href="https:\/\/landing\.toptik\.co\.il\/videos\/[^"/]+"/i.test(html) && !/"@type"\s*:\s*"VideoObject"/.test(html)) throw new Error('Video structured data is missing');
  for (const label of ['מזוודות וטרולי', 'תיקים', 'ארנקים ואביזרים', 'מותגים', 'מבצעים', 'סרטוני מוצרים', 'שירות ומידע']) {
    if (!html.includes(label)) throw new Error(`Video navigation is missing ${label}`);
  }
  if (/name="robots"[^>]*content="[^"]*noindex/i.test(html)) throw new Error('Video page is noindex');
  if (!/rel="canonical"/.test(html)) throw new Error('Video page canonical is missing');
  if (!html.includes('https://www.toptik.co.il/products/')) throw new Error('Video page has no store purchase links');
}

export function assertVideoNavigationMatchesStore(storeHtml, videoHtml, storeBase, videoBase) {
  const storeNav = storeHtml.match(/<nav\b(?=[^>]*\bid="tt-main-nav")[^>]*>[\s\S]*?<\/nav>/i)?.[0];
  const videoNav = videoHtml.match(/<nav\b(?=[^>]*\baria-label="תפריט ראשי")[^>]*>[\s\S]*?<\/nav>/i)?.[0];
  if (!storeNav || !videoNav) throw new Error('Store or video main navigation is missing');
  const storeDesktop = storeNav.split('<div class="tt-mobile-groups"')[0];
  const normalize = (href, base) => { const url = new URL(href, base); return `${url.origin}${decodeURI(url.pathname)}${url.hash}`; };
  const entries = (nav, base) => [...nav.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(([, href, text]) => {
    const label = decodeHtmlAttribute(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    return `${normalize(decodeHtmlAttribute(href), base)} :: ${label}`;
  });
  const expected = new Set(entries(storeDesktop, storeBase));
  const actual = new Set(entries(videoNav, videoBase));
  if (!expected.size) throw new Error('Store navigation contains no links');
  const missing = [...expected].filter(url => !actual.has(url));
  const extra = [...actual].filter(url => !expected.has(url));
  if (missing.length || extra.length) throw new Error(`Video and store navigation differ; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`);
}

export function assertDirectCategoryNavigation(html) {
  const nav = html.match(/<nav\b(?=[^>]*(?:\bid="tt-main-nav"|\baria-label="תפריט ראשי"))[^>]*>[\s\S]*?<\/nav>/i)?.[0];
  if (!nav) throw new Error('Main navigation is missing');
  const categories = [['מזוודות וטרולי', '/collections/מזוודות-וטרולי'], ['תיקים', '/collections/all-bags'], ['ארנקים ואביזרים', '/collections/wallets-and-accessories']];
  const anchors = [...nav.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [label, path] of categories) {
    const found = anchors.some(([, href, text]) => text.replace(/<[^>]*>/g, '').trim() === label && decodeURI(new URL(decodeHtmlAttribute(href), 'https://www.toptik.co.il').pathname) === path);
    if (!found) throw new Error(`Direct category link missing or incorrect: ${label}`);
    if (!nav.includes(`aria-label="פתיחת תפריט ${label}"`)) throw new Error(`Category submenu control missing: ${label}`);
  }
}

export function assertColorSelector(html, skus) {
  for (const sku of skus) {
    if (!html.includes(`data-color-sku="${sku}"`)) throw new Error(`Visible color selection missing for ${sku}`);
  }
}

export function assertReadableSubcategoryHover(html) {
  const rules = [...html.matchAll(/\.tt-subcats\s+a:hover\s*\{([^}]*)\}/gi)];
  if (html.includes('class="tt-subcats"') && rules.length === 0) throw new Error("Subcategory hover style is missing");
  for (const [, declarations] of rules) {
    if (/background(?:-color)?\s*:\s*(?:#(?:000|111)(?:000|111)?\b|black\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/i.test(declarations)) {
      throw new Error("Subcategory hover uses a black background");
    }
  }
}

async function fetchStoreCatalog(storeBase) {
  const products = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await (await monitoredFetch(`${storeBase}/products.json?limit=250&page=${page}&monitor_check=${Date.now()}`)).json();
    if (!Array.isArray(result.products)) throw new Error(`Store product catalog page ${page} is invalid`);
    products.push(...result.products);
    if (result.products.length < 250) {
      if (!products.length) throw new Error("Store product catalog is empty");
      return products;
    }
  }
  throw new Error("Store catalog exceeded pagination safety limit");
}

async function fetchStoreCollectionHandles(storeBase) {
  const handles = new Set();
  for (let page = 1; page <= 100; page += 1) {
    const result = await (await monitoredFetch(`${storeBase}/collections.json?limit=250&page=${page}`)).json();
    if (!Array.isArray(result.collections)) throw new Error(`Store collection catalog page ${page} is invalid`);
    for (const collection of result.collections) {
      if (typeof collection.handle !== "string" || !collection.handle) throw new Error("Store collection is missing its handle");
      handles.add(collection.handle);
    }
    if (result.collections.length < 250) {
      if (!handles.size) throw new Error("Store collection catalog is empty");
      return [...handles];
    }
  }
  throw new Error("Store collection catalog exceeded pagination safety limit");
}

export function productsWithMultipleColors(products) {
  return products.filter((product) => Array.isArray(product.options) && product.options.some((option) =>
    ["צבע", "color", "colour"].includes(String(option.name).trim().toLowerCase()) && Array.isArray(option.values) && option.values.length > 1));
}

async function checkStoreColorSelectors(storeBase, products) {
      const failures = [];
      for (const product of productsWithMultipleColors(products)) {
        try {
          const expected = product.variants.map((variant) => variant.sku);
          if (expected.some((sku) => !sku)) throw new Error(`Missing variant SKU on ${product.handle}`);
          assertColorSelector(await fetchText(`${storeBase}/products/${encodeURIComponent(product.handle)}?monitor_check=${Date.now()}`), expected);
        } catch (error) { failures.push(`${product.handle}: ${error.message}`); }
      }
      if (failures.length) throw new Error(`Color selection errors: ${failures.join("; ")}`);
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
  const storeHomeHtml = await fetchText(storeBase);
  const storeCatalog = await fetchStoreCatalog(storeBase);
  const collectionHandles = await fetchStoreCollectionHandles(storeBase);
  const collectionChecks = new Map();
  for (const handle of new Set([...MONITORED_BRANDS, ...collectionHandles])) {
    if (collectionChecks.size) await new Promise((resolve) => setTimeout(resolve, 800));
    collectionChecks.set(handle, await fetchText(`${storeBase}/collections/${encodeURIComponent(handle)}`).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    ));
    const page = collectionChecks.get(handle);
    if (page.status === "rejected" && /HTTP 429/.test(page.reason.message)) break;
  }
  const categorySeriesErrors = [];
  for (const [handle, page] of collectionChecks) {
    if (page.status !== 'fulfilled') continue;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const products = await fetchCollectionProducts(storeBase, handle);
      assertRelevantCategoryLinks(page.value, handle);
      assertCategorySeriesNavigation(page.value, handle, products, collectionHandles);
    } catch (error) {
      categorySeriesErrors.push(error.message);
      if (/HTTP 429/.test(error.message)) { categorySeriesErrors.push('Series scan incomplete after rate limiting'); break; }
    }
  }
  const checks = await Promise.allSettled([
    Promise.resolve().then(() => { if (categorySeriesErrors.length) throw new Error(categorySeriesErrors.join('; ')); }),
    Promise.resolve().then(() => assertNoUnavailableVariants(storeCatalog)),
    Promise.resolve().then(() => { assertHomeGalleryLink(storeHomeHtml); assertDirectCategoryNavigation(storeHomeHtml); }),
    checkStoreColorSelectors(storeBase, storeCatalog),
    checkVideoMediaBaselines(normalizedBase),
    (async () => {
      for (const path of ['/videos', '/videos/intuo-upscape', '/videos/choosing-55cm-trolley', '/videos/samsonite-pro-dlx-6']) {
        try { const html = await fetchText(`${normalizedBase}${path}`); assertVideoNavigation(html); assertDirectCategoryNavigation(html); assertVideoNavigationMatchesStore(storeHomeHtml, html, storeBase, normalizedBase); }
        catch (error) { throw new Error(`${path}: ${error.message}`); }
      }
    })(),
    (async () => {
      const pages = [...collectionChecks.values()];
      const problems = [];
      if (pages.length < new Set([...MONITORED_BRANDS, ...collectionHandles]).size) problems.push("Collection hover scan incomplete after rate limiting");
      for (const page of pages) {
        if (page.status === "rejected") problems.push(page.reason.message);
        else {
          try { assertReadableSubcategoryHover(page.value); }
          catch (error) { problems.push(error.message); }
        }
      }
      if (problems.length) throw new Error(problems.join("; "));
    })(),
  ]);
  const problems = checks.filter((result) => result.status === "rejected").map((result) => result.reason.message);
  if (problems.length) throw new Error(problems.join("; "));
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
  assertGalleryBrandSeries(carouselPayload.items);

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
    const storeUrlByHandle = new Map(storeProductUrls.map((url) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[1] ?? "").toLowerCase();
      return [handle, url];
    }));
    const statusByHandle = new Map();
    for (const handle of catalogCoverage.missing) {
      const productUrl = storeUrlByHandle.get(handle);
      if (productUrl) statusByHandle.set(handle, await fetchStoreProductStatus(productUrl));
    }
    const publicMissing = retainPublicMissingHandles(catalogCoverage.missing, statusByHandle);
    if (publicMissing.length > 0) {
      throw new Error(`Gallery is missing purchase links for ${publicMissing.length} live Shopify products: ${publicMissing.slice(0, 20).join(",")}`);
    }
  }

  assertShippingPolicyConsistency(storeHomeHtml, "Store homepage");
  const storeHomeImages = [...new Set(extractAttributeValues(storeHomeHtml, "img", "src"))];
  const storeCollectionLinks = [...new Set(
    extractAttributeValues(storeHomeHtml, "a", "href").filter((href) => href.startsWith("/collections/")),
  )];
  if (!storeHomeHtml.includes("TopTik") || storeHomeImages.length < 3 || storeCollectionLinks.length < 3) {
    throw new Error(`Store homepage is incomplete: ${storeHomeImages.length} images and ${storeCollectionLinks.length} collection links`);
  }

  const storeCollectionHtml = collectionChecks.get("samsonite").value;
  assertShippingPolicyConsistency(storeCollectionHtml, "Samsonite collection");
  const storeProductLinks = [...new Set(
    extractAttributeValues(storeCollectionHtml, "a", "href").filter((href) => href.startsWith("/products/")),
  )];
  if (storeProductLinks.length < MIN_STORE_COLLECTION_PRODUCTS) {
    throw new Error(`Shopify Samsonite collection rendered ${storeProductLinks.length} product links, expected at least ${MIN_STORE_COLLECTION_PRODUCTS}`);
  }

  for (const brand of MONITORED_BRANDS) {
    const html = collectionChecks.get(brand).value;
    const expected = [...new Set(carouselPayload.items
      .filter((item) => item?.isActive && item?.shopifyLink?.isPublished && item?.series?.brand === brand && item.series.key)
      .map((item) => item.series.key))];
    assertStoreBrandSeriesNavigation(html, brand, expected);
  }

  const storeProductUrl = `${storeBase}/products/p10fzta9001`;
  const storeProductHtml = await fetchText(storeProductUrl);
  assertShippingPolicyConsistency(storeProductHtml, "Product page", { requireDoorstep: true });
  const storeProductImages = [...new Set(extractAttributeValues(storeProductHtml, "img", "src"))];
  if (!storeProductHtml.includes('"@type":"Product"') && !storeProductHtml.includes('"@type": "Product"')) {
    throw new Error(`${storeProductUrl} rendered without Product structured data`);
  }
  if (storeProductImages.length < 2) {
    throw new Error(`${storeProductUrl} rendered ${storeProductImages.length} product images, expected at least 2`);
  }

  const faqHtml = await fetchText(`${storeBase}/pages/faq`);
  assertShippingPolicyConsistency(faqHtml, "FAQ page");

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




