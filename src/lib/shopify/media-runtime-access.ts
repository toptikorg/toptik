import "server-only";
import { shopifyAdminGraphql, configuredShopifyDomain } from "./admin-api";
import { MEDIA_API_VERSION, MEDIA_PUBLICATION_ID } from "./media-read-adapter";
import type { MediaRuntimeScopes } from "./media-runtime-job";

const QUERY = `query TopTikMediaRuntimeAccess {
  shop { myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
  publication(id: "${MEDIA_PUBLICATION_ID}") { id }
}`;
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_RUNTIME_ACCESS_INVALID");
  return value as Record<string, unknown>;
}

/** Read fresh installed-app scopes. No scopes/credentials supplied by an editor or request body. */
export async function readMediaRuntimeScopes(deadline: number): Promise<MediaRuntimeScopes> {
  if (configuredShopifyDomain() !== "toptikcoil.myshopify.com" ||
      (process.env.SHOPIFY_API_VERSION?.trim() || MEDIA_API_VERSION) !== MEDIA_API_VERSION ||
      process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim() !== MEDIA_PUBLICATION_ID) fail("MEDIA_RUNTIME_CONFIG_MISMATCH");
  if (!Number.isFinite(deadline) || Date.now() >= deadline) fail("MEDIA_RUNTIME_TIME_BUDGET");
  const stop = Math.min(deadline, Date.now() + 5000);
  const data = object(await shopifyAdminGraphql<unknown>(QUERY, {}, stop - Date.now(), stop));
  if (Date.now() >= stop) fail("MEDIA_RUNTIME_TIME_BUDGET");
  if (object(data.shop).myshopifyDomain !== "toptikcoil.myshopify.com" || object(data.publication).id !== MEDIA_PUBLICATION_ID) fail("MEDIA_RUNTIME_SHOP_CHANGED");
  const raw = object(data.currentAppInstallation).accessScopes;
  if (!Array.isArray(raw) || raw.length > 200) fail("MEDIA_RUNTIME_ACCESS_INVALID");
  const scopes = raw.map(scope => {
    const handle = object(scope).handle;
    if (typeof handle !== "string" || !/^[a-z][a-z_]{1,99}$/.test(handle)) fail("MEDIA_RUNTIME_ACCESS_INVALID");
    return handle;
  });
  if (new Set(scopes).size !== scopes.length) fail("MEDIA_RUNTIME_ACCESS_INVALID");
  return { shopDomain: "toptikcoil.myshopify.com", apiVersion: MEDIA_API_VERSION, publicationId: MEDIA_PUBLICATION_ID,
    scopes: scopes.sort(), observedAt: new Date().toISOString() };
}
