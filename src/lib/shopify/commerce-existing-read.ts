import "server-only";
import { z } from "zod";
import { configuredShopifyDomain, shopifyAdminGraphql } from "./admin-api";
import { API_VERSION, PUBLICATION, SHOP, fingerprint } from "./commerce-finalization";
import { boundCommerceIdentitySchema, boundCommerceSnapshotSchema, type BoundCommerceIdentity, type BoundCommerceSnapshot } from "./commerce-existing";

export const BOUND_COMMERCE_QUERY = `query BoundCommerceRead($id:ID!,$publication:ID!){
 shop{currencyCode}
 product(id:$id){id handle status updatedAt title descriptionHtml vendor seo{title description}
  publishedOnPublication(publicationId:$publication)
  media(first:250){nodes{id alt mediaContentType status} pageInfo{hasNextPage}}
  variants(first:2){nodes{id sku updatedAt price compareAtPrice barcode taxable publishedOnPublication(publicationId:$publication)
   inventoryItem{id updatedAt tracked requiresShipping}}
   pageInfo{hasNextPage}}
 }
}`;
const timestamp = z.string().datetime({ offset: true });
const rawSchema = z.object({ shop: z.object({ currencyCode: z.string().regex(/^[A-Z]{3}$/) }), product: z.object({
  id: z.string(), handle: z.string(), status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]), updatedAt: timestamp,
  title: z.string(), descriptionHtml: z.string(), vendor: z.string(), seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
  publishedOnPublication: z.boolean(), media: z.object({ nodes: z.array(z.object({ id: z.string(), alt: z.string().nullable(), mediaContentType: z.string(), status: z.string() })).max(250), pageInfo: z.object({ hasNextPage: z.literal(false) }) }),
  variants: z.object({ nodes: z.array(z.object({ id: z.string(), sku: z.string(), updatedAt: timestamp, price: z.string(), compareAtPrice: z.string().nullable(), barcode: z.string().nullable(), taxable: z.boolean(), publishedOnPublication: z.boolean(),
    inventoryItem: z.object({ id: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/[1-9][0-9]*$/), updatedAt: timestamp, tracked: z.boolean(), requiresShipping: z.boolean() }) })).length(1), pageInfo: z.object({ hasNextPage: z.literal(false) }) }),
}) }).strict();
export function parseBoundCommerceRead(value: unknown, rawIdentity: BoundCommerceIdentity): BoundCommerceSnapshot {
  const identity = boundCommerceIdentitySchema.parse(rawIdentity), raw = rawSchema.parse(value), p = raw.product, v = p.variants.nodes[0];
  if (p.id !== identity.productGid || p.handle !== identity.handle || v.id !== identity.variantGid || v.sku !== identity.sku) throw new Error("FINALIZE_EDIT_IDENTITY_CHANGED");
  if (new Set(p.media.nodes.map(m => m.id)).size !== p.media.nodes.length) throw new Error("FINALIZE_EDIT_MEDIA_INVALID");
  return boundCommerceSnapshotSchema.parse({ identity, currency: raw.shop.currencyCode,
    fields: { price: v.price, compareAtPrice: v.compareAtPrice, barcode: v.barcode, taxable: v.taxable, requiresShipping: v.inventoryItem.requiresShipping, status: p.status },
    tracked: v.inventoryItem.tracked, productUpdatedAt: p.updatedAt, variantUpdatedAt: v.updatedAt, inventoryUpdatedAt: v.inventoryItem.updatedAt,
    publication: p.publishedOnPublication, variantPublication: v.publishedOnPublication,
    protectedHash: fingerprint({ title: p.title, descriptionHtml: p.descriptionHtml, seo: p.seo, vendor: p.vendor, media: p.media.nodes, inventoryItemId: v.inventoryItem.id }),
  });
}
export async function readBoundCommerce(identity: BoundCommerceIdentity, deadline: number) {
  if (configuredShopifyDomain() !== SHOP || (process.env.SHOPIFY_API_VERSION?.trim() || API_VERSION) !== API_VERSION ||
      process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim() !== PUBLICATION) throw new Error("FINALIZE_CONFIG_MISMATCH");
  if (deadline <= Date.now()) throw new Error("FINALIZE_TIME_BUDGET");
  return parseBoundCommerceRead(await shopifyAdminGraphql(BOUND_COMMERCE_QUERY, { id: identity.productGid, publication: PUBLICATION }, Math.min(6000, deadline - Date.now()), deadline), identity);
}
