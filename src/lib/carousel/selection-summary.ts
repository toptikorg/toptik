import { CATEGORIES, type CategoryKey } from "./categories";

// One short, dynamic status line shown above the products, e.g.
// "Mandarina Duck \u203a \u05db\u05dc \u05d4\u05de\u05d5\u05e6\u05e8\u05d9\u05dd \u00b7 1\u20132 \u05de\u05ea\u05d5\u05da 12".
// No explanations or instructions; the numbers come from the filtered list itself.
export function statusLine(input: {
  brandLabel: string;
  category: CategoryKey;
  first: number;
  last: number;
  total: number;
}): string {
  const { brandLabel, category, first, last, total } = input;
  const categoryLabel = CATEGORIES.find(item => item.key === category)?.label ?? "\u05db\u05dc \u05d4\u05de\u05d5\u05e6\u05e8\u05d9\u05dd";
  const range = total === 0 ? "0 \u05de\u05d5\u05e6\u05e8\u05d9\u05dd" : first === last ? `${first} \u05de\u05ea\u05d5\u05da ${total}` : `${first}\u2013${last} \u05de\u05ea\u05d5\u05da ${total}`;
  return `${brandLabel} \u203a ${categoryLabel} \u00b7 ${range}`;
}
