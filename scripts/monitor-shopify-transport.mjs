const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Opt-in transport: serialized Shopify requests, including redirect hops.
// A 429 permanently closes the gate for this run. Retry-After is reported,
// not bypassed by an automatic retry.
export function createMonitorTransport({ paced = false, storeBase, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => performance.now(), wallNow = () => Date.now(), intervalMs = 30_000, timeoutMs = 20_000 } = {}) {
  const storeHost = new URL(storeBase).hostname.toLowerCase();
  const storeHosts = new Set([storeHost, storeHost.startsWith('www.') ? storeHost.slice(4) : `www.${storeHost}`]);
  let queue = Promise.resolve();
  let lastStarted = null;
  let notBefore = 0;
  let rateLimitError;
  const retryAfterDelay = (value) => {
    const seconds = /^\d+$/.test(value) ? Number(value) : null;
    const delay = seconds !== null ? seconds * 1_000 : Date.parse(value) - wallNow();
    return Number.isFinite(delay) && delay > 0 ? delay : 0;
  };
  const shopifyHost = (url) => {
    const host = new URL(url).hostname.toLowerCase();
    return storeHosts.has(host) || host === 'shopify.com' || host.endsWith('.shopify.com') || host.endsWith('.myshopify.com') || host.endsWith('.shopifycdn.com') || host.endsWith('.shopifycloud.com');
  };
  async function single(url, options) {
    const invoke = async () => {
      if (rateLimitError) throw rateLimitError;
      let wait = Math.max(0, notBefore - now(), lastStarted === null ? 0 : intervalMs - (now() - lastStarted));
      while (wait > 0) {
        await sleep(Math.min(wait, 2_000_000_000));
        wait = Math.max(0, notBefore - now(), lastStarted === null ? 0 : intervalMs - (now() - lastStarted));
      }
      if (rateLimitError) throw rateLimitError;
      lastStarted = now();
      const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const retryAfter = response.headers.get('retry-after');
      if (response.status === 429) {
        rateLimitError = new Error(`${url} returned HTTP 429; Shopify requests stopped for this run${retryAfter ? `; Retry-After: ${retryAfter}` : ''}`);
        try { await response.body?.cancel(); } catch { /* The gate must remain closed even if cancellation fails. */ }
        throw rateLimitError;
      }
      if (retryAfter && (response.status === 503 || REDIRECTS.has(response.status))) {
        notBefore = Math.max(notBefore, now() + retryAfterDelay(retryAfter));
      }
      // Finish the response body before releasing the queue: receiving headers
      // alone does not mean that the previous Shopify request has completed.
      if (!response.body) return response;
      const bytes = await response.arrayBuffer();
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    if (!paced || !shopifyHost(url)) return fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    const result = queue.then(invoke);
    queue = result.catch(() => {});
    return result;
  }
  return async function monitorRequest(url, options = {}) {
    if (!paced || options.redirect === 'manual') return single(url, options);
    let current = new URL(url).toString();
    let headers = options.headers;
    for (let hops = 0; hops <= 20; hops += 1) {
      const response = await single(current, { ...options, headers, redirect: 'manual' });
      if (!REDIRECTS.has(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (hops === 20) throw new Error(`Too many redirects for ${url}`);
      await response.body?.cancel();
      const retryAfter = response.headers.get('retry-after');
      let delay = retryAfter ? retryAfterDelay(retryAfter) : 0;
      while (delay > 0) {
        const chunk = Math.min(delay, 2_000_000_000);
        await sleep(chunk);
        delay -= chunk;
      }
      const target = new URL(location, current);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`Invalid redirect protocol: ${target.protocol}`);
      if (target.origin !== new URL(current).origin && headers) {
        const clean = new Headers(headers);
        clean.delete('authorization');
        clean.delete('cookie');
        headers = clean;
      }
      current = target.toString();
    }
    throw new Error(`Too many redirects for ${url}`);
  };
}
