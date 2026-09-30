import copyData from "./reviewed-copy.json";
import type { CachedTechSpecs } from "./types";

type ReviewedCopy = {
  title: string;
  description: string;
  expectedLegacyTitle: string;
  expectedLegacyDescription: string | null;
  sourceUrls: string[];
  specs: Array<{ label: string; value: string }>;
  expectedLegacyTechSpecs: CachedTechSpecs | null;
};

const reviewedCopies = copyData as Record<string, ReviewedCopy>;

// Do not strip punctuation or match prefixes: a different colour/size is a
// different product. Unknown SKUs must never inherit another item's claims.
export function reviewedCopyFor(catalogNumber: string | null | undefined) {
  const sku = catalogNumber?.trim().toUpperCase();
  return sku && Object.hasOwn(reviewedCopies, sku) ? reviewedCopies[sku] : null;
}

// JSONB may return object keys in a different order. Values, array order and
// the complete legacy object must still match before replacing any specs.
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length &&
    keys.every((key) => Object.hasOwn(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]));
}

// Repair only the exact legacy fields audited for this SKU. Later human edits
// remain authoritative and are not hidden behind a permanent text override.
export function applyReviewedCopy<T extends {
  title: string;
  description?: string | null;
  descriptionHtml?: string | null;
  catalogNumber?: string | null;
  techSpecs?: CachedTechSpecs | null;
}>(item: T): T {
  const copy = reviewedCopyFor(item.catalogNumber);
  if (!copy) return item;
  const replaceSpecs = sameJsonValue(item.techSpecs ?? null, copy.expectedLegacyTechSpecs);
  return {
    ...item,
    title: item.title === copy.expectedLegacyTitle ? copy.title : item.title,
    description: item.descriptionHtml == null && (item.description ?? null) === copy.expectedLegacyDescription
      ? copy.description : item.description,
    ...(replaceSpecs ? {
      techSpecs: {
        ...item.techSpecs,
        specs: [{ heading: "פרטי מוצר", items: copy.specs.map((spec) => ({ ...spec })) }],
        colors: item.techSpecs?.colors ?? [],
      },
    } : {}),
  };
}
