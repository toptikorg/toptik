// Owner-approved 2026-10-03: these existing colors are Shopify-owned projections.
// This is not permission to admit arbitrary multi-variant products.
export const MD20_PRODUCT_GID = "gid://shopify/Product/7512404951290";
export const MD20_PRODUCT_HANDLE = "md-20-תיק-פאוץ-מבית-מנדרינה-דאק";
// Pre-existing unassigned media verified on 2026-10-03. Do not infer their
// colors or expose them in the gallery; new unassigned media requires review.
export const MD20_LEGACY_UNASSIGNED_MEDIA = new Set([
  "28993546911994", "28993552711930", "28993554645242", "28993555792122",
  "28993600979194", "28993602846970", "28993604747514", "28993606516986",
  "28993608646906", "28993609924858", "28993610973434", "28993611596026",
].map(id => `gid://shopify/MediaImage/${id}`));
export const MD20_VARIANTS = [
  { sku: "P10QMMM1651", variantId: "42307603103994", itemId: "e78b4341-95ae-56e2-ba11-58c2d1e15f8e", color: "שחור" },
  { sku: "P10QMMM1465", variantId: "42307603136762", itemId: "973d074a-ace0-5225-90e6-8f348d9b3e1c", color: "פלדה" },
  { sku: "P10QMMM109K", variantId: "42307603169530", itemId: "63110328-f35d-5247-8793-48abc8450124", color: "טאופה" },
] as const;

/** Verified color belongs to this exact SKU/variant, never the parent's first color. */
export function exactVariantSeo(copy: { title: string; seoTitle?: string | null; seoDescription?: string | null }, sku: string) {
  const variant = SHOPIFY_OWNED_VARIANTS.find(v => v.sku === sku);
  if (!variant) throw new Error("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT");
  const suffix = ` בצבע ${variant.color}`;
  const seoTitle = (copy.seoTitle?.trim() || copy.title.trim()) + suffix;
  if (seoTitle.length > 120) throw new Error("SYNC_ONBOARDING_COPY_LIMIT");
  const sentences = (copy.seoDescription?.trim() || copy.title.trim()).split(/\.\s+/);
  // Keep complete original sentences, add only the reviewed variant color.
  let seoDescription = sentences[0].replace(/\.$/, "") + suffix + ".";
  if (seoDescription.length > 160) throw new Error("SYNC_ONBOARDING_COPY_LIMIT");
  for (const sentence of sentences.slice(1)) {
    const complete = sentence.replace(/\.$/, "") + ".";
    if (seoDescription.length + complete.length + 1 > 160) break;
    seoDescription += " " + complete;
  }
  return { seoTitle, seoDescription };
}
export const SHOPIFY_OWNED_MESSAGE = "צבעי המוצר הזה מתעדכנים אוטומטית מהחנות. יש לערוך את המוצר ב-Shopify ואז לרענן את הגלריה.";
export function isShopifyOwnedVariant(itemId: string): boolean {
  return SHOPIFY_OWNED_VARIANTS.some(variant => variant.itemId === itemId);
}

type Media = { id: string; alt: string | null; status: string; mediaContentType: string;
  image?: { url: string; altText: string | null; width: number; height: number } | null };
export function exactVariantMedia(media: Media[], sku: string): Media[] {
  const selected = media.filter(entry => (entry.alt ?? "").includes(` | ${sku} | `));
  if (!selected.length || selected.length > 20) throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  const orders = selected.map(entry => Number(entry.alt?.match(/ (\d+)$/)?.[1]));
  if (orders.some(order => !Number.isSafeInteger(order) || order < 1) || new Set(orders).size !== orders.length ||
      new Set(selected.map(entry => entry.image?.url)).size !== selected.length ||
      selected.some(entry => entry.status !== "READY" || entry.mediaContentType !== "IMAGE" || !entry.image)) {
    throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  }
  return selected.sort((a, b) => Number(a.alt?.match(/ (\d+)$/)?.[1]) - Number(b.alt?.match(/ (\d+)$/)?.[1]));
}

// Four owner-approved FZT73 colors; exact Shopify identities verified 2026-10-13.
export const FZT73_PRODUCT_GID = "gid://shopify/Product/7524873044218";
export const FZT73_PRODUCT_HANDLE = "תיק-פאוץ-מעור-קלאסי-מבית-מנדרינה-דאק";
export const FZT73_VARIANTS = [
  {
    "sku": "P10FZT73001",
    "variantId": "42361904398586",
    "itemId": "341df0c7-7a31-4e77-87c0-a683082c3cd7",
    "color": "שחור"
  },
  {
    "sku": "P10FZT7308Q",
    "variantId": "42449044799738",
    "itemId": "78e341a9-90f8-4b5a-a215-8bdf5f4f5321",
    "color": "כחול"
  },
  {
    "sku": "P10FZT7324B",
    "variantId": "42449044832506",
    "itemId": "7bd35662-0989-4b96-aafd-f6a77ba6d72f",
    "color": "תכלת"
  },
  {
    "sku": "P10FZT7327D",
    "variantId": "42449044865274",
    "itemId": "8890d9f2-d927-42e2-9006-f287a46ef137",
    "color": "צ'אי הודי (חום)"
  }
] as const;
export const SHOPIFY_OWNED_VARIANTS = [...MD20_VARIANTS, ...FZT73_VARIANTS];
export const FZT73_MEDIA = [
  {
    "id": "gid://shopify/MediaImage/29053418373370",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_01.jpg?v=1643057405",
    "sku": "P10FZT73001"
  },
  {
    "id": "gid://shopify/MediaImage/29053419487482",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_02.jpg?v=1643057423",
    "sku": "P10FZT73001"
  },
  {
    "id": "gid://shopify/MediaImage/29053420273914",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_03.jpg?v=1643057436",
    "sku": "P10FZT73001"
  },
  {
    "id": "gid://shopify/MediaImage/29053420699898",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_04.jpg?v=1643057448",
    "sku": "P10FZT73001"
  },
  {
    "id": "gid://shopify/MediaImage/29184367034618",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_08Q_01.jpg?v=1645446059",
    "sku": "P10FZT7308Q"
  },
  {
    "id": "gid://shopify/MediaImage/29184369492218",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_08Q_02.jpg?v=1645446079",
    "sku": "P10FZT7308Q"
  },
  {
    "id": "gid://shopify/MediaImage/29184371425530",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_08Q_03.jpg?v=1645446094",
    "sku": "P10FZT7308Q"
  },
  {
    "id": "gid://shopify/MediaImage/29184373162234",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_01.jpg?v=1645446116",
    "sku": "P10FZT7324B"
  },
  {
    "id": "gid://shopify/MediaImage/29184374472954",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_03.jpg?v=1645446137",
    "sku": "P10FZT7324B"
  },
  {
    "id": "gid://shopify/MediaImage/29184375718138",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_04.jpg?v=1645446160",
    "sku": "P10FZT7324B"
  },
  {
    "id": "gid://shopify/MediaImage/29184378339578",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_05.jpg?v=1645446192",
    "sku": "P10FZT7324B"
  },
  {
    "id": "gid://shopify/MediaImage/29184381190394",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_01.jpg?v=1645446229",
    "sku": "P10FZT7327D"
  },
  {
    "id": "gid://shopify/MediaImage/29184382140666",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_02.jpg?v=1645446251",
    "sku": "P10FZT7327D"
  },
  {
    "id": "gid://shopify/MediaImage/29184385057018",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_03.jpg?v=1645446301",
    "sku": "P10FZT7327D"
  },
  {
    "id": "gid://shopify/MediaImage/29184386695418",
    "url": "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_04.jpg?v=1645446322",
    "sku": "P10FZT7327D"
  }
] as const;
export function exactFzt73Media(media: Media[], sku: string): Media[] {
  const expected = FZT73_MEDIA.filter(m => m.sku === sku);
  const variant = FZT73_VARIANTS.find(v => v.sku === sku);
  if (!variant || media.length !== FZT73_MEDIA.length || new Set(media.map(m => m.id)).size !== media.length ||
      media.some(m => !FZT73_MEDIA.some(e => e.id === m.id && e.url === m.image?.url))) {
    throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
  }
  return expected.map((e,index) => {
    const entry = media.find(m => m.id === e.id);
    if (!entry?.image || entry.status !== "READY" || entry.mediaContentType !== "IMAGE") throw new Error("SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED");
    return {...entry, alt: entry.alt?.trim() || `פאוץ׳ עור Mandarina Duck Mellow Leather בצבע ${variant.color}, תמונה ${index + 1}`};
  });
}
