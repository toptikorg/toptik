import "server-only";
import { createShopifyClientCredentialsProvider } from "./client-credentials";
import { plainDescriptionToHtml, descriptionTextFromHtml, canonicalDescriptionHtml, assertSafeDescriptionHtml } from "./description-document";

export type ShopifyVariant = { id: string; sku: string | null };
export type ShopifyProductSnapshot = {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  seoTitle: string | null;
  seoDescription: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  updatedAt: string;
  publishedOnPublication: boolean;
  variants: ShopifyVariant[];
};

type ShopifyProductPage = {
  product: null | {
    id: string;
    handle: string;
    title: string;
    descriptionHtml: string;
    seo: { title: string | null; description: string | null } | null;
    status: ShopifyProductSnapshot["status"];
    updatedAt: string;
    publishedOnPublication: boolean;
    variants: { nodes: ShopifyVariant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  };
};

type ShopifyBootstrapPage = {
  products: {
    nodes: Array<{ id: string; updatedAt: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type GraphqlError = { message?: string; extensions?: { code?: unknown } };

let tokenProviderCache: {
  domain: string;
  clientId: string;
  clientSecret: string;
  getAccessToken: () => Promise<string>;
} | null = null;

const PRODUCT_QUERY = `
  query GallerySyncProduct($id: ID!, $publicationId: ID!, $after: String) {
    product(id: $id) {
      id
      handle
      title
      descriptionHtml
      seo { title description }
      status
      updatedAt
      publishedOnPublication(publicationId: $publicationId)
      variants(first: 250, after: $after) {
        nodes { id sku }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const UPDATE_PRODUCT_COPY_MUTATION = `
  mutation GallerySyncVisibleProductCopy($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title descriptionHtml seo { title description } updatedAt }
      userErrors { field message }
    }
  }
`;

const BOOTSTRAP_PRODUCTS_QUERY = `
  query GallerySyncBootstrapProducts($after: String) {
    products(first: 100, after: $after) {
      nodes { id updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function getConfig() {
  const domain = process.env.SHOPIFY_SHOP_DOMAIN?.trim().toLowerCase();
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const publicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim();
  const version = process.env.SHOPIFY_API_VERSION?.trim() || "2026-07";
  if (!domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error("SHOPIFY_CONFIG_SHOP_DOMAIN_INVALID");
  }
  if (!clientId || !clientSecret) throw new Error("SHOPIFY_CONFIG_CLIENT_CREDENTIALS_MISSING");
  if (!publicationId || !/^gid:\/\/shopify\/Publication\/\d+$/.test(publicationId)) {
    throw new Error("SHOPIFY_CONFIG_PUBLICATION_ID_INVALID");
  }
  if (!/^20\d{2}-(01|04|07|10)$/.test(version)) throw new Error("SHOPIFY_CONFIG_API_VERSION_INVALID");
  return { domain, clientId, clientSecret, publicationId, version };
}

export function isShopifySyncConfigured(): boolean {
  try {
    getConfig();
    return true;
  } catch {
    return false;
  }
}

export function configuredShopifyDomain(): string {
  return getConfig().domain;
}

function graphqlErrorCode(code: unknown): string {
  if (typeof code !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)) return "SHOPIFY_GRAPHQL_ERROR";
  const normalized = code.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  // The worker accepts only bounded uppercase codes. Never include provider
  // messages or arbitrary extension values in logs or persisted queue errors.
  return /^[A-Z0-9_]{1,64}$/.test(normalized) ? `SHOPIFY_GRAPHQL_${normalized}` : "SHOPIFY_GRAPHQL_ERROR";
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { domain, clientId, clientSecret, version } = getConfig();
  if (!tokenProviderCache || tokenProviderCache.domain !== domain ||
      tokenProviderCache.clientId !== clientId || tokenProviderCache.clientSecret !== clientSecret) {
    tokenProviderCache = {
      domain,
      clientId,
      clientSecret,
      getAccessToken: createShopifyClientCredentialsProvider({ shopDomain: domain, clientId, clientSecret }),
    };
  }
  const token = await tokenProviderCache.getAccessToken();
  const url = `https://${domain}/admin/api/${version}/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-shopify-access-token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("SHOPIFY_API_REDIRECT_REJECTED");
  if (!response.ok) throw new Error(`SHOPIFY_API_HTTP_${response.status}`);
  const payload = await response.json() as { data?: T; errors?: GraphqlError[] };
  if (payload.errors?.length) {
    throw new Error(graphqlErrorCode(payload.errors[0]?.extensions?.code));
  }
  if (!payload.data) throw new Error("SHOPIFY_GRAPHQL_DATA_MISSING");
  return payload.data;
}

export async function fetchProductSnapshot(productGid: string): Promise<ShopifyProductSnapshot | null> {
  const { publicationId } = getConfig();
  const variants: ShopifyVariant[] = [];
  let after: string | null = null;
  let product: Omit<ShopifyProductSnapshot, "variants"> | null = null;
  do {
    const result: ShopifyProductPage = await graphql<ShopifyProductPage>(PRODUCT_QUERY, { id: productGid, publicationId, after });
    if (!result.product) return null;
    const current = result.product;
    if (!product) {
      product = {
        id: current.id,
        handle: current.handle,
        title: current.title,
        descriptionHtml: current.descriptionHtml,
        seoTitle: current.seo?.title ?? null,
        seoDescription: current.seo?.description ?? null,
        status: current.status,
        updatedAt: current.updatedAt,
        publishedOnPublication: current.publishedOnPublication,
      };
    }
    variants.push(...current.variants.nodes);
    if (!current.variants.pageInfo.hasNextPage) break;
    after = current.variants.pageInfo.endCursor;
    if (!after || variants.length >= 2048) throw new Error("SHOPIFY_VARIANT_PAGINATION_LIMIT");
  } while (true);

  if (!product) return null;
  return { ...product, variants };
}

export type ShopifyCatalogSeedSnapshot = ShopifyProductSnapshot & {
  media: Array<{ id: string; alt: string | null; mediaContentType: string; status: string;
    image?: { url: string; altText: string | null; width: number; height: number } | null }>;
};

/** Bounded read for the reviewed seed only; never accepts arbitrary GraphQL. */
export async function fetchCatalogSeedProductSnapshot(productGid: string): Promise<ShopifyCatalogSeedSnapshot | null> {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productGid)) throw new Error("CATALOG_SEED_PRODUCT_ID_INVALID");
  const { publicationId } = getConfig();
  if (publicationId !== "gid://shopify/Publication/79538258170") throw new Error("CATALOG_SEED_PUBLICATION_MISMATCH");
  const result = await graphql<{ product: (Omit<ShopifyCatalogSeedSnapshot, "seoTitle" | "seoDescription" | "variants" | "media"> & {
    seo: { title: string | null; description: string | null } | null;
    variants: { nodes: ShopifyVariant[]; pageInfo: { hasNextPage: boolean } };
    media: { nodes: ShopifyCatalogSeedSnapshot["media"]; pageInfo: { hasNextPage: boolean } };
  }) | null }>(`query GalleryReviewedSeedProduct($id: ID!, $publicationId: ID!) {
    product(id: $id) {
      id handle title descriptionHtml status updatedAt seo { title description }
      publishedOnPublication(publicationId: $publicationId)
      variants(first: 2) { nodes { id sku } pageInfo { hasNextPage } }
      media(first: 50) { nodes { id alt mediaContentType status ... on MediaImage { image { url altText width height } } } pageInfo { hasNextPage } }
    }
  }`, { id: productGid, publicationId });
  if (!result.product) return null;
  const product = result.product;
  if (product.variants.pageInfo.hasNextPage || product.media.pageInfo.hasNextPage) throw new Error("CATALOG_SEED_SNAPSHOT_LIMIT");
  return { id: product.id, handle: product.handle, title: product.title, descriptionHtml: product.descriptionHtml,
    seoTitle: product.seo?.title ?? null, seoDescription: product.seo?.description ?? null,
    status: product.status, updatedAt: product.updatedAt, publishedOnPublication: product.publishedOnPublication,
    variants: product.variants.nodes, media: product.media.nodes };
}

/** One-time, bounded scan to enqueue existing products for exact-SKU bootstrap. */
export async function fetchShopifyBootstrapProducts(limit = 5000): Promise<Array<{ id: string; updatedAt: string; deliveryId: string }>> {
  const products: Array<{ id: string; updatedAt: string; deliveryId: string }> = [];
  let after: string | null = null;
  do {
    const page: ShopifyBootstrapPage = await graphql<ShopifyBootstrapPage>(BOOTSTRAP_PRODUCTS_QUERY, { after });
    for (const product of page.products.nodes) {
      products.push({ ...product, deliveryId: `bootstrap:${product.id}:${product.updatedAt}` });
      if (products.length >= limit) return products;
    }
    if (!page.products.pageInfo.hasNextPage) break;
    after = page.products.pageInfo.endCursor;
    if (!after) throw new Error("SHOPIFY_BOOTSTRAP_CURSOR_MISSING");
  } while (true);
  return products;
}

export type ShopifyVisibleCopy = {
  title: string;
  description: string;
  descriptionHtml?: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

/** Compatibility names shared with the importer and existing callers. */
export const galleryTextToShopifyHtml = plainDescriptionToHtml;
export const shopifyHtmlToGalleryText = descriptionTextFromHtml;

export function visibleCopyFromProduct(product: Pick<ShopifyProductSnapshot, "title" | "descriptionHtml" | "seoTitle" | "seoDescription">): ShopifyVisibleCopy {
  return {
    title: product.title,
    description: shopifyHtmlToGalleryText(product.descriptionHtml),
    descriptionHtml: product.descriptionHtml,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
  };
}

type ShopifyCopySnapshot = Pick<ShopifyProductSnapshot, "id" | "title" | "descriptionHtml" | "seoTitle" | "seoDescription">;
type ShopifyCopyPatch = {
  id: string;
  title?: string;
  descriptionHtml?: string;
  seo?: { title?: string | null; description?: string | null };
};

/** Send only changed fields. Untouched Shopify rich HTML must never be rewritten. */
export function buildShopifyVisibleCopyInput(productGid: string, copy: ShopifyVisibleCopy, current: ShopifyCopySnapshot): ShopifyCopyPatch {
  if (current.id !== productGid) throw new Error("SYNC_SHOPIFY_PRODUCT_IDENTITY_CONFLICT");
  const previous = visibleCopyFromProduct(current);
  const patch: ShopifyCopyPatch = { id: productGid };
  if (copy.title !== previous.title) patch.title = copy.title;
  const descriptionEdited = copy.description !== previous.description ||
    (typeof copy.descriptionHtml === "string" &&
      canonicalDescriptionHtml(copy.descriptionHtml) !== canonicalDescriptionHtml(current.descriptionHtml));
  if (descriptionEdited) {
    const html = copy.descriptionHtml ?? galleryTextToShopifyHtml(copy.description);
    if (typeof copy.descriptionHtml === "string" && descriptionTextFromHtml(html) !== copy.description) {
      throw new Error("SYNC_DESCRIPTION_PAIR_MISMATCH");
    }
    assertSafeDescriptionHtml(html);
    patch.descriptionHtml = html;
  }
  const seo: NonNullable<ShopifyCopyPatch["seo"]> = {};
  if (copy.seoTitle !== previous.seoTitle) seo.title = copy.seoTitle;
  if (copy.seoDescription !== previous.seoDescription) seo.description = copy.seoDescription;
  if (Object.keys(seo).length) patch.seo = seo;
  return patch;
}

export async function writeShopifyVisibleCopy(productGid: string, copy: ShopifyVisibleCopy, current: ShopifyCopySnapshot): Promise<void> {
  const product = buildShopifyVisibleCopyInput(productGid, copy, current);
  if (Object.keys(product).length === 1) return;
  const result = await graphql<{
    productUpdate: { product: null | { id: string }; userErrors: Array<{ field: string[] | null; message: string }> };
  }>(UPDATE_PRODUCT_COPY_MUTATION, {
    product,
  });
  const errors = result.productUpdate?.userErrors ?? [];
  if (errors.length) throw new Error("SHOPIFY_PRODUCT_COPY_WRITE_REJECTED");
  if (result.productUpdate?.product?.id !== productGid) throw new Error("SHOPIFY_PRODUCT_COPY_WRITE_MISSING");
}
