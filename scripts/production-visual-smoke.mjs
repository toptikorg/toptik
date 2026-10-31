import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://landing.toptik.co.il";
const MIN_JOURNAL_IMAGES = 20;
const MIN_CAROUSEL_ITEMS = 300;

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

async function monitoredFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": "TopTik-Production-Monitor/1.0",
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
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

  const imageUrls = [
    ...journalImages.slice(0, 6).map((src) => absoluteUrl(normalizedBase, src)),
    absoluteUrl(normalizedBase, articleImages[0]),
    ...carouselPayload.items.slice(0, 3).map((item) => item.coverImagePath).filter(Boolean),
  ];
  await Promise.all([...new Set(imageUrls)].map(verifyImage));

  return {
    journalImages: journalImages.length,
    articleImages: articleImages.length,
    carouselItems: carouselPayload.items.length,
    verifiedImageAssets: new Set(imageUrls).size,
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
