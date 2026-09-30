import "server-only";
import { configuredShopifyDomain, shopifyAdminGraphql } from "./admin-api";
import { buildGalleryDraftCreateVariables, CREATION_SHOP, type CustomIdDefinition, type DraftCommercialSnapshot,
  type OwnedDraftSnapshot, type ReadyGalleryDraft, type buildGalleryDraftVariantVariables } from "./creation-policy";

const FIELDS = `id title descriptionHtml seo { title description } vendor status updatedAt
  resourcePublicationsCount(onlyPublished: false) { count }
  sourceId: metafield(namespace: $namespace, key: "source_item_id") { value }
  sourceHash: metafield(namespace: $namespace, key: "creation_source_hash") { value }
  variants(first: 2) { nodes { id sku price compareAtPrice barcode taxable inventoryItem { requiresShipping } } pageInfo { hasNextPage } }
  media(first: 11) { nodes { id alt status ... on MediaImage { image { url width height } } } pageInfo { hasNextPage } }`;
type ProductData = {
  id: string; title: string; descriptionHtml: string; seo: { title: string | null; description: string | null };
  vendor: string; status: string; updatedAt: string; resourcePublicationsCount: { count: number } | null;
  sourceId: { value: string } | null; sourceHash: { value: string } | null;
  variants: { nodes: Array<DraftCommercialSnapshot & { id: string; sku: string | null; inventoryItem: { requiresShipping: boolean } }>;
    pageInfo: { hasNextPage: boolean } };
  media: { nodes: DraftRemoteMedia[]; pageInfo: { hasNextPage: boolean } };
};
export type DraftRemoteMedia = { id: string; alt: string | null; status: string; image?: { url: string; width: number; height: number } | null };
export type DraftLookup = { snapshot: OwnedDraftSnapshot; media: DraftRemoteMedia[] };

function timeout(deadline: number) {
  const remaining = deadline - Date.now() - 2500;
  if (remaining < 1) throw new Error("SYNC_CREATION_TIME_BUDGET");
  if (configuredShopifyDomain() !== CREATION_SHOP) throw new Error("SYNC_CREATION_SHOP_CONFIG_INVALID");
  return Math.min(10000, remaining);
}
function decode(product: ProductData, namespace: string): DraftLookup {
  if (product.variants.pageInfo.hasNextPage || product.variants.nodes.length !== 1 || product.media.pageInfo.hasNextPage || product.media.nodes.length > 10 ||
      !product.resourcePublicationsCount || !Number.isInteger(product.resourcePublicationsCount.count)) throw new Error("SYNC_CREATION_REMOTE_IDENTITY_INVALID");
  const variant = product.variants.nodes[0];
  return { snapshot: { productGid: product.id, variantGid: variant.id, variantCount: 1, sku: variant.sku ?? "",
    status: product.status, publishedAnywhere: product.resourcePublicationsCount.count !== 0,
    customId: { namespace, key: "source_item_id", value: product.sourceId?.value ?? "" }, sourceFingerprint: product.sourceHash?.value ?? "",
    updatedAt: product.updatedAt, brand: product.vendor,
    copy: { title: product.title, descriptionHtml: product.descriptionHtml, seoTitle: product.seo.title, seoDescription: product.seo.description },
    commercial: { price: variant.price, compareAtPrice: variant.compareAtPrice, barcode: variant.barcode,
      taxable: variant.taxable, requiresShipping: variant.inventoryItem.requiresShipping } }, media: product.media.nodes };
}

/** Reads actual installed app identity/currency and existing unique definition;
 * this route never silently creates or changes a Shopify definition. */
export async function readCreationShopConfiguration(deadline: number) {
  const config = await shopifyAdminGraphql<{ shop: { currencyCode: string }; currentAppInstallation: { app: { id: string } } }>(
    `query GalleryDraftShopConfig { shop { currencyCode } currentAppInstallation { app { id } } }`, {}, timeout(deadline));
  const appId = /^gid:\/\/shopify\/App\/([1-9][0-9]*)$/.exec(config.currentAppInstallation?.app?.id ?? "")?.[1];
  if (!appId) throw new Error("SYNC_CREATION_APP_IDENTITY_INVALID");
  const namespace = `app--${appId}--toptik_gallery`;
  const definitions = await shopifyAdminGraphql<{ metafieldDefinitions: { nodes: Array<{ namespace: string; key: string; ownerType: string;
    type: { name: string }; capabilities: { uniqueValues: { enabled: boolean } } }>; pageInfo: { hasNextPage: boolean } } }>(
    `query GalleryDraftUniqueDefinition($namespace: String!) {
      metafieldDefinitions(first: 2, ownerType: PRODUCT, namespace: $namespace, key: "source_item_id") {
        nodes { namespace key ownerType type { name } capabilities { uniqueValues { enabled } } } pageInfo { hasNextPage }
      }
    }`, { namespace }, timeout(deadline));
  const node = definitions.metafieldDefinitions.nodes[0];
  if (definitions.metafieldDefinitions.pageInfo.hasNextPage || definitions.metafieldDefinitions.nodes.length !== 1 || !node) throw new Error("SYNC_CREATION_CUSTOM_ID_DEFINITION_MISSING");
  const definition: CustomIdDefinition = { namespace: node.namespace, key: node.key, ownerType: node.ownerType,
    type: node.type.name, uniqueValuesEnabled: node.capabilities.uniqueValues.enabled };
  return { namespace, currency: config.shop.currencyCode, definition };
}

export async function lookupCreatedGalleryDraft(ready: ReadyGalleryDraft, deadline: number): Promise<DraftLookup | null> {
  const result = await shopifyAdminGraphql<{ productByIdentifier: ProductData | null }>(
    `query GalleryDraftRecovery($identifier: ProductIdentifierInput!, $namespace: String!) {
      productByIdentifier(identifier: $identifier) { ${FIELDS} }
    }`, { identifier: { customId: ready.customId }, namespace: ready.customId.namespace }, timeout(deadline));
  return result.productByIdentifier ? decode(result.productByIdentifier, ready.customId.namespace) : null;
}

export async function createGalleryShopifyDraft(ready: ReadyGalleryDraft, deadline: number): Promise<OwnedDraftSnapshot> {
  if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_GALLERY_CREATE_MODE !== "draft_only") throw new Error("SYNC_CREATION_NOT_ENABLED");
  const variables = buildGalleryDraftCreateVariables(ready);
  const result = await shopifyAdminGraphql<{ productCreate: { product: ProductData | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    `mutation GalleryCreateOwnedDraft($product: ProductCreateInput!, $media: [CreateMediaInput!], $namespace: String!) {
      productCreate(product: $product, media: $media) { product { ${FIELDS} } userErrors { field message } }
    }`, { ...variables, namespace: ready.customId.namespace }, timeout(deadline));
  if (result.productCreate?.userErrors?.length || !result.productCreate?.product) throw new Error("SYNC_CREATION_PRODUCT_CREATE_REJECTED");
  return decode(result.productCreate.product, ready.customId.namespace).snapshot;
}

export async function configureGalleryDraftVariant(variables: ReturnType<typeof buildGalleryDraftVariantVariables>, deadline: number): Promise<void> {
  if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_GALLERY_CREATE_MODE !== "draft_only") throw new Error("SYNC_CREATION_NOT_ENABLED");
  const result = await shopifyAdminGraphql<{ productVariantsBulkUpdate: { productVariants: Array<{ id: string }>; userErrors: Array<{ field: string[]; message: string }> } }>(
    `mutation GalleryConfigureOwnedDraft($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $allowPartialUpdates: Boolean!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: $allowPartialUpdates) {
        productVariants { id } userErrors { field message }
      }
    }`, variables, timeout(deadline));
  const payload = result.productVariantsBulkUpdate;
  if (!payload || payload.userErrors.length || payload.productVariants.length !== 1 || payload.productVariants[0].id !== variables.variants[0].id) {
    throw new Error("SYNC_CREATION_VARIANT_WRITE_REJECTED");
  }
}

export async function fetchCreationVariantIdentities(deadline: number) {
  const rows: Array<{ productGid: string; variantGid: string; sku: string | null; status: string }> = [];
  let after: string | null = null;
  do {
    const page: { productVariants: { nodes: Array<{ id: string; sku: string | null; product: { id: string; status: string } }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await shopifyAdminGraphql(
      `query GalleryCreationAllSkuIdentities($after: String) { productVariants(first: 250, after: $after) {
        nodes { id sku product { id status } } pageInfo { hasNextPage endCursor }
      } }`, { after }, timeout(deadline));
    rows.push(...page.productVariants.nodes.map(row => ({ productGid: row.product.id, variantGid: row.id, sku: row.sku, status: row.product.status })));
    if (!page.productVariants.pageInfo.hasNextPage) return rows;
    after = page.productVariants.pageInfo.endCursor;
    if (!after || rows.length >= 5000) throw new Error("SYNC_CREATION_CATALOG_LIMIT");
  } while (true);
}
