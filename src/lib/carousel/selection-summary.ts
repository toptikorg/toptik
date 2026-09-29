import { CATEGORIES, type CategoryKey } from "./categories";

export interface SelectionSummary {
  /** One readable line naming the active brand and category. */
  selection: string;
  /** One short sentence explaining what the current filters show. */
  help: string;
  /** The parts of `selection`, for the visual chips. */
  brand: string;
  categoryLabel: string;
  countText: string;
}

// Plain-language description of the active filters, so the visitor can tell why
// only part of the catalogue is on screen and how many products the filters left.
export function selectionSummary(input: {
  brandLabel: string;
  allBrands: boolean;
  category: CategoryKey;
  total: number;
}): SelectionSummary {
  const { brandLabel, allBrands, category, total } = input;
  const categoryLabel = CATEGORIES.find(item => item.key === category)?.label ?? "כל המוצרים";
  const brandPart = allBrands ? "כל המותגים" : brandLabel;
  const selection = `מותג: ${brandPart} · קטגוריה: ${categoryLabel} · ${total} מוצרים`;
  let help: string;
  if (allBrands && category === "all") {
    help = `מוצגים כל ${total} המוצרים של כל המותגים, בכל הקטגוריות.`;
  } else if (allBrands) {
    help = `מוצגים כל המותגים, אך רק בקטגוריה "${categoryLabel}". ל-"כל המוצרים" בחרו בקטגוריה "כל המוצרים".`;
  } else if (category === "all") {
    help = `"כל המוצרים" מציג את כל ${total} מוצרי ${brandLabel}, בכל הקטגוריות. למותג אחר בחרו מותג בראש הגלריה.`;
  } else {
    help = `מוצגים רק מוצרי ${brandLabel} בקטגוריה "${categoryLabel}". לכל מוצרי המותג בחרו "כל המוצרים".`;
  }
  return { selection, help, brand: brandPart, categoryLabel, countText: `${total} מוצרים` };
}
