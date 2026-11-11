import { normalizeCatalogKey } from "../catalog-source/vendor-detect";

export const EDITOR_PAGE_SIZE = 10;

/** Bound mounted editors, not the saved catalog. Search always covers every row. */
export function editorCatalogWindow<T extends { title: string; catalogNumber?: string | null }>(
  items: readonly T[], search: string, requestedPage: number,
) {
  const text = search.trim().toLowerCase(), key = normalizeCatalogKey(search);
  const matches = text ? items.filter(item => `${item.title} ${item.catalogNumber ?? ""}`.toLowerCase().includes(text) ||
    (key.length >= 2 && normalizeCatalogKey(item.catalogNumber ?? "").includes(key))) : items;
  const pages = Math.max(1, Math.ceil(matches.length / EDITOR_PAGE_SIZE));
  const page = Math.min(pages - 1, Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  const offset = page * EDITOR_PAGE_SIZE;
  return { items: matches.slice(offset, offset + EDITOR_PAGE_SIZE), page, pages, total: matches.length,
    first: matches.length ? offset + 1 : 0, last: Math.min(offset + EDITOR_PAGE_SIZE, matches.length) };
}
