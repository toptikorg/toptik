import type { CarouselItem } from "./types";

// The cover can alias an angle. Removing that angle must not leave the supposedly
// removed image behind as a cover, and moving an image to first place changes the
// cover deliberately. These helpers only edit a draft; the sync journal owns delivery.
export function removeEditorAngle(item: CarouselItem, angleId: string): CarouselItem {
  const selected = item.angles.find(angle => angle.id === angleId);
  if (!selected) return item;
  const angles = item.angles.filter(angle => angle.id !== angleId)
    .map((angle, index) => ({ ...angle, angleOrder: index + 1 }));
  if (selected.imagePath !== item.coverImagePath || angles.some(angle => angle.imagePath === item.coverImagePath)) {
    return { ...item, angles };
  }
  const first = angles[0];
  if (!first) throw new Error("אי אפשר להסיר את התמונה האחרונה של המוצר.");
  return { ...item, angles, coverImagePath: first.imagePath, coverImageAlt: first.imageAlt ?? item.title };
}

export function moveEditorAngle(item: CarouselItem, angleId: string, direction: -1 | 1): CarouselItem {
  const index = item.angles.findIndex(angle => angle.id === angleId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= item.angles.length) return item;
  const ordered = [...item.angles];
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const angles = ordered.map((angle, position) => ({ ...angle, angleOrder: position + 1 }));
  return { ...item, angles, coverImagePath: angles[0].imagePath, coverImageAlt: angles[0].imageAlt ?? item.title };
}

export function promoteEditorAngle(item: CarouselItem, angleId: string): CarouselItem {
  const selected = item.angles.find(angle => angle.id === angleId);
  if (!selected) return item;
  const angles = [selected, ...item.angles.filter(angle => angle.id !== angleId)]
    .map((angle, index) => ({ ...angle, angleOrder: index + 1 }));
  return { ...item, angles, coverImagePath: selected.imagePath, coverImageAlt: selected.imageAlt ?? item.title };
}
