/** Browser-safe contract. These values describe an intent, never permission to mutate a file. */
export type OwnedEditorImage = { key: string; mediaId: string | null; url: string; alt: string };
export type OwnedMediaEditorCommand = {
  requestId: string; itemId: string; expectedMapVersion: number; expectedSourceFingerprint: string;
  desiredImages: { mediaId: string | null; uploadUrl?: string; alt: string }[];
  assignments?: { mediaId: string; itemIds: string[] }[];
};
export type OwnedMediaEditorData = {
  itemId: string; mapVersion: number; sourceFingerprint: string; enabled: boolean;
  images: OwnedEditorImage[];
  variants: { itemId: string; sku: string; label: string }[];
  unassigned: { mediaId: string; url: string; alt: string }[];
  pending: { requestId: string; status: "pending" | "review"; message: string } | null;
  reason?: string;
};
export type OwnedMediaEditorResult = { status: "done" | "pending" | "review"; requestId: string; message: string; notRecorded?: true };

export function moveOwnedEditorImage(images: readonly OwnedEditorImage[], key: string, direction: -1 | 1 | "cover"): OwnedEditorImage[] {
  const index = images.findIndex(image => image.key === key);
  if (index < 0) return [...images];
  const target = direction === "cover" ? 0 : index + direction;
  if (target < 0 || target >= images.length) return [...images];
  const result = [...images];
  const [image] = result.splice(index, 1);
  result.splice(target, 0, image);
  return result;
}

export function removeOwnedEditorImage(images: readonly OwnedEditorImage[], key: string): OwnedEditorImage[] {
  if (!images.some(image => image.key === key)) return [...images];
  if (images.length <= 1) throw new Error("אי אפשר להסיר את התמונה האחרונה של הצבע.");
  return images.filter(image => image.key !== key);
}

export function ownedMediaDraftChanged(data: OwnedMediaEditorData, images: readonly OwnedEditorImage[], assignments: Record<string, string[]>): boolean {
  return JSON.stringify(images.map(image => [image.mediaId, image.url, image.alt])) !==
    JSON.stringify(data.images.map(image => [image.mediaId, image.url, image.alt])) || Object.values(assignments).some(ids => ids.length > 0);
}

export function ownedMediaEditorCommand(data: OwnedMediaEditorData, images: readonly OwnedEditorImage[], assignments: Record<string, string[]>, requestId: string): OwnedMediaEditorCommand {
  if (!data.enabled || data.pending || images.length < 1 || images.length > 20) throw new Error("יש להשלים את בדיקת הסנכרון לפני שמירה נוספת.");
  if (new Set(images.map(image => image.key)).size !== images.length || new Set(images.map(image => image.url)).size !== images.length) throw new Error("אותה תמונה נבחרה יותר מפעם אחת.");
  const knownItems = new Set(data.variants.map(variant => variant.itemId));
  const mapped = Object.entries(assignments).filter(([, ids]) => ids.length > 0).map(([mediaId, itemIds]) => {
    if (!data.unassigned.some(image => image.mediaId === mediaId) || new Set(itemIds).size !== itemIds.length || itemIds.some(id => !knownItems.has(id))) {
      throw new Error("שיוך התמונה לצבע אינו תקין. טענו מחדש.");
    }
    return { mediaId, itemIds: [...itemIds].sort() };
  });
  return { requestId, itemId: data.itemId, expectedMapVersion: data.mapVersion, expectedSourceFingerprint: data.sourceFingerprint,
    desiredImages: images.map(image => {
      if ((!image.mediaId && !image.alt.trim()) || image.alt !== image.alt.trim() || image.alt.length > 512) throw new Error("יש לכתוב תיאור נגיש לכל תמונה חדשה, עד 512 תווים.");
      return image.mediaId ? { mediaId: image.mediaId, alt: image.alt } : { mediaId: null, uploadUrl: image.url, alt: image.alt };
    }), ...(mapped.length ? { assignments: mapped } : {}) };
}
