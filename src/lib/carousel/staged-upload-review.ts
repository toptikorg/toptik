import type { CarouselItem, CarouselPayload } from "./types";

// Browser-safe helpers for the editor step that confirms a freshly uploaded image of an ordinary product.
// The server (staged-media-upload.ts) copies the upload to a content-addressed path and stores the signed
// receipt; these helpers only decide which uploads still need that confirmation, ask the server for it and swap
// the URL afterwards. They never decide that an image is acceptable: only the server's signed receipt does.

/** The URL shape the editor's upload returns: .../carousel-media/items/<card>/(cover|angles)/<uuid>.<ext>.
 * Deliberately not tied to one host: a look-alike is shown for confirmation and the server refuses it. */
const STAGED_UPLOAD_URL = /^https:\/\/[^/?#\s]+\/storage\/v1\/object\/public\/carousel-media\/items\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(?:cover|angles)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[A-Za-z0-9]{1,8}$/i;

export type PendingUploadReview = { url: string; roles: Array<"cover" | "angle"> };

/** Uploads of this session that the merchant has not confirmed yet. An image that is part of the saved card
 * (including every earlier upload) is never pending, and neither is an image that is not an editor upload of
 * this very card (a copy confirmed by the server lives under another path and is therefore not pending). */
export function pendingUploadReviews(saved: CarouselItem | undefined, current: CarouselItem): PendingUploadReview[] {
  const known = new Set<string>([saved?.coverImagePath, ...(saved?.angles ?? []).map(angle => angle.imagePath)].filter((url): url is string => Boolean(url)));
  const pending = new Map<string, PendingUploadReview>();
  const note = (url: string, role: "cover" | "angle") => {
    const match = typeof url === "string" ? STAGED_UPLOAD_URL.exec(url) : null;
    if (!match || match[1].toLowerCase() !== current.id.toLowerCase() || known.has(url)) return;
    const entry = pending.get(url) ?? { url, roles: [] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    pending.set(url, entry);
  };
  note(current.coverImagePath, "cover");
  for (const angle of current.angles) note(angle.imagePath, "angle");
  return [...pending.values()];
}

export const PENDING_REVIEW_SAVE_MESSAGE =
  "יש תמונות חדשות שממתינות לאישור התאמה לדגם ולצבע. אשרו אותן בכרטיס המוצר לפני השמירה. לא נשמר דבר.";

/** Refuse a catalog save while any ordinary product still carries an upload nobody confirmed. The server refuses
 * the same save (MEDIA_REVIEW_REQUIRED); this says why, before anything is sent. `skip` leaves out the shared
 * multi-color products, whose images have their own editor and are never saved through the catalog. */
export function assertNoPendingUploadReviews(snapshot: CarouselPayload, next: CarouselPayload, skip: (itemId: string) => boolean = () => false): void {
  for (const item of next.items) {
    if (skip(item.id)) continue;
    if (pendingUploadReviews(snapshot.items.find(row => row.id === item.id), item).length) throw new Error(PENDING_REVIEW_SAVE_MESSAGE);
  }
}

/** Swap one reviewed upload for its staged copy everywhere it is used on this card (cover and angles share one
 * file when the first upload became the cover). Nothing else on the card changes: not the version, not the
 * order, not the alt text, not the SKU. */
export function applyStagedUpload(item: CarouselItem, uploadUrl: string, stagedUrl: string): CarouselItem {
  return {
    ...item,
    coverImagePath: item.coverImagePath === uploadUrl ? stagedUrl : item.coverImagePath,
    angles: item.angles.map(angle => angle.imagePath === uploadUrl ? { ...angle, imagePath: stagedUrl } : angle),
  };
}

/** The editor state update for a finished confirmation. It resolves the card by its immutable id (a list that was
 * reordered meanwhile is harmless) and changes nothing when the catalog was reloaded or the card is gone. */
export function applyStagedUploadToCatalog(current: CarouselPayload, itemId: string, uploadUrl: string, stagedUrl: string, generation: number, currentGeneration: number): CarouselPayload {
  if (generation !== currentGeneration || !current.items.some(row => row.id === itemId)) return current;
  return { ...current, items: current.items.map(row => row.id === itemId ? applyStagedUpload(row, uploadUrl, stagedUrl) : row) };
}

const STAGED_REVIEW_MESSAGES: Record<string, string> = {
  STAGED_MEDIA_NOT_ELIGIBLE: "המוצר הזה עדיין לא מאושר לסנכרון תמונות עם החנות. התמונה לא נשלחה.",
  STAGED_MEDIA_IDENTITY_CHANGED: "המוצר בחנות או בגלריה השתנה מאז הטעינה, או שאינו תואם לכרטיס. טענו מחדש. לא נשלח דבר.",
  STAGED_MEDIA_STALE_ITEM: "הכרטיס עודכן במקום אחר מאז שנטען. טענו מחדש ונסו שוב. לא נשלח דבר.",
  STAGED_MEDIA_BINDING_READ_FAILED: "לא הצלחנו לקרוא את קישור המוצר לחנות. נסו שוב בעוד רגע.",
  STAGED_MEDIA_OWNED_GROUP: "מוצר עם כמה צבעים משותפים מנוהל בעורך התמונות המשותף שלו, לא כאן.",
  STAGED_MEDIA_UPLOAD_INVALID: "התמונה אינה העלאה תקינה של הכרטיס הזה. העלו אותה מחדש.",
  STAGED_MEDIA_FORMAT_INVALID: "אפשר רק JPG, PNG או WebP.",
  STAGED_MEDIA_READBACK_MISMATCH: "הקובץ שהועתק לא תאם לקובץ שהועלה. לא נשמר אישור. נסו שוב.",
  STAGED_MEDIA_STORAGE_FAILED: "שמירת העותק של התמונה נכשלה. לא נשמר אישור. נסו שוב.",
  STAGED_MEDIA_TIME_BUDGET: "הפעולה לקחה יותר מדי זמן. נסו שוב.",
  STAGED_MEDIA_INPUT_INVALID: "הבקשה לא תקינה. טענו מחדש ונסו שוב.",
  STAGED_MEDIA_RECORD_INVALID: "לא ניתן היה ליצור אישור תקין לתמונה הזו.",
  STAGED_MEDIA_FAILED: "אישור התמונה נכשל. לא נשלח דבר. נסו שוב.",
  MEDIA_REVIEW_REJECTED: "התמונה הזו (או התמונה שבפועל) סומנה בעבר כשייכת לצבע או לדגם אחר ונפסלה.",
  MEDIA_REVIEW_STORAGE_READ_FAILED: "לא הצלחנו לקרוא או לשמור את האישור. נסו שוב.",
  MEDIA_REVIEW_STORAGE_NOT_PRIVATE: "אחסון האישורים אינו פרטי, ולכן האישור נעצר.",
  MEDIA_SOURCE_BYTE_LIMIT: "התמונה גדולה מדי (עד 8MB).",
  MEDIA_SOURCE_DECODE_FAILED: "הקובץ אינו תמונה תקינה שאפשר לפענח.",
  MEDIA_SOURCE_DECODE_CHANGED: "הקובץ אינו תמונה תקינה שאפשר לפענח.",
  MEDIA_SOURCE_READ_FAILED: "לא הצלחנו לקרוא את התמונה שהועלתה. העלו אותה מחדש.",
};
export function stagedReviewErrorMessage(code: string | undefined): string {
  return (code && Object.hasOwn(STAGED_REVIEW_MESSAGES, code) && STAGED_REVIEW_MESSAGES[code]) ||
    `אישור התמונה נכשל${code && /^[A-Z0-9_]{1,100}$/.test(code) ? ` (${code})` : ""}. לא נשלח דבר.`;
}

export type StagedReviewRequest = {
  itemId: string; uploadUrl: string;
  /** The SKU printed next to the checkbox: what the administrator actually confirmed against. */
  catalogNumber: string;
  /** The card version the editor loaded (editorRevision of the saved snapshot). */
  revision: number;
  note?: string; token: string;
};

/** A staged copy the server reports must be this card's own content-addressed copy, on the same storage host as
 * the upload that was reviewed, or it is not put into the catalog payload. */
function acceptStagedUrl(value: unknown, itemId: string, uploadUrl: string): string | null {
  if (typeof value !== "string") return null;
  let upload: URL, staged: URL;
  try { upload = new URL(uploadUrl); staged = new URL(value); } catch { return null; }
  if (staged.href !== value || staged.origin !== upload.origin || staged.search || staged.hash || staged.username || staged.password) return null;
  const base = `/storage/v1/object/public/carousel-media/sync-staged/${itemId.toLowerCase()}/`;
  return staged.pathname.startsWith(base) && /^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(staged.pathname.slice(base.length)) ? value : null;
}

/** Ask the server to confirm and stage one upload. Resolves with the staged URL, or throws an Error whose
 * message is ready to show (Hebrew). Nothing is written to the catalog here. */
export async function requestStagedReview(request: StagedReviewRequest, fetchImpl: typeof fetch = fetch): Promise<{ stagedUrl: string }> {
  let response: Response;
  try {
    response = await fetchImpl("/api/admin/shopify/media/staged-review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": request.token },
      body: JSON.stringify({
        itemId: request.itemId, uploadUrl: request.uploadUrl, reviewedExactSkuColor: true,
        reviewedCatalogNumber: request.catalogNumber, expectedRevision: request.revision,
        ...(request.note?.trim() ? { note: request.note.trim() } : {}),
      }),
    });
  } catch {
    throw new Error("אישור התמונה נכשל: אין תקשורת עם השרת. לא נשלח דבר.");
  }
  const data = (await response.json().catch(() => null)) as { ok?: unknown; stagedUrl?: unknown; error?: unknown } | null;
  if (!response.ok || data?.ok !== true) throw new Error(stagedReviewErrorMessage(typeof data?.error === "string" ? data.error : undefined));
  const stagedUrl = acceptStagedUrl(data.stagedUrl, request.itemId, request.uploadUrl);
  if (!stagedUrl) throw new Error("השרת החזיר כתובת תמונה לא צפויה, ולכן היא לא הוחלה. לא נשלח דבר.");
  return { stagedUrl };
}
