type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
};

type ProviderOptions = {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Exchanges Dev Dashboard app credentials for Shopify's expiring Admin API token. */
export function createShopifyClientCredentialsProvider({
  shopDomain,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = Date.now,
}: ProviderOptions) {
  if (!SHOP_DOMAIN.test(shopDomain) || !clientId || !clientSecret) {
    throw new Error("SHOPIFY_CONFIG_CLIENT_CREDENTIALS_INVALID");
  }

  let cachedToken = "";
  let expiresAt = 0;
  let pending: Promise<string> | null = null;

  return async function getAccessToken(): Promise<string> {
    if (cachedToken && now() < expiresAt - 5 * 60_000) return cachedToken;
    if (pending) return pending;

    pending = (async () => {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      });
      const response = await fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
        method: "POST",
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (response.status >= 300 && response.status < 400) throw new Error("SHOPIFY_TOKEN_REDIRECT_REJECTED");
      if (!response.ok) throw new Error(`SHOPIFY_TOKEN_HTTP_${response.status}`);

      let payload: TokenResponse;
      try {
        payload = await response.json() as TokenResponse;
      } catch {
        throw new Error("SHOPIFY_TOKEN_RESPONSE_INVALID");
      }
      if (typeof payload.access_token !== "string" || !payload.access_token ||
          typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
        throw new Error("SHOPIFY_TOKEN_RESPONSE_INVALID");
      }
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/[\s,]+/).filter(Boolean) : [];
      if (!scopes.includes("write_products")) throw new Error("SHOPIFY_TOKEN_WRITE_PRODUCTS_SCOPE_MISSING");

      cachedToken = payload.access_token;
      expiresAt = now() + payload.expires_in * 1000;
      return cachedToken;
    })();

    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

