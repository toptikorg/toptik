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
export const DISPLAY_ORDER_FULL_MESSAGE = "אין מקום פנוי בסדר התצוגה (1–9999) למוצר שנערך.";
export const MAX_DISPLAY_ORDER = 9999;

export type ChangedOnlySavePlan = {
  /** Only new or edited products, in editor order, with repaired display orders. */
  items: EditorItem[];
  settingsChanged: boolean;
  /** IDs of submitted products whose display order had to be moved to a free slot. */
  repairedOrderIds: string[];
  hasChanges: boolean;
};

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

function freeSlot(requested: number, taken: Set<number>): number {
  const start = Number.isFinite(requested) ? Math.min(Math.max(1, Math.ceil(requested)), MAX_DISPLAY_ORDER) : 1;
  for (let order = start; order <= MAX_DISPLAY_ORDER; order++) if (!taken.has(order)) return order;
  for (let order = start - 1; order >= 1; order--) if (!taken.has(order)) return order;
  throw new Error(DISPLAY_ORDER_FULL_MESSAGE);
}

/**
 * Compare the editor state with the snapshot taken when the catalog was loaded
 * (or last saved) and return the minimal changed-only save.
 *
 * Display order: a product keeps its order whenever it is a valid integer that
 * is either unchanged since the snapshot or not shared with another product.
 * Only a new/edited product whose order is invalid (<1, >9999, non-integer) or
 * collides with another product moves, to the nearest free slot at or after the
 * requested value. Unedited products never move (a pre-existing duplicate or
 * gap between unedited products is left exactly as stored), so the repair can
 * never add an untouched product to the save.
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
  const movable = next.items.map((item, index) => {
    if (!edited[index]) return false;
    const original = item.id ? before.get(item.id) : undefined;
    return !original || original.displayOrder !== item.displayOrder || !isValidDisplayOrder(item.displayOrder);
  });

  const taken = new Set<number>();
  next.items.forEach((item, index) => {
    if (!movable[index] && isValidDisplayOrder(item.displayOrder)) taken.add(item.displayOrder);
  });
  const orders = next.items.map(item => item.displayOrder);
  const repairedOrderIds: string[] = [];
  const queue = next.items.map((item, index) => ({ item, index }))
    .filter(({ index }) => movable[index])
    .sort((a, b) => {
      const left = Number.isFinite(a.item.displayOrder) ? a.item.displayOrder : -Infinity;
      const right = Number.isFinite(b.item.displayOrder) ? b.item.displayOrder : -Infinity;
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    });
  for (const { item, index } of queue) {
    const requested = item.displayOrder;
    const order = isValidDisplayOrder(requested) && !taken.has(requested) ? requested : freeSlot(requested, taken);
    taken.add(order);
    if (order !== requested) {
      orders[index] = order;
      repairedOrderIds.push(item.id);
    }
  }

  const items = next.items.flatMap((item, index) => !edited[index] ? [] :
    [orders[index] === item.displayOrder ? item : { ...item, displayOrder: orders[index] }]);
  const settingsChanged = canonicalJson(snapshot.settings) !== canonicalJson(next.settings);
  return { items, settingsChanged, repairedOrderIds, hasChanges: items.length > 0 || settingsChanged };
}
