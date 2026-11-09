import type { CarouselItem, CarouselPayload } from "./types";
import { canonicalJson } from "./editor-changes";

// Overlay only edits made after `before`, keeping server-assigned IDs and versions. In particular,
// a rich-description normalization or a sibling's shared copy must not become an accidental edit.
function keepLaterEdits(fresh: CarouselItem, before: CarouselItem, current: CarouselItem): CarouselItem {
  const next = structuredClone(fresh);
  for (const key of Object.keys(current) as (keyof CarouselItem)[]) {
    if (key === "angles" || key === "id" || key === "copyUpdatedAt" || key === "editorRevision") continue;
    if (canonicalJson(current[key]) !== canonicalJson(before[key])) {
      Object.assign(next, { [key]: structuredClone(current[key]) });
    }
  }
  const changedAngles = current.angles.filter(angle => {
    const prior = before.angles.find(row => row.id === angle.id);
    return !prior || canonicalJson(prior) !== canonicalJson(angle);
  });
  const structuralChange = current.angles.length !== before.angles.length || changedAngles.some(angle => {
    const prior = before.angles.find(row => row.id === angle.id);
    return !prior || angle.angleKey !== prior.angleKey || angle.angleOrder !== prior.angleOrder || angle.imagePath !== prior.imagePath;
  });
  if (structuralChange) next.angles = structuredClone(current.angles);
  else for (const changed of changedAngles) {
    // Reconciliation may assign another row ID to the same exact image. Keep that fresh ID so a
    // later alt-only edit remains bound to the current image, never an obsolete angle row.
    const angle = next.angles.find(row => row.angleKey === changed.angleKey && row.imagePath === changed.imagePath);
    if (!angle) {
      // Do not erase unsent text if the source image disappeared. Keeping the local structure makes
      // the unsupported-image warning block the next save until the merchant reviews it.
      next.angles = structuredClone(current.angles);
      break;
    }
    angle.imageAlt = changed.imageAlt;
  }
  return next;
}

/** Merge a delivered owned edit with the editor's latest state, without dropping late input. */
export function mergeOwnedFamilyRefresh(input: {
  snapshot: CarouselPayload; current: CarouselPayload; fresh: CarouselPayload;
  itemId: string; submitted: CarouselItem; family: ReadonlySet<string>; keepLocalEdit?: boolean;
}): { snapshot: CarouselPayload; payload: CarouselPayload } {
  const { snapshot, current, fresh, itemId, submitted, family, keepLocalEdit = false } = input;
  const baseline = new Map(snapshot.items.map(item => [item.id, item]));
  const server = new Map(fresh.items.map(item => [item.id, item]));
  const replaceBaseline = new Set<string>();
  const items = current.items.map(item => {
    const previous = baseline.get(item.id), updated = server.get(item.id);
    if (!family.has(item.id) || !previous || !updated) return item;
    if (item.id === itemId) {
      replaceBaseline.add(item.id);
      // After a partial result, preserve all still-intended edits relative to the old baseline.
      // After success, preserve only edits made after the submitted card was captured.
      return keepLaterEdits(updated, keepLocalEdit ? previous : submitted, item);
    }
    if (canonicalJson(previous) !== canonicalJson(item)) return item;
    replaceBaseline.add(item.id);
    return updated;
  });
  return {
    snapshot: { ...snapshot, items: snapshot.items.map(item => replaceBaseline.has(item.id) ? server.get(item.id)! : item) },
    payload: { ...current, items },
  };
}
