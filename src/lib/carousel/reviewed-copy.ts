import copyData from "./reviewed-copy.json";

type ReviewedCopy = {
  title: string;
  description: string;
  expectedLegacyTitle: string;
  expectedLegacyDescription: string | null;
  sourceUrls: string[];
};

const reviewedCopies = copyData as Record<string, ReviewedCopy>;

// Do not strip punctuation or match prefixes: a different colour/size is a
// different product. Unknown SKUs must never inherit another item's claims.
export function reviewedCopyFor(catalogNumber: string | null | undefined) {
  const sku = catalogNumber?.trim().toUpperCase();
  return sku && Object.hasOwn(reviewedCopies, sku) ? reviewedCopies[sku] : null;
}

// Repair only the exact legacy fields audited for this SKU. Later human edits
// remain authoritative and are not hidden behind a permanent text override.
export function applyReviewedCopy<T extends {
  title: string;
  description?: string | null;
  catalogNumber?: string | null;
}>(item: T): T {
  const copy = reviewedCopyFor(item.catalogNumber);
  if (!copy) return item;
  return {
    ...item,
    title: item.title === copy.expectedLegacyTitle ? copy.title : item.title,
    description: (item.description ?? null) === copy.expectedLegacyDescription
      ? copy.description : item.description,
  };
}
