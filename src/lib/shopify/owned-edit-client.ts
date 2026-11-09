import type { CarouselItem } from "@/lib/carousel/types";

// Browser-safe helpers for the Gallery editor of the Shopify-owned color families (FZT73, QMMM1).
// They decide what part of an edited card can be delivered to Shopify and explain every refusal in
// plain Hebrew. Nothing here talks to a server.

export type OwnedCardPatch = {
  title?: string;
  description?: string;
  descriptionHtml?: string;
  seoTitle?: string;
  seoDescription?: string;
  coverImageAlt?: string;
  angles?: { id: string; imageAlt: string }[];
};
/** Reasons part of an edit cannot be delivered to Shopify from the Gallery. */
export type OwnedUnsupported = "images" | "catalog_number" | "visibility" | "empty_seo" | "empty_alt" | "plain_description";

const text = (value: string | null | undefined) => value ?? "";

/** Compare an edited card with the version loaded from the server. */
export function ownedCardChanges(saved: CarouselItem, current: CarouselItem): { patch: OwnedCardPatch; unsupported: OwnedUnsupported[] } {
  const patch: OwnedCardPatch = {};
  const unsupported = new Set<OwnedUnsupported>();
  if (current.title !== saved.title) patch.title = current.title;
  if (text(current.description) !== text(saved.description) || text(current.descriptionHtml) !== text(saved.descriptionHtml)) {
    if (typeof current.descriptionHtml === "string") {
      patch.description = text(current.description);
      patch.descriptionHtml = current.descriptionHtml;
    } else unsupported.add("plain_description");
  }
  for (const field of ["seoTitle", "seoDescription"] as const) {
    if (text(current[field]) === text(saved[field])) continue;
    if (!text(current[field]).trim()) unsupported.add("empty_seo");
    else patch[field] = text(current[field]);
  }
  if (text(current.coverImageAlt) !== text(saved.coverImageAlt)) {
    if (!text(current.coverImageAlt).trim()) unsupported.add("empty_alt");
    else patch.coverImageAlt = text(current.coverImageAlt);
  }
  if (current.coverImagePath !== saved.coverImagePath || current.angles.length !== saved.angles.length) unsupported.add("images");
  const angles: { id: string; imageAlt: string }[] = [];
  for (const angle of current.angles) {
    const before = saved.angles.find(row => row.id === angle.id);
    if (!before || before.imagePath !== angle.imagePath || before.angleOrder !== angle.angleOrder || before.angleKey !== angle.angleKey) {
      unsupported.add("images");
    } else if (text(angle.imageAlt) !== text(before.imageAlt)) {
      if (!text(angle.imageAlt).trim()) unsupported.add("empty_alt");
      else angles.push({ id: angle.id, imageAlt: text(angle.imageAlt) });
    }
  }
  if (angles.length) patch.angles = angles;
  if ((current.catalogNumber ?? null) !== (saved.catalogNumber ?? null)) unsupported.add("catalog_number");
  if (current.isActive !== saved.isActive) unsupported.add("visibility");
  return { patch, unsupported: [...unsupported] };
}

export const OWNED_UNSUPPORTED_MESSAGES: Record<OwnedUnsupported, string> = {
  images: "הוספה, הסרה, החלפה וסידור של תמונות עדיין נעשים בחנות (Shopify). אפשר לערוך כאן רק את תיאורי התמונות.",
  catalog_number: "מספר קטלוגי של צבע בחנות לא משתנה מהגלריה.",
  visibility: "הסתרה והצגה של צבע אינן נשלחות לחנות מכאן.",
  empty_seo: "אי אפשר לרוקן כותרת או תיאור SEO של צבע מהגלריה. כדי להחזיר ברירת מחדל יש לערוך בחנות.",
  empty_alt: "תיאור תמונה לא יכול להיות ריק.",
  plain_description: "את התיאור יש לערוך בעורך התיאור המעוצב.",
};

export const OWNED_SHARED_NOTE =
  "המוצר הזה בחנות הוא מוצר אחד עם כמה צבעים. שינוי בכותרת, בתיאור ובשדות ה-SEO נשלח לחנות ומשפיע על כל הצבעים. תיאור תמונה נשמר בקובץ התמונה בחנות, כולל במוצרים אחרים שמשתמשים באותו קובץ. הגלריה מתעדכנת לאחר קריאה חוזרת מהחנות.";

const MESSAGES: Record<string, string> = {
  SYNC_COPY_STALE_EDIT_RELOAD: "המוצר עודכן (בחנות או בגלריה) מאז שנטען. טענו מחדש ושמרו שוב. השינויים שלכם לא נשלחו ולא נדרסו.",
  SYNC_OWNED_COPY_CONFLICT: "אותו שדה שונה בחנות בזמן העריכה. לא נשלח דבר. טענו מחדש ובדקו מה השתנה.",
  SYNC_COPY_CONCURRENT_UPDATE: "המוצר בחנות השתנה ברגע השמירה, ולכן לא נשלח דבר. נסו שוב.",
  SYNC_RECONCILIATION_BUSY: "הסנכרון עסוק כרגע במוצר הזה. לא נשלח דבר. נסו שוב בעוד כמה שניות.",
  SYNC_OWNED_TITLE_SUFFIX_REQUIRED: "הכותרת חייבת להסתיים בשם הצבע (למשל \"... בצבע שחור\"). שם הצבע נקבע בחנות.",
  SYNC_OWNED_TITLE_INVALID: "הכותרת לא תקינה: ריקה, עם רווח בקצה, עם תו בקרה או ארוכה מ-120 תווים.",
  SYNC_OWNED_SEO_TITLE_SUFFIX_REQUIRED: "כותרת ה-SEO חייבת להסתיים בשם הצבע, כפי שהיא מופיעה כאן.",
  SYNC_OWNED_SEO_TITLE_INVALID: "כותרת ה-SEO לא תקינה: ריקה לפני שם הצבע, עם רווח בקצה או ארוכה מ-120 תווים.",
  SYNC_OWNED_SEO_DESCRIPTION_NOT_REPRESENTABLE:
    "תיאור ה-SEO חייב להתחיל במשפט שמסתיים בשם הצבע, להסתיים בנקודה ולהיכנס כולו ב-160 תווים. אם בחנות יש תיאור ארוך יותר, יש לערוך אותו בחנות.",
  SYNC_OWNED_EDIT_NOT_REPRESENTABLE: "אי אפשר לשמור את הטקסט הזה בחנות בצורה שתחזור לגלריה בדיוק כפי שנכתב. לא נשלח דבר.",
  SYNC_ONBOARDING_COPY_LIMIT: "הטקסט ארוך מדי לאחד הצבעים (כותרת SEO עד 120 תווים כולל שם הצבע הארוך ביותר). לא נשלח דבר.",
  SYNC_OWNED_ALT_TOKEN_REQUIRED: "תיאור התמונה חייב לשמור בסופו את הסיומת הטכנית (| מק״ט | מספר), כי היא קובעת לאיזה צבע התמונה שייכת.",
  SYNC_OWNED_ALT_INVALID: "תיאור התמונה לא תקין: ריק, עם רווח בקצה, עם שורה חדשה או ארוך מ-512 תווים.",
  SYNC_OWNED_ALT_CONFLICT: "לתמונה הראשית הוזנו שני תיאורים שונים. השאירו תיאור אחד.",
  SYNC_OWNED_ALT_IMAGE_UNKNOWN: "התמונה לא נמצאה בצבע הזה בחנות. טענו מחדש.",
  SYNC_DESCRIPTION_HTML_UNSAFE: "בתיאור יש קוד שאינו מותר (למשל סקריפט או קישור לא בטוח). לא נשלח דבר.",
  SYNC_DESCRIPTION_PAIR_MISMATCH: "התיאור המעוצב והטקסט שלו אינם תואמים. טענו מחדש ונסו שוב.",
  SYNC_DESCRIPTION_RICH_EDITOR_REQUIRED: "את התיאור יש לערוך בעורך התיאור המעוצב.",
  SYNC_OWNED_SOURCE_UNPUBLISHED: "המוצר בחנות אינו מפורסם כרגע, ולכן אין עריכה שלו מהגלריה.",
  SYNC_OWNED_IDENTITY_CONFLICT: "זהות הצבע בגלריה אינה תואמת את החנות, או שהצבע מוסתר. לא נשלח דבר.",
  SYNC_FZT73_BASELINE_REQUIRED: "הצבעים בגלריה לא מסונכרנים עם החנות (יש שינוי שלא נשלח וממתין לבדיקה). לא נשלח דבר.",
  SYNC_MD20_BASELINE_REQUIRED: "הצבעים בגלריה לא מסונכרנים עם החנות (יש שינוי שלא נשלח וממתין לבדיקה). לא נשלח דבר.",
  SYNC_FZT73_EDITORIAL_CHANGED: "כרטיס צבע בגלריה שונה ידנית ולא תואם את החנות. הסנכרון נעצר לבדיקה. לא נשלח דבר.",
  SYNC_MD20_EDITORIAL_CHANGED: "כרטיס צבע בגלריה שונה ידנית ולא תואם את החנות. הסנכרון נעצר לבדיקה. לא נשלח דבר.",
  SYNC_OWNED_EDIT_PARTIAL: "בקריאה חוזרת נמצאו רק חלק מהשינויים בחנות. הגלריה עודכנה לפי החנות, והעריכה שלכם נשמרה לבדיקה. בדקו לפני ניסיון נוסף.",
  SYNC_OWNED_EDIT_UNCERTAIN: "נשלחה בקשת שינוי לחנות, אך לא הצלחנו לאמת את כל התוצאה. ייתכן שחלק מהשינוי כבר נשמר. העריכה שלכם נשמרה לבדיקה. טענו מחדש ובדקו את החנות לפני ניסיון נוסף.",
  SYNC_OWNED_EDIT_DELIVERED_PROJECTION_PENDING: "השינוי אומת בחנות, אך עדכון הגלריה לא הושלם. העריכה שלכם נשמרה לבדיקה. נדרשת בדיקה חוזרת של הסנכרון לפני ניסיון נוסף.",
  SYNC_COPY_READBACK_MISMATCH: "לא הצלחנו לאמת שהחנות קיבלה את השינוי בדיוק כפי שנכתב. הגלריה עודכנה למה שמופיע בחנות. בדקו.",
  // Raised while the store and the Gallery are still being checked, before anything is written.
  SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED: "בחנות יש תמונה שלא משויכת לאחד הצבעים, או שהרכב התמונות של הצבעים השתנה. הסנכרון נעצר לבדיקה. לא נשלח דבר.",
  SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT: "מבנה הצבעים של המוצר בחנות השתנה ואינו תואם את הגלריה. לא נשלח דבר.",
  SYNC_FZT73_IDENTITY_CONFLICT: "זהות אחד הצבעים בגלריה אינה תואמת את החנות. לא נשלח דבר.",
  SYNC_MD20_IDENTITY_CONFLICT: "זהות אחד הצבעים בגלריה אינה תואמת את החנות. לא נשלח דבר.",
  SYNC_FZT73_REMOVED_OR_HIDDEN: "אחד הצבעים הוסתר או הוסר בגלריה, ולכן הסנכרון נעצר. לא נשלח דבר.",
  SYNC_MD20_REMOVED_OR_HIDDEN: "אחד הצבעים הוסתר או הוסר בגלריה, ולכן הסנכרון נעצר. לא נשלח דבר.",
  SYNC_FZT73_LEASE_REQUIRED: "נעילת המוצר פגה באמצע הפעולה. לא נשלח דבר. נסו שוב.",
  SYNC_MD20_LEASE_REQUIRED: "נעילת המוצר פגה באמצע הפעולה. לא נשלח דבר. נסו שוב.",
  SYNC_ONBOARDING_TIME_BUDGET: "הבדיקה מול החנות לקחה יותר מדי זמן. לא נשלח דבר. נסו שוב.",
  SYNC_VARIANT_GALLERY_READ_FAILED: "קריאת הנתונים מהגלריה נכשלה. לא נשלח דבר. נסו שוב.",
  SYNC_SHOPIFY_PRODUCT_MISSING: "המוצר לא נמצא בחנות. לא נשלח דבר.",
  SYNC_OWNED_EDIT_FAILED: "השמירה בחנות נכשלה מסיבה לא צפויה. טענו מחדש ובדקו מה מופיע בחנות לפני ניסיון נוסף.",
  SYNC_OWNED_REQUEST_INVALID: "הבקשה לא תקינה. טענו מחדש ונסו שוב.",
  SYNC_OWNED_REQUEST_TOO_LARGE: "התיאור גדול מדי לשמירה.",
  SYNC_OWNED_ITEM_UNKNOWN: "הכרטיס הזה אינו אחד מצבעי המוצר שנערכים דרך החנות.",
  SHOPIFY_MEDIA_ALT_WRITE_REJECTED: "החנות החזירה שגיאה בעדכון תיאור התמונה. בדקו בקריאה חוזרת מה נשמר לפני ניסיון נוסף.",
  SHOPIFY_PRODUCT_COPY_WRITE_REJECTED: "החנות החזירה שגיאה בעדכון הטקסט. בדקו בקריאה חוזרת מה נשמר לפני ניסיון נוסף.",
};

/** Plain-Hebrew explanation for a code returned by the owned-edit route. */
export function ownedEditErrorMessage(code: string | undefined): string {
  return (code && MESSAGES[code]) || `השמירה בחנות נכשלה${code ? ` (${code})` : ""}. טענו מחדש ובדקו מה מופיע בחנות לפני ניסיון נוסף.`;
}
