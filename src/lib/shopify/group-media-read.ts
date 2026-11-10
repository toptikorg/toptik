import "server-only";
import { configuredShopifyDomain, shopifyAdminGraphql } from "./admin-api";
import { MEDIA_API_VERSION } from "./media-read-adapter";
import { buildGroupMediaReadRequest, buildGroupMediaPageRequest, GROUP_VARIANT_MEDIA_PAGE_QUERY, parseGroupMediaResponse, type GroupMediaBinding } from "./group-media-policy";

/** Complete source read only. Does not decode, adopt a map, grant mutation authority or write. */
export async function readGroupMediaSnapshot(binding: GroupMediaBinding, deadline: number) {
  if (configuredShopifyDomain() !== "toptikcoil.myshopify.com" || (process.env.SHOPIFY_API_VERSION?.trim() || MEDIA_API_VERSION) !== MEDIA_API_VERSION) throw new Error("GROUP_MEDIA_CONFIG_MISMATCH");
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("GROUP_MEDIA_TIME_BUDGET");
  const stop = Math.min(deadline, Date.now() + 40_000);
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GROUP_MEDIA_RESPONSE_INVALID");
    return value as Record<string, unknown>;
  };
  const call = async (query: string, variables: Record<string, unknown>) => {
    if (Date.now() >= stop) throw new Error("GROUP_MEDIA_TIME_BUDGET");
    const data = await shopifyAdminGraphql<unknown>(query, variables, Math.min(5000, stop - Date.now()), stop);
    if (Date.now() >= stop) throw new Error("GROUP_MEDIA_TIME_BUDGET");
    return object(data);
  };
  const collect = async () => {
    let pages = 1;
    const request = buildGroupMediaReadRequest(binding), data = await call(request.query, request.variables);
    const product = object(structuredClone(data.product));
    const append = async (connection: unknown, load: (cursor: string) => Promise<unknown>) => {
      const combined = object(connection), seen = new Set<string>();
      if (!Array.isArray(combined.nodes)) throw new Error("GROUP_MEDIA_INCOMPLETE");
      let info = object(combined.pageInfo);
      while (info.hasNextPage === true) {
        const cursor = info.endCursor;
        if (typeof cursor !== "string" || !cursor || cursor.length > 1024 || seen.has(cursor) || combined.nodes.length >= 250) throw new Error("GROUP_MEDIA_INCOMPLETE");
        seen.add(cursor);
        const page = object(await load(cursor)); pages++;
        if (!Array.isArray(page.nodes) || !page.nodes.length) throw new Error("GROUP_MEDIA_INCOMPLETE");
        combined.nodes.push(...page.nodes); info = object(page.pageInfo);
        if (combined.nodes.length > 250) throw new Error("GROUP_MEDIA_INCOMPLETE");
      }
      if (info.hasNextPage !== false) throw new Error("GROUP_MEDIA_INCOMPLETE");
      combined.pageInfo = { hasNextPage: false, endCursor: info.endCursor ?? null };
      return combined;
    };
    for (const kind of ["media", "variants"] as const) {
      product[kind] = await append(product[kind], async cursor => {
        const pageRequest = buildGroupMediaPageRequest(binding, kind, cursor), p = object((await call(pageRequest.query, pageRequest.variables)).product);
        if (p.id !== binding.productGid || p.handle !== binding.handle) throw new Error("GROUP_MEDIA_IDENTITY_CONFLICT");
        return p[kind];
      });
    }
    for (const value of object(product.variants).nodes as unknown[]) {
      const variant = object(value);
      variant.media = await append(variant.media, async cursor => {
        const v = object((await call(GROUP_VARIANT_MEDIA_PAGE_QUERY, { id: variant.id, after: cursor })).productVariant), p = object(v.product);
        if (v.id !== variant.id || v.sku !== variant.sku || p.id !== binding.productGid || p.handle !== binding.handle) throw new Error("GROUP_MEDIA_IDENTITY_CONFLICT");
        return v.media;
      });
    }
    return { snapshot: parseGroupMediaResponse({ data: { product } }, binding), pages };
  };
  const first = await collect();
  // A paginated collection is not an atomic native read. Require a matching complete second pass;
  // neither a missing page nor a changing collection can become membership/removal evidence.
  if (first.pages > 1 && (await collect()).snapshot.fingerprint !== first.snapshot.fingerprint) throw new Error("GROUP_MEDIA_UNSTABLE_READ");
  return first.snapshot;
}
