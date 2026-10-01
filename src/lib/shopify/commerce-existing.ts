import { z } from "zod";
import { fingerprint } from "./commerce-finalization";

const gid = (type: string) => z.string().regex(new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`));
const money = z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/).transform(v => Number(v).toFixed(2));
export const boundCommerceIdentitySchema = z.object({ itemId: z.string().uuid(), catalogKey: z.string().min(2).max(64),
  exactGallerySku: z.string().min(2).max(64), sku: z.string().min(2).max(64), productGid: gid("Product"), variantGid: gid("ProductVariant"),
  handle: z.string().regex(/^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$/).max(255), approvalId: z.string().min(1).max(200) }).strict();
export type BoundCommerceIdentity = z.infer<typeof boundCommerceIdentitySchema>;
export const boundCommerceFieldsSchema = z.object({ price: money, compareAtPrice: money.nullable(), barcode: z.string().max(64).nullable(),
  taxable: z.boolean(), requiresShipping: z.boolean(), status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]) }).strict();
export const boundCommerceSnapshotSchema = z.object({ identity: boundCommerceIdentitySchema, currency: z.string().regex(/^[A-Z]{3}$/),
  fields: boundCommerceFieldsSchema, tracked: z.boolean(), productUpdatedAt: z.string().datetime({ offset: true }),
  variantUpdatedAt: z.string().datetime({ offset: true }), inventoryUpdatedAt: z.string().datetime({ offset: true }),
  publication: z.boolean(), variantPublication: z.boolean(), protectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type BoundCommerceSnapshot = z.infer<typeof boundCommerceSnapshotSchema>;
export const boundCommercePatchSchema = boundCommerceFieldsSchema.partial().strict().superRefine((v, ctx) => {
  if (!Object.keys(v).length || ("status" in v && Object.keys(v).length !== 1)) ctx.addIssue({ code: "custom", message: "One field group per saved command" });
  if (v.price !== undefined && Number(v.price) <= 0) ctx.addIssue({ code: "custom", message: "Positive price required" });
});
export type BoundCommercePatch = z.infer<typeof boundCommercePatchSchema>;
export const boundCommerceEditSchema = z.object({ id: z.string().uuid(), itemId: z.string().uuid(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), patch: boundCommercePatchSchema }).strict();
export function planBoundCommerceEdit(raw: unknown, rawPatch: unknown) {
  const baseline = boundCommerceSnapshotSchema.parse(raw), patch = boundCommercePatchSchema.parse(rawPatch);
  const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => baseline.fields[key as keyof typeof patch] !== value)) as BoundCommercePatch;
  if (!Object.keys(changed).length) throw new Error("FINALIZE_EDIT_NO_CHANGE");
  const fields = { ...baseline.fields, ...changed };
  if ((changed.price !== undefined || changed.compareAtPrice !== undefined) && fields.compareAtPrice !== null && Number(fields.compareAtPrice) <= Number(fields.price)) throw new Error("FINALIZE_COMPARE_PRICE_INVALID");
  const status = changed.status !== undefined;
  const variables = status ? { product: { id: baseline.identity.productGid, status: changed.status } } : {
    productId: baseline.identity.productGid, variants: [{ id: baseline.identity.variantGid,
      ...Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "requiresShipping")),
      ...(changed.requiresShipping !== undefined ? { inventoryItem: { requiresShipping: changed.requiresShipping } } : {}) }],
  };
  const query = status
    ? "mutation BoundCommerceStatus($product:ProductUpdateInput!){productUpdate(product:$product){product{id} userErrors{field message}}}"
    : "mutation BoundCommerceVariant($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){productVariants{id} userErrors{field message}}}";
  return { baseline, expectedHash: fingerprint(baseline), patch: changed, desired: { ...baseline, fields },
    request: { query, variables, payload: status ? "productUpdate" : "productVariantsBulkUpdate" } };
}
export function boundCommerceSemantic(s: BoundCommerceSnapshot) {
  const { productUpdatedAt, variantUpdatedAt, inventoryUpdatedAt, ...rest } = s;
  void productUpdatedAt; void variantUpdatedAt; void inventoryUpdatedAt; return rest;
}
