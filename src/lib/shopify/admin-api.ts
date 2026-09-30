import "server-only";

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

type GraphqlError = { message?: string; extensions?: { code?: string } };

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
      userErrors { field message code }
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
  const token = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const publicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim();
  const version = process.env.SHOPIFY_API_VERSION?.trim() || "2026-07";
  if (!domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error("SHOPIFY_CONFIG_SHOP_DOMAIN_INVALID");
  }
  if (!token) throw new Error("SHOPIFY_CONFIG_ADMIN_TOKEN_MISSING");
  if (!publicationId || !/^gid:\/\/shopify\/Publication\/\d+$/.test(publicationId)) {
    throw new Error("SHOPIFY_CONFIG_PUBLICATION_ID_INVALID");
  }
  if (!/^20\d{2}-(01|04|07|10)$/.test(version)) throw new Error("SHOPIFY_CONFIG_API_VERSION_INVALID");
  return { domain, token, publicationId, version };
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

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { domain, token, version } = getConfig();
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
    const code = payload.errors[0]?.extensions?.code;
    throw new Error(code ? `SHOPIFY_GRAPHQL_${code}` : "SHOPIFY_GRAPHQL_ERROR");
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
  seoTitle: string | null;
  seoDescription: string | null;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Gallery descriptions are plain text; convert them to safe paragraph HTML. */
export function galleryTextToShopifyHtml(value: string): string {
  return value.split(/\r?\n{2,}/).map(paragraph => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
}

/** Keep the Gallery's plain-text editor readable when Shopify sends HTML. */
export function shopifyHtmlToGalleryText(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|blockquote)>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (entity, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    })
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function visibleCopyFromProduct(product: Pick<ShopifyProductSnapshot, "title" | "descriptionHtml" | "seoTitle" | "seoDescription">): ShopifyVisibleCopy {
  return {
    title: product.title,
    description: shopifyHtmlToGalleryText(product.descriptionHtml),
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
  };
}

export function buildShopifyVisibleCopyInput(productGid: string, copy: ShopifyVisibleCopy) {
  return {
    id: productGid,
    title: copy.title,
    descriptionHtml: galleryTextToShopifyHtml(copy.description),
    seo: { title: copy.seoTitle, description: copy.seoDescription },
  };
}

export async function writeShopifyVisibleCopy(productGid: string, copy: ShopifyVisibleCopy): Promise<void> {
  const result = await graphql<{
    productUpdate: { product: null | { id: string }; userErrors: Array<{ code?: string | null; message: string }> };
  }>(UPDATE_PRODUCT_COPY_MUTATION, {
    product: buildShopifyVisibleCopyInput(productGid, copy),
  });
  const errors = result.productUpdate?.userErrors ?? [];
  if (errors.length) throw new Error("SHOPIFY_PRODUCT_COPY_WRITE_REJECTED");
  if (result.productUpdate?.product?.id !== productGid) throw new Error("SHOPIFY_PRODUCT_COPY_WRITE_MISSING");
}
