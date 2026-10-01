import { MAX_EXISTING_MEDIA_PIXELS } from "./existing-media-limits";
import "server-only";
import { z } from "zod";
import { configuredShopifyDomain, shopifyAdminGraphql } from "./admin-api";
import { assertSafeDescriptionHtml, descriptionTextFromHtml } from "./description-document";
import { API_VERSION, PUBLICATION, SHOP, fingerprint, snapshotSchema, type Context, type Snapshot } from "./commerce-finalization";
import type { DraftMediaReadback } from "./creation-policy";

/** Reads only. These constants are also the exact queries used by schema/read-only probes. */
export const COMMERCE_CONFIG_QUERY = `query CommerceReadConfiguration {
  shop { myshopifyDomain currencyCode }
  currentAppInstallation { app { id } accessScopes { handle } }
  publication(id: "${PUBLICATION}") { id catalog { __typename } }
}`;
export const COMMERCE_LOCATIONS_QUERY = `query CommerceReadLocations($after: String) {
  locations(first: 25, after: $after, includeInactive: true, includeLegacy: true) {
    nodes { id isActive fulfillsOnlineOrders isFulfillmentService fulfillmentService { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const COMMERCE_CATALOG_QUERY = `query CommerceReadAllVariantIdentities($after: String) {
  productVariants(first: 250, after: $after, sortKey: ID) {
    nodes { id sku product { id status } } pageInfo { hasNextPage endCursor }
  }
}`;
const PUBLICATIONS = `nodes { isPublished publishDate publication { id } } pageInfo { hasNextPage }`;
const METAFIELDS = `nodes { namespace key type value } pageInfo { hasNextPage }`;
export const COMMERCE_PRODUCT_QUERY = `query CommerceReadOwnedProduct($productId: ID!, $variantId: ID!, $namespace: String!) {
  product(id: $productId) {
    id handle vendor status updatedAt title descriptionHtml seo { title description }
    productType tags templateSuffix isGiftCard requiresSellingPlan category { id }
    options { id name position values }
    sourceId: metafield(namespace: $namespace, key: "source_item_id") { namespace key type value }
    sourceHash: metafield(namespace: $namespace, key: "creation_source_hash") { namespace key type value }
    metafields(first: 100) { ${METAFIELDS} }
    variants(first: 2) { nodes { id sku } pageInfo { hasNextPage } }
    publications: resourcePublicationsV2(first: 100, onlyPublished: false, catalogType: APP) { ${PUBLICATIONS} }
    marketPublications: resourcePublicationsV2(first: 100, onlyPublished: false, catalogType: MARKET) { ${PUBLICATIONS} }
    companyPublications: resourcePublicationsV2(first: 100, onlyPublished: false, catalogType: COMPANY_LOCATION) { ${PUBLICATIONS} }
    media(first: 11, sortKey: POSITION) { nodes { id mediaContentType status alt
      ... on MediaImage { fileStatus updatedAt image { id url width height } }
    } pageInfo { hasNextPage } }
  }
  productVariant(id: $variantId) {
    id sku product { id } updatedAt price compareAtPrice barcode taxable inventoryPolicy
    publishedOnPublication(publicationId: "${PUBLICATION}")
    requiresComponents selectedOptions { name value } unitPrice { amount currencyCode }
    productParents(first: 1) { nodes { id } pageInfo { hasNextPage } }
    productVariantComponents(first: 1) { nodes { id } pageInfo { hasNextPage } }
    sellingPlanGroups(first: 1) { nodes { id } pageInfo { hasNextPage } }
    metafields(first: 100) { ${METAFIELDS} }
    image { id url }
    media(first: 11) { nodes { id } pageInfo { hasNextPage } }
    inventoryItem { id sku updatedAt tracked requiresShipping trackedEditable { locked }
      countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode unitCost { amount currencyCode }
      measurement { weight { value unit } }
      countryHarmonizedSystemCodes(first: 100) { nodes { countryCode harmonizedSystemCode } pageInfo { hasNextPage } }
      variants(first: 2) { nodes { id } pageInfo { hasNextPage } }
    }
  }
}`;
export const COMMERCE_LEVELS_QUERY = `query CommerceReadInventoryLevels($id: ID!, $after: String) {
  inventoryItem(id: $id) { id updatedAt inventoryLevels(first: 20, after: $after, includeInactive: true) {
    nodes { id isActive item { id } location { id }
      quantities(names: ["available", "on_hand", "committed", "reserved", "damaged", "safety_stock", "quality_control", "incoming"]) { name quantity }
    } pageInfo { hasNextPage endCursor }
  } }
}`;

const gid = (kind: string) => z.string().regex(new RegExp(`^gid://shopify/${kind}/[1-9][0-9]*$`));
const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const page = z.object({ hasNextPage: z.boolean() }).strict();
const cursorPage = page.extend({ endCursor: z.string().min(1).nullable() }).strict();
const nullableText = z.string().nullable();
const money = z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/).transform(value => Number(value).toFixed(2));
const amount = z.object({ amount: money, currencyCode: z.string().regex(/^[A-Z]{3}$/) }).strict();
const metafield = z.object({ namespace: z.string().min(1), key: z.string().min(1), type: z.string().min(1), value: z.string().max(2000000) }).strict();
const connection = <T extends z.ZodType>(node: T, max: number) => z.object({ nodes: z.array(node).max(max), pageInfo: page }).strict();
const idNode = z.object({ id: z.string().min(1) }).strict();
const publication = z.object({ isPublished: z.boolean(), publishDate: iso.nullable(), publication: z.object({ id: gid("Publication") }).strict() }).strict();
const mediaImage = z.object({ id: gid("MediaImage"), mediaContentType: z.literal("IMAGE"), status: z.literal("READY"),
  alt: nullableText, fileStatus: z.literal("READY"), updatedAt: iso,
  image: z.object({ id: gid("ImageSource"), url: z.string().url(), width: z.number().int().positive().max(16000), height: z.number().int().positive().max(16000) }).strict() }).strict();
const productSchema = z.object({
  id: gid("Product"), handle: snapshotSchema.shape.identity.shape.handle, vendor: snapshotSchema.shape.identity.shape.brand,
  status: z.enum(["DRAFT", "ACTIVE"]), updatedAt: iso, title: z.string().min(1).max(120), descriptionHtml: z.string().max(200000),
  seo: z.object({ title: nullableText, description: nullableText }).strict(), productType: z.string(), tags: z.array(z.string()).max(250),
  templateSuffix: nullableText, isGiftCard: z.literal(false), requiresSellingPlan: z.literal(false), category: idNode.nullable(),
  options: z.array(z.object({ id: gid("ProductOption"), name: z.string(), position: z.number().int().positive(), values: z.array(z.string()).max(250) }).strict()).max(3),
  sourceId: metafield, sourceHash: metafield, metafields: connection(metafield, 100),
  variants: connection(z.object({ id: gid("ProductVariant"), sku: nullableText }).strict(), 2),
  publications: connection(publication, 100), marketPublications: connection(publication, 100), companyPublications: connection(publication, 100),
  media: connection(mediaImage, 10),
}).strict();
const variantSchema = z.object({
  id: gid("ProductVariant"), sku: nullableText, product: z.object({ id: gid("Product") }).strict(), updatedAt: iso,
  price: money, compareAtPrice: money.nullable(), barcode: nullableText, taxable: z.boolean(), inventoryPolicy: z.enum(["DENY", "CONTINUE"]),
  publishedOnPublication: z.boolean(), requiresComponents: z.literal(false), unitPrice: z.null(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(3),
  productParents: connection(idNode, 0), productVariantComponents: connection(idNode, 0), sellingPlanGroups: connection(idNode, 0),
  metafields: connection(metafield, 100), image: z.object({ id: gid("ProductImage"), url: z.string().url() }).strict().nullable(),
  media: connection(z.object({ id: gid("MediaImage") }).strict(), 10),
  inventoryItem: z.object({ id: gid("InventoryItem"), sku: nullableText, updatedAt: iso, tracked: z.boolean(), requiresShipping: z.boolean(),
    trackedEditable: z.object({ locked: z.boolean() }).strict(), countryCodeOfOrigin: nullableText, provinceCodeOfOrigin: nullableText,
    harmonizedSystemCode: nullableText, unitCost: amount.nullable(),
    measurement: z.object({ weight: z.object({ value: z.number().finite().nonnegative(), unit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]) }).strict().nullable() }).strict(),
    countryHarmonizedSystemCodes: connection(z.object({ countryCode: z.string(), harmonizedSystemCode: z.string() }).strict(), 100),
    variants: connection(z.object({ id: gid("ProductVariant") }).strict(), 2),
  }).strict(),
}).strict();
const productReadSchema = z.object({ product: productSchema, productVariant: variantSchema }).strict();
const configSchema = z.object({ shop: z.object({ myshopifyDomain: z.literal(SHOP), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  currentAppInstallation: z.object({ app: z.object({ id: gid("App") }).strict(), accessScopes: z.array(z.object({ handle: z.string().regex(/^[a-z_]+$/) }).strict()).max(100) }).strict(),
  publication: z.object({ id: z.literal(PUBLICATION), catalog: z.object({ __typename: z.literal("AppCatalog") }).strict() }).strict(),
}).strict();
const locationSchema = z.object({ id: gid("Location"), isActive: z.boolean(), fulfillsOnlineOrders: z.boolean(), isFulfillmentService: z.boolean(),
  fulfillmentService: idNode.nullable() }).strict();
const catalogNode = z.object({ id: gid("ProductVariant"), sku: nullableText, product: z.object({ id: gid("Product"), status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]) }).strict() }).strict();
const quantityNames = ["available", "on_hand", "committed", "reserved", "damaged", "safety_stock", "quality_control", "incoming"] as const;
const levelSchema = z.object({ id: z.string().regex(/^gid:\/\/shopify\/InventoryLevel\/[1-9][0-9]*\?inventory_item_id=[1-9][0-9]*$/),
  isActive: z.boolean(), item: z.object({ id: gid("InventoryItem") }).strict(), location: z.object({ id: gid("Location") }).strict(),
  quantities: z.array(z.object({ name: z.enum(quantityNames), quantity: z.number().int().min(0).max(1000000) }).strict()).length(8),
}).strict();

function fail(code: string): never { throw new Error(`FINALIZE_READ_${code}`); }
function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value); if (!result.success) fail(code); return result.data;
}
function unique(values: string[], code: string) { if (new Set(values).size !== values.length) fail(code); }
function complete(value: { pageInfo: { hasNextPage: boolean } }) { if (value.pageInfo.hasNextPage) fail("INCOMPLETE_CONNECTION"); }
function sortedFields(fields: z.infer<typeof metafield>[]) {
  unique(fields.map(value => `${value.namespace}:${value.key}`), "DUPLICATE_METAFIELD");
  return [...fields].sort((a, b) => `${a.namespace}:${a.key}`.localeCompare(`${b.namespace}:${b.key}`));
}
function safeImageUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "cdn.shopify.com" || url.port || url.username || url.password || url.hash ||
      !url.pathname.startsWith("/s/files/") || /%(?:2f|5c|00)/i.test(url.pathname)) fail("IMAGE_URL_INVALID");
}

/** Expected identity comes from the immutable creation receipt/frozen pending source.
 * On subsequent worker reads pass the complete plan.initial.identity to pin inventory/handle too. */
export type CommerceReadIdentity = Omit<Snapshot["identity"], "inventoryItemGid" | "handle"> & { inventoryItemGid?: string; handle?: string };
const identitySchema = snapshotSchema.shape.identity.partial({ inventoryItemGid: true, handle: true });
export type CommerceShopifySnapshot = Omit<Snapshot, "galleryRowFingerprint" | "galleryCopyVersion" | "galleryCopy">;
export type CommerceShopifyContext = Pick<Context, "shopDomain" | "apiVersion" | "shopCurrency" | "scopes" | "capturedAt" | "locations" | "locationsComplete" | "shopify" | "catalogCapturedAt">;
export type CommerceShopifyRead = { snapshot: CommerceShopifySnapshot; context: CommerceShopifyContext };
export type CommerceReadDependencies = {
  now(): number;
  query(query: string, variables: Record<string, unknown>, deadline: number): Promise<unknown>; // validated data object, not GraphQL envelope
  decode(image: { mediaGid: string; url: string; width: number; height: number; alt: string }, deadline: number): Promise<{
    mediaGid: string; url: string; width: number; height: number; mime: string; byteLength: number; sha256: string;
  }>;
};

export function parseCommerceConfiguration(raw: unknown, expected: CommerceReadIdentity, inventory = false) {
  const value = parse(configSchema, raw, "CONFIG_INVALID"), scopes = value.currentAppInstallation.accessScopes.map(scope => scope.handle).sort();
  unique(scopes, "DUPLICATE_SCOPE");
  if (`app--${value.currentAppInstallation.app.id.split("/").at(-1)}--toptik_gallery` !== expected.customId.namespace) fail("APP_IDENTITY_CHANGED");
  if (!["write_products", "write_publications", ...(inventory ? ["write_inventory"] : [])].every(scope => scopes.includes(scope))) fail("SCOPES_REQUIRED");
  return { scopes, shopCurrency: value.shop.currencyCode };
}

export function parseCommerceProduct(raw: unknown, expected: CommerceReadIdentity) {
  const data = parse(productReadSchema, raw, "PRODUCT_INVALID"), p = data.product, v = data.productVariant, i = v.inventoryItem;
  for (const c of [p.metafields, p.variants, p.publications, p.marketPublications, p.companyPublications, p.media,
    v.metafields, v.media, v.productParents, v.productVariantComponents, v.sellingPlanGroups, i.countryHarmonizedSystemCodes, i.variants]) complete(c);
  if (p.id !== expected.productGid || v.id !== expected.variantGid || v.product.id !== p.id || v.sku !== expected.sku || i.sku !== expected.sku ||
      p.vendor !== expected.brand || p.variants.nodes.length !== 1 || p.variants.nodes[0].id !== v.id || p.variants.nodes[0].sku !== expected.sku ||
      i.variants.nodes.length !== 1 || i.variants.nodes[0].id !== v.id || (expected.handle !== undefined && p.handle !== expected.handle) ||
      (expected.inventoryItemGid !== undefined && i.id !== expected.inventoryItemGid)) fail("IDENTITY_CHANGED");
  for (const [node, key, value] of [[p.sourceId, "source_item_id", expected.customId.value], [p.sourceHash, "creation_source_hash", expected.sourceFingerprint]] as const) {
    if (node.namespace !== expected.customId.namespace || node.key !== key || node.type !== "single_line_text_field" || node.value !== value) fail("SOURCE_IDENTITY_CHANGED");
    if (!p.metafields.nodes.some(field => fingerprint(field) === fingerprint(node))) fail("SOURCE_METAFIELD_INCOMPLETE");
  }
  if (!p.media.nodes.length) fail("IMAGE_REQUIRED");
  unique(p.media.nodes.map(m => m.id), "DUPLICATE_MEDIA"); unique(p.media.nodes.map(m => m.image.id), "DUPLICATE_IMAGE");
  unique(p.media.nodes.map(m => m.image.url), "DUPLICATE_IMAGE"); unique(v.media.nodes.map(m => m.id), "DUPLICATE_VARIANT_MEDIA");
  p.media.nodes.forEach(m => safeImageUrl(m.image.url));
  if (v.media.nodes.some(m => !p.media.nodes.some(image => image.id === m.id))) fail("VARIANT_MEDIA_CHANGED");
  // ProductImage and ImageSource are different namespaces. Never compare their numeric suffixes.
  if (v.image && !v.media.nodes.some(m => p.media.nodes.some(image => image.id === m.id && image.image.url === v.image!.url))) fail("VARIANT_IMAGE_CHANGED");
  if (!v.image && v.media.nodes.length) fail("VARIANT_IMAGE_CHANGED");
  const pubs = [...p.publications.nodes, ...p.marketPublications.nodes, ...p.companyPublications.nodes];
  unique(pubs.map(row => row.publication.id), "DUPLICATE_PUBLICATION");
  if (pubs.length > 100 || pubs.some(row => !row.isPublished)) fail("SCHEDULED_PUBLICATION_UNSUPPORTED");
  if (i.trackedEditable.locked) fail("INVENTORY_LOCKED");
  assertSafeDescriptionHtml(p.descriptionHtml);
  sortedFields(p.metafields.nodes); sortedFields(v.metafields.nodes);
  unique(i.countryHarmonizedSystemCodes.nodes.map(row => row.countryCode), "DUPLICATE_COUNTRY_CODE");
  return data;
}

/** Fully bounded, no network retry, no partial result, two image buffers at most.
 * All requests (including token acquisition) share the worker's original absolute deadline. */
export async function readCommerceShopify(rawIdentity: CommerceReadIdentity, deadline: number, deps: CommerceReadDependencies = productionDependencies(), inventoryMode = false): Promise<CommerceShopifyRead> {
  const expected = parse(identitySchema, rawIdentity, "EXPECTED_IDENTITY_INVALID"), started = deps.now();
  if (!Number.isFinite(deadline) || deadline <= started) fail("TIME_BUDGET");
  const end = Math.min(deadline, started + 8000);
  const check = () => { if (deps.now() >= end) fail("TIME_BUDGET"); };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    check(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("FINALIZE_READ_TIME_BUDGET")), Math.max(1, end - deps.now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const call = async (query: string, variables: Record<string, unknown>) => {
    const result = await bounded(() => deps.query(query, variables, end)); check(); return result;
  };
  const configRaw = await call(COMMERCE_CONFIG_QUERY, {}), config = parseCommerceConfiguration(configRaw, expected, inventoryMode);
  async function pages<T>(query: string, field: string, node: z.ZodType<T>, bound: number, batch: number, variables = {}) {
    const rows: T[] = [], cursors = new Set<string>(); let after: string | null = null;
    do {
      const raw = await call(query, { ...variables, after });
      const data = parse(z.object({ [field]: z.object({ nodes: z.array(node).max(batch), pageInfo: cursorPage }).strict() }).strict(), raw, "PAGE_INVALID")[field];
      rows.push(...data.nodes); if (rows.length > bound) fail("COLLECTION_LIMIT");
      if (!data.pageInfo.hasNextPage) return rows;
      if (!data.nodes.length || !data.pageInfo.endCursor || cursors.has(data.pageInfo.endCursor) || rows.length >= bound) fail("INCOMPLETE_CONNECTION");
      after = data.pageInfo.endCursor; cursors.add(after);
    } while (true);
  }
  const productVariables = { productId: expected.productGid, variantId: expected.variantGid, namespace: expected.customId.namespace };
  const [rawProduct, locations, catalog] = await Promise.all([
    call(COMMERCE_PRODUCT_QUERY, productVariables), inventoryMode ? pages(COMMERCE_LOCATIONS_QUERY, "locations", locationSchema, 100, 25) : Promise.resolve([]),
    pages(COMMERCE_CATALOG_QUERY, "productVariants", catalogNode, 10000, 250),
  ]);
  const first = parseCommerceProduct(rawProduct, expected), p = first.product, v = first.productVariant, inventory = v.inventoryItem;
  unique(locations.map(l => l.id), "DUPLICATE_LOCATION"); unique(catalog.map(row => row.id), "DUPLICATE_VARIANT");
  if (!catalog.some(row => row.id === v.id && row.product.id === p.id && row.sku === v.sku && row.product.status === p.status) ||
      catalog.filter(row => row.product.id === p.id).length !== 1) fail("CATALOG_IDENTITY_CHANGED");
  const readLevels = async () => {
    const rows: z.infer<typeof levelSchema>[] = [], cursors = new Set<string>(); let after: string | null = null;
    do {
      const raw = await call(COMMERCE_LEVELS_QUERY, { id: inventory.id, after });
      const data = parse(z.object({ inventoryItem: z.object({ id: gid("InventoryItem"), updatedAt: iso,
        inventoryLevels: z.object({ nodes: z.array(levelSchema).max(20), pageInfo: cursorPage }).strict() }).strict() }).strict(), raw, "LEVELS_INVALID").inventoryItem;
      if (data.id !== inventory.id || data.updatedAt !== inventory.updatedAt) fail("INVENTORY_CHANGED_DURING_READ");
      rows.push(...data.inventoryLevels.nodes); if (rows.length > 100) fail("COLLECTION_LIMIT");
      const info = data.inventoryLevels.pageInfo;
      if (!info.hasNextPage) break;
      if (!data.inventoryLevels.nodes.length || !info.endCursor || cursors.has(info.endCursor) || rows.length >= 100) fail("INCOMPLETE_CONNECTION");
      after = info.endCursor; cursors.add(after);
    } while (true);
    unique(rows.map(row => row.id), "DUPLICATE_LEVEL"); unique(rows.map(row => row.location.id), "DUPLICATE_LEVEL");
    return rows.map(row => {
      if (row.item.id !== inventory.id || !locations.some(l => l.id === row.location.id) || row.id.split("inventory_item_id=")[1] !== inventory.id.split("/").at(-1)) fail("LEVEL_IDENTITY_CHANGED");
      unique(row.quantities.map(q => q.name), "INVENTORY_STATES_INVALID");
      const q = Object.fromEntries(row.quantities.map(q => [q.name, q.quantity]));
      if (q.on_hand !== q.available + q.committed + q.reserved + q.damaged + q.safety_stock + q.quality_control) fail("INVENTORY_STATES_INVALID");
      return { locationId: row.location.id, active: row.isActive, quantities: { available: q.available, onHand: q.on_hand, committed: q.committed,
        reserved: q.reserved, damaged: q.damaged, safetyStock: q.safety_stock, qualityControl: q.quality_control, incoming: q.incoming } };
    }).sort((a, b) => a.locationId.localeCompare(b.locationId));
  };
  const decode = async () => {
    const media: DraftMediaReadback[] = [];
    for (let offset = 0; offset < p.media.nodes.length; offset += 2) {
      check();
      const chunk = p.media.nodes.slice(offset, offset + 2);
      const values = await Promise.all(chunk.map(m => bounded(() => deps.decode({ mediaGid: m.id, url: m.image.url, width: m.image.width, height: m.image.height, alt: m.alt ?? "" }, end))));
      check();
      values.forEach((raw, index) => {
        const m = chunk[index], value = parse(z.object({ mediaGid: gid("MediaImage"), url: z.string(), width: z.number().int(), height: z.number().int(),
          mime: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]), byteLength: z.number().int().positive().max(8388608), sha256: hash }).strict(), raw, "DECODE_INVALID");
        if (value.mediaGid !== m.id || value.url !== m.image.url || value.width !== m.image.width || value.height !== m.image.height || value.width * value.height > MAX_EXISTING_MEDIA_PIXELS) fail("DECODE_IDENTITY_CHANGED");
        media.push({ ...value, productGid: p.id, status: "READY", alt: m.alt ?? "", verifiedAt: new Date(started).toISOString() });
      });
    }
    return media;
  };
  const [levels, media] = await Promise.all([inventoryMode ? readLevels() : Promise.resolve([]), decode()]);
  // Complete association/copy/inventory and capability recheck; no cached proof is promoted to fresh.
  const [lastRaw, lastLevels, lastConfig, lastLocations, lastCatalog] = await Promise.all([
    call(COMMERCE_PRODUCT_QUERY, productVariables), inventoryMode ? readLevels() : Promise.resolve([]), call(COMMERCE_CONFIG_QUERY, {}),
    inventoryMode ? pages(COMMERCE_LOCATIONS_QUERY, "locations", locationSchema, 100, 25) : Promise.resolve([]), pages(COMMERCE_CATALOG_QUERY, "productVariants", catalogNode, 10000, 250),
  ]);
  const last = parseCommerceProduct(lastRaw, expected);
  if (fingerprint(first) !== fingerprint(last) || fingerprint(levels) !== fingerprint(lastLevels) || fingerprint(configRaw) !== fingerprint(lastConfig) ||
      fingerprint(locations) !== fingerprint(lastLocations) || fingerprint(catalog) !== fingerprint(lastCatalog)) fail("CHANGED_DURING_READ");
  check();
  const copy = { title: p.title, descriptionHtml: p.descriptionHtml, seoTitle: p.seo.title, seoDescription: p.seo.description };
  const stableMedia = media.map(value => { const { verifiedAt, ...stable } = value; void verifiedAt; return stable; });
  const snapshot: CommerceShopifySnapshot = {
    identity: { ...expected, inventoryItemGid: inventory.id, handle: p.handle }, variantCount: 1, productStatus: p.status,
    productUpdatedAt: p.updatedAt, variantUpdatedAt: v.updatedAt, inventoryUpdatedAt: inventory.updatedAt,
    publicationIds: [...p.publications.nodes, ...p.marketPublications.nodes, ...p.companyPublications.nodes].map(row => row.publication.id).sort(),
    variantOnlinePublished: v.publishedOnPublication,
    commercial: { price: v.price, compareAtPrice: v.compareAtPrice, barcode: v.barcode, taxable: v.taxable, inventoryPolicy: v.inventoryPolicy, tracked: inventory.tracked, requiresShipping: inventory.requiresShipping },
    levels, levelsComplete: inventoryMode, copyMediaFingerprint: fingerprint({ copy, media: stableMedia }), decodedImagesVerifiedAt: new Date(started).toISOString(),
    shopifyCopy: { ...copy, description: descriptionTextFromHtml(copy.descriptionHtml) },
    otherProductDataFingerprint: fingerprint({ productType: p.productType, tags: [...p.tags].sort(), templateSuffix: p.templateSuffix, category: p.category,
      options: p.options, productMetafields: sortedFields(p.metafields.nodes), variantMetafields: sortedFields(v.metafields.nodes),
      selectedOptions: v.selectedOptions, variantImage: v.image, variantMediaIds: v.media.nodes.map(m => m.id).sort(),
      mediaIdentity: p.media.nodes.map(m => ({ mediaId: m.id, imageId: m.image.id, url: m.image.url })) }),
    otherInventoryDataFingerprint: fingerprint({ countryCodeOfOrigin: inventory.countryCodeOfOrigin, provinceCodeOfOrigin: inventory.provinceCodeOfOrigin,
      harmonizedSystemCode: inventory.harmonizedSystemCode, unitCost: inventory.unitCost, measurement: inventory.measurement,
      countryHarmonizedSystemCodes: [...inventory.countryHarmonizedSystemCodes.nodes].sort((a, b) => a.countryCode.localeCompare(b.countryCode)) }),
  };
  return { snapshot, context: { shopDomain: SHOP, apiVersion: API_VERSION, shopCurrency: config.shopCurrency, scopes: config.scopes,
    capturedAt: new Date(started).toISOString(), catalogCapturedAt: new Date(started).toISOString(), locationsComplete: inventoryMode,
    locations: locations.map(l => ({ id: l.id, active: l.isActive, fulfillsOnlineOrders: l.fulfillsOnlineOrders,
      merchantManaged: !l.isFulfillmentService && l.fulfillmentService === null,
      inventoryWriteAllowed: config.scopes.includes("write_inventory") && !l.isFulfillmentService && l.fulfillmentService === null })),
    shopify: catalog.map(row => ({ productGid: row.product.id, variantGid: row.id, sku: row.sku })),
  } };
}

/** Supply fresh private DB state, never HTTP/client proof. The policy validates the
 * completed Context; this helper cannot manufacture lease or provenance authority. */
export type CommerceServerRead = Pick<Snapshot, "galleryRowFingerprint" | "galleryCopyVersion" | "galleryCopy"> & {
  context: Omit<Context, keyof CommerceShopifyContext>;
};
export function assembleCommerceRead(read: CommerceShopifyRead, server: CommerceServerRead): { snapshot: Snapshot; context: Context } {
  const { context, galleryRowFingerprint, galleryCopyVersion, galleryCopy } = server;
  const gallery = { galleryRowFingerprint, galleryCopyVersion, galleryCopy };
  return { snapshot: parse(snapshotSchema, { ...read.snapshot, ...gallery }, "SNAPSHOT_INVALID"), context: { ...context, ...read.context } };
}

function productionDependencies(): CommerceReadDependencies {
  if (configuredShopifyDomain() !== SHOP || (process.env.SHOPIFY_API_VERSION?.trim() || API_VERSION) !== API_VERSION ||
      process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim() !== PUBLICATION) fail("CONFIG_MISMATCH");
  return { now: Date.now,
    query: (query, variables, deadline) => shopifyAdminGraphql(query, variables, Math.min(8000, Math.max(1, deadline - Date.now())), deadline),
    decode: async (image, deadline) => {
      const { verifyOnboardingImage } = await import("./onboarding-worker");
      return verifyOnboardingImage({ id: image.mediaGid, alt: image.alt, mediaContentType: "IMAGE", status: "READY",
        image: { url: image.url, width: image.width, height: image.height, altText: image.alt } }, deadline);
    },
  };
}
