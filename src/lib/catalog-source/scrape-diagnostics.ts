// Admin-only scrape diagnostics (GAL-026). Moved from the former public
// /api/debug-scrape route. The caller must pass a guarded fetcher
// (safeSourceFetch): approved manufacturer HTTPS hosts only, no internal
// addresses, redirects re-validated. Read-only: never writes anything.
export type DiagnosticsFetcher = (url: string, init?: RequestInit) => Promise<Response>;

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export async function scrapeDiagnostics(url: string, fetcher: DiagnosticsFetcher): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { url };

  // 1. Try direct page fetch
  try {
    const res = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(14000) });
    result.pageStatus = res.status;
    if (res.ok) {
      const html = await res.text();
      result.pageLength = html.length;

      // Look for spec section markers
      const exteriorMatch = html.match(/[\s\S]{0,80}(?:exterior|EXTERIOR|Exterior)[\s\S]{0,500}/);
      result.exteriorSnippet = exteriorMatch?.[0] ?? null;

      // Look for inline product JSON
      result.hasBodyHtml = html.includes('"body_html"');
      result.hasWindowProduct = html.includes("window.product");
      result.hasProductJson = html.includes('type="application/json"');

      // Find body_html content if present
      const bodyHtmlMatch = html.match(/"body_html"\s*:\s*"((?:[^"\\]|\\.){0,8000})"/);
      result.bodyHtmlSnippet = bodyHtmlMatch?.[1]?.slice(0, 3000) ?? null;

      // Find options array if present
      const optionsMatch = html.match(/"options"\s*:\s*(\[[\s\S]{0,2000}?\])/);
      result.optionsSnippet = optionsMatch?.[1] ?? null;

      // Find JSON-LD Product description
      const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
      let m: RegExpExecArray | null;
      const jsonLdDescriptions: string[] = [];
      while ((m = jsonLdRegex.exec(html)) !== null) {
        try {
          const data = JSON.parse(m[1]);
          if (data["@type"] === "Product" && typeof data.description === "string") {
            jsonLdDescriptions.push(data.description.slice(0, 2000));
          }
        } catch {
          /* skip */
        }
      }
      result.jsonLdDescriptions = jsonLdDescriptions;

      // All variant option1 values
      const option1Regex = /"option1"\s*:\s*"([^"]+)"/gi;
      const option1Values = new Set<string>();
      while ((m = option1Regex.exec(html)) !== null) option1Values.add(m[1]);
      result.allOption1Values = [...option1Values];

      // Accordion blocks: capture all <details>...<summary>HEADING</summary>...<div class="accordion__content rte">CONTENT</div>...</details>
      const accordions: Array<{ heading: string; content: string }> = [];
      const detailsRegex = /<details[^>]*>([\s\S]*?)<\/details>/gi;
      let dm: RegExpExecArray | null;
      while ((dm = detailsRegex.exec(html)) !== null) {
        const block = dm[1];
        const sumMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(block);
        const contentMatch = /<div[^>]*class="[^"]*accordion__content[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
        if (sumMatch && contentMatch) {
          accordions.push({
            heading: sumMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80),
            content: contentMatch[1].slice(0, 1500),
          });
        }
      }
      result.accordions = accordions;
    }
  } catch (err) {
    result.pageError = (err as Error).message;
  }

  // 2. Try Shopify .json endpoint
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const idx = parts.lastIndexOf("products");
    if (idx !== -1 && parts[idx + 1]) {
      const handle = parts[idx + 1].split("?")[0];
      const jsonUrl = `${parsed.origin}/products/${handle}.json`;
      result.shopifyJsonUrl = jsonUrl;
      const r = await fetcher(jsonUrl, {
        headers: { ...HEADERS, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      result.shopifyJsonStatus = r.status;
      if (r.ok) {
        const data = await r.json();
        result.shopifyHasBodyHtml = !!data?.product?.body_html;
        result.shopifyOptionsCount = data?.product?.options?.length ?? 0;
        result.shopifyBodyHtml = data?.product?.body_html?.slice(0, 3000) ?? null;
      }
    }
  } catch (err) {
    result.shopifyError = (err as Error).message;
  }

  return result;
}
