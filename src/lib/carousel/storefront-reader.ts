import "server-only";

/** Public, read-only Storefront data. This module never reads credentials or writes stock. */
export const STOREFRONT_ENDPOINT =
  "https://toptikcoil.myshopify.com/api/2026-07/graphql.json";

export type StorefrontImage = {
  id: string | null;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
};
export type StorefrontCollection = { id: string; handle: string; title: string };
export type StorefrontVariant = {
  id: string;
  sku: string | null;
  title: string;
  availableForSale: boolean;
  price: { amount: string; currencyCode: string };
  image: StorefrontImage | null;
  selectedOptions: { name: string; value: string }[];
};
export type StorefrontProduct = {
  id: string;
  handle: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  onlineStoreUrl: string | null;
  availableForSale: boolean;
  updatedAt: string;
  images: StorefrontImage[];
  collections: StorefrontCollection[];
  variants: StorefrontVariant[];
};
export type StorefrontSnapshot = { products: StorefrontProduct[]; fetchedAt: string };

const IMAGE_FIELDS = "id url altText width height";
const VARIANT_FIELDS = `id sku title availableForSale price { amount currencyCode }
  image { ${IMAGE_FIELDS} } selectedOptions { name value }`;
const CHILD_FIELDS = {
  images: IMAGE_FIELDS,
  collections: "id handle title",
  variants: VARIANT_FIELDS,
};
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

// Ten products with 30 initial children fit the tokenless complexity budget.
// Each connection is paginated independently when its first page is incomplete.
export const STOREFRONT_PRODUCTS_QUERY = `query GalleryProducts($after: String) {
  products(first: 10, after: $after, sortKey: ID) {
    nodes { id handle title description productType vendor onlineStoreUrl availableForSale updatedAt
      images(first: 30) { nodes { ${IMAGE_FIELDS} } ${PAGE_INFO} }
      collections(first: 30) { nodes { id handle title } ${PAGE_INFO} }
      variants(first: 30) { nodes { ${VARIANT_FIELDS} } ${PAGE_INFO} }
    }
    ${PAGE_INFO}
  }
}`;
type ChildConnection = keyof typeof CHILD_FIELDS;
export function storefrontChildQuery(connection: ChildConnection): string {
  return `query GalleryProductPage($id: ID!, $after: String) {
    product(id: $id) { id ${connection}(first: 30, after: $after) {
      nodes { ${CHILD_FIELDS[connection]} } ${PAGE_INFO}
    } }
  }`;
}

export class StorefrontReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StorefrontReadError";
    this.code = code;
  }
}

const DEFAULT_LIMITS = {
  maxRequests: 500,
  maxPages: 100,
  maxProducts: 2000,
  requestTimeoutMs: 8000,
  maxDurationMs: 45000,
} as const;
export type StorefrontReaderOptions = {
  fetchImpl?: typeof fetch;
  limits?: Partial<{ [K in keyof typeof DEFAULT_LIMITS]: number }>;
};

function invalid(): never {
  throw new StorefrontReadError("INVALID_RESPONSE", "Incomplete or invalid Storefront response");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}
function id(value: unknown): string {
  const result = string(value);
  if (!result) invalid();
  return result;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
function dimension(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid();
  return value;
}
function image(value: unknown): StorefrontImage {
  const item = record(value);
  return {
    id: nullableString(item.id), url: id(item.url), altText: nullableString(item.altText),
    width: dimension(item.width), height: dimension(item.height),
  };
}
function collection(value: unknown): StorefrontCollection {
  const item = record(value);
  return { id: id(item.id), handle: string(item.handle), title: string(item.title) };
}
function variant(value: unknown): StorefrontVariant {
  const item = record(value);
  const price = record(item.price);
  const amount = string(price.amount);
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !Number.isFinite(Number(amount))) invalid();
  return {
    id: id(item.id), sku: nullableString(item.sku), title: string(item.title),
    availableForSale: boolean(item.availableForSale),
    price: { amount, currencyCode: id(price.currencyCode) },
    image: item.image === null ? null : image(item.image),
    selectedOptions: array(item.selectedOptions).map((value) => {
      const option = record(value);
      return { name: string(option.name), value: string(option.value) };
    }),
  };
}
function product(value: unknown): StorefrontProduct {
  const item = record(value);
  const updatedAt = string(item.updatedAt);
  if (!Number.isFinite(Date.parse(updatedAt))) invalid();
  return {
    id: id(item.id), handle: string(item.handle), title: string(item.title),
    description: string(item.description), productType: string(item.productType),
    vendor: string(item.vendor), onlineStoreUrl: nullableString(item.onlineStoreUrl),
    availableForSale: boolean(item.availableForSale), updatedAt,
    images: [], collections: [], variants: [],
  };
}

/**
 * Fetch every visible product and every page of its variants/images/collections.
 * Complete-or-throw: HTTP/GraphQL errors, disappeared products, malformed pages,
 * repeated cursors/IDs, or safety limits never become an empty/partial snapshot.
 * An empty successful snapshot is distinct from a failed or unknown catalog.
 * Unavailable products and null onlineStoreUrl are preserved; the projection
 * decides public inclusion, without interpreting stale warehouse quantities.
 * Pagination is not a transaction: Shopify can change during this bounded read.
 */
export async function readStorefrontSnapshot(
  options: StorefrontReaderOptions = {},
): Promise<StorefrontSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0 || limits[key] > DEFAULT_LIMITS[key]) {
      throw new StorefrontReadError("INVALID_LIMIT", `Invalid Storefront limit: ${key}`);
    }
  }
  const operation = new AbortController();
  const startedAt = Date.now();
  let requests = 0;
  const deadline = setTimeout(() => operation.abort(), limits.maxDurationMs);

  async function request(query: string, variables: Record<string, unknown>) {
    if (operation.signal.aborted) throw new StorefrontReadError("TIMEOUT", "Storefront read aborted");
    if (++requests > limits.maxRequests) {
      throw new StorefrontReadError("LIMIT_EXCEEDED", "Storefront request limit reached");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    operation.signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new StorefrontReadError("TIMEOUT", "Storefront request timed out"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      timer = setTimeout(() => controller.abort(), Math.min(
        limits.requestTimeoutMs,
        Math.max(1, limits.maxDurationMs - (Date.now() - startedAt)),
      ));
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(STOREFRONT_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new StorefrontReadError("HTTP_ERROR", `Storefront HTTP ${response.status}`);
          }
          const payload = record(await response.json());
          if (payload.errors !== undefined && array(payload.errors).length > 0) {
            throw new StorefrontReadError("GRAPHQL_ERROR", "Storefront GraphQL request failed");
          }
          return record(payload.data);
        })(),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof StorefrontReadError) throw error;
      throw new StorefrontReadError("NETWORK_ERROR", "Storefront request failed");
    } finally {
      clearTimeout(timer);
      operation.signal.removeEventListener("abort", onAbort);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    }
  }

  async function allPages<T extends { id: string | null; url?: string }>(
    firstPage: unknown,
    parse: (item: unknown) => T,
    next: (cursor: string) => Promise<unknown>,
    maxItems?: number,
  ): Promise<T[]> {
    const result: T[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let page = firstPage;
    for (let pageNumber = 1; ; pageNumber++) {
      if (pageNumber > limits.maxPages) {
        throw new StorefrontReadError("LIMIT_EXCEEDED", "Storefront page limit reached");
      }
      const connection = record(page);
      const nodes = array(connection.nodes);
      for (const node of nodes) {
        const item = parse(node);
        // Image.id is nullable in Storefront; its required URL is the fallback
        // identity. Product/variant/collection IDs must still be nonempty.
        const identity = item.id || item.url;
        if (!identity || ids.has(identity)) invalid();
        ids.add(identity);
        result.push(item);
        if (maxItems !== undefined && result.length > maxItems) {
          throw new StorefrontReadError("LIMIT_EXCEEDED", "Storefront product limit reached");
        }
      }
      const pageInfo = record(connection.pageInfo);
      const hasNextPage = boolean(pageInfo.hasNextPage);
      const cursor = nullableString(pageInfo.endCursor);
      if (!hasNextPage) return result;
      if (!nodes.length || !cursor || cursors.has(cursor)) invalid();
      cursors.add(cursor);
      if (pageNumber >= limits.maxPages) {
        throw new StorefrontReadError("LIMIT_EXCEEDED", "Storefront page limit reached");
      }
      page = await next(cursor);
    }
  }

  try {
    const details = new Map<string, Record<string, unknown>>();
    const first = await request(STOREFRONT_PRODUCTS_QUERY, { after: null });
    const products = await allPages(first.products, (value) => {
      const parsed = product(value);
      details.set(parsed.id, record(value));
      return parsed;
    }, async (after) =>
      (await request(STOREFRONT_PRODUCTS_QUERY, { after })).products, limits.maxProducts);
    // At most four child-page requests concurrently; each is one product/list.
    let offset = 0;
    async function worker() {
      while (offset < products.length) {
        const target = products[offset++];
        const detail = record(details.get(target.id));
        const next = (connection: ChildConnection) => async (after: string) => {
          const result = await request(storefrontChildQuery(connection), { id: target.id, after });
          const node = record(result.product);
          if (node.id !== target.id) invalid();
          return node[connection];
        };
        target.images = await allPages(detail.images, image, next("images"));
        target.collections = await allPages(detail.collections, collection, next("collections"));
        target.variants = await allPages(detail.variants, variant, next("variants"));
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, products.length) }, worker));
    if (operation.signal.aborted) throw new StorefrontReadError("TIMEOUT", "Storefront read aborted");
    return { products, fetchedAt: new Date().toISOString() };
  } finally {
    clearTimeout(deadline);
    operation.abort();
  }
}

/** Cache only successful complete snapshots; never serve expired data on error. */
export function createStorefrontReader(
  options: StorefrontReaderOptions & { cacheTtlMs?: number; now?: () => number } = {},
): () => Promise<StorefrontSnapshot> {
  const ttl = Math.min(60000, Math.max(0, options.cacheTtlMs ?? 60000));
  if (!Number.isFinite(ttl)) throw new StorefrontReadError("INVALID_LIMIT", "Invalid cache TTL");
  const now = options.now ?? Date.now;
  let cached: { snapshot: StorefrontSnapshot; expiresAt: number } | undefined;
  let pending: Promise<StorefrontSnapshot> | undefined;
  return async () => {
    if (cached && now() < cached.expiresAt) return structuredClone(cached.snapshot);
    cached = undefined;
    if (!pending) {
      pending = readStorefrontSnapshot(options).then((snapshot) => {
        cached = { snapshot, expiresAt: now() + ttl };
        return snapshot;
      }).finally(() => { pending = undefined; });
    }
    return structuredClone(await pending);
  };
}

const defaultReader = createStorefrontReader();
export function getStorefrontSnapshot(): Promise<StorefrontSnapshot> {
  return defaultReader();
}
