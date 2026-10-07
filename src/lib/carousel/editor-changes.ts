import type { CarouselPayload } from "./types";

// Changed-only save planning for the merchant gallery editor (/admin).
//
// "Save all" used to renumber every product to 1..N and send the entire
// catalog. One pre-existing gap therefore rewrote display_order on every
// untouched product, which changed each row's gallery CAS revision and made
// in-flight media sync operations on those products fail. The editor now sends
// only what differs from the catalog exactly as it was loaded, and display
// order is never renumbered globally.

type EditorItem = CarouselPayload["items"][number];

export const NO_CHANGES_MESSAGE = "אין שינויים לשמירה";
export const PRODUCT_REMOVAL_UNSUPPORTED_MESSAGE =
  "מוצר שנטען מהגלריה חסר בעריכה. אין למחוק מוצרים — יש לסמן אותם כלא פעילים ולטעון מחדש.";
export const MAX_DISPLAY_ORDER = 9999;

export type ChangedOnlySavePlan = {
  /** Only new or edited products, in editor order, exactly as entered. */
  items: EditorItem[];
  settingsChanged: boolean;
  hasChanges: boolean;
};

/**
 * A new or edited product asked for a display order that is invalid or held by
 * another product. The save is refused before any request; nothing is moved
 * and every stored position stays as it is until the merchant picks a free one.
 */
export type DisplayOrderConflict = { id: string; label: string; requested: unknown; heldBy: string | null; suggestion: number | null };

export class DisplayOrderConflictError extends Error {
  readonly conflicts: DisplayOrderConflict[];

  constructor(conflicts: DisplayOrderConflict[]) {
    super(conflicts.map(conflict => conflict.heldBy === null
      ? `מיקום ${String(conflict.requested)} של ${conflict.label} אינו תקין (מספר שלם 1–${MAX_DISPLAY_ORDER}).`
      : `מיקום ${String(conflict.requested)} של ${conflict.label} תפוס על ידי ${conflict.heldBy}.`).join(" ") +
      ` לא נשמר דבר והמיקום השמור לא שונה. בחר מיקום פנוי${suggestionText(conflicts)} ושמור שוב.`);
    this.name = "DisplayOrderConflictError";
    this.conflicts = conflicts;
  }
}

function suggestionText(conflicts: DisplayOrderConflict[]) {
  const free = [...new Set(conflicts.flatMap(conflict => conflict.suggestion === null ? [] : [conflict.suggestion]))];
  return free.length ? ` (למשל ${free.join(", ")})` : "";
}

/** JSON with object keys sorted, so a re-ordered but equal object is not an edit. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(Object.keys(current).sort().map(key => [key, (current as Record<string, unknown>)[key]]))
      : current) ?? "undefined";
}

export function isValidDisplayOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_DISPLAY_ORDER;
}

function itemLabel(item: EditorItem): string {
  return (item.catalogNumber || item.title || item.id || "מוצר חדש").toString().trim();
}

function nearestFree(requested: unknown, taken: Set<number>): number | null {
  const base = typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.round(requested)), MAX_DISPLAY_ORDER) : 1;
  for (let distance = 0; distance < MAX_DISPLAY_ORDER; distance++) {
    for (const order of [base + distance, base - distance]) {
      if (order >= 1 && order <= MAX_DISPLAY_ORDER && !taken.has(order)) return order;
    }
  }
  return null;
}

/**
 * Compare the editor state with the snapshot taken when the catalog was loaded
 * (or last saved) and return the minimal changed-only save.
 *
 * Display order is never renumbered and never chosen for the merchant. A new
 * product, or an edited product whose order changed, must ask for a valid order
 * that no other product holds; otherwise DisplayOrderConflictError is thrown
 * and nothing is sent. Unedited products, and edited products whose order is
 * unchanged, keep their stored order (a pre-existing duplicate or gap is left
 * exactly as stored, so no untouched product is ever added to the save).
 */
export function planChangedOnlySave(snapshot: CarouselPayload, next: CarouselPayload): ChangedOnlySavePlan {
  const before = new Map(snapshot.items.map(item => [item.id, item]));
  const nextIds = new Set(next.items.map(item => item.id));
  // The editor hides products (isActive=false); it never drops them. A missing
  // loaded row means the editor state is inconsistent — refuse rather than
  // silently treat it as unchanged or as a deletion.
  if (snapshot.items.some(item => !nextIds.has(item.id))) throw new Error(PRODUCT_REMOVAL_UNSUPPORTED_MESSAGE);

  const edited = next.items.map(item => {
    const original = item.id ? before.get(item.id) : undefined;
    return !original || canonicalJson(original) !== canonicalJson(item);
  });
  const requestsOrder = next.items.map((item, index) => {
    if (!edited[index]) return false;
    const original = item.id ? before.get(item.id) : undefined;
    return !original || original.displayOrder !== item.displayOrder || !isValidDisplayOrder(item.displayOrder);
  });

  const holders = new Map<number, EditorItem[]>();
  next.items.forEach(item => {
    if (isValidDisplayOrder(item.displayOrder)) holders.set(item.displayOrder, [...(holders.get(item.displayOrder) ?? []), item]);
  });
  const taken = new Set(holders.keys());
  const conflicts = next.items.flatMap((item, index): DisplayOrderConflict[] => {
    if (!requestsOrder[index]) return [];
    const requested = item.displayOrder;
    if (!isValidDisplayOrder(requested)) {
      return [{ id: item.id, label: itemLabel(item), requested, heldBy: null, suggestion: nearestFree(requested, taken) }];
    }
    const others = (holders.get(requested) ?? []).filter(other => other !== item);
    return others.length ? [{ id: item.id, label: itemLabel(item), requested, heldBy: others.map(itemLabel).join(", "), suggestion: nearestFree(requested, taken) }] : [];
  });
  if (conflicts.length) throw new DisplayOrderConflictError(conflicts);

  const items = next.items.filter((_item, index) => edited[index]);
  const settingsChanged = canonicalJson(snapshot.settings) !== canonicalJson(next.settings);
  return { items, settingsChanged, hasChanges: items.length > 0 || settingsChanged };
}
