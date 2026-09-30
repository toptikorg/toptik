import { STORE_ORIGIN } from "@/lib/seo/site";
import { ArticleProductCard } from "./ArticleProductCard";

// Editorial content rendered after the products area. Server component: the
// text and tables are part of the initial HTML, independent of the client
// catalogue fetch, and never touch the filters, counter or navigation.
//
// Every figure below is manufacturer data: the spec sheets stored with the
// gallery items (scraped from official Samsonite product pages through
// safeSourceFetch) plus live checks of models 146913, 150720, 146916
// (samsonite.fi) and 143108 (samsonite.com.au) on 30.09.2026. SKUs without stored manufacturer
// specs (the three Mandarina Duck trolleys) are deliberately listed without
// dimensions rather than guessed.

type Row = {
  sku: string;
  /** Verified Shopify product handle: checked live against the product JSON (variant SKU match), 30.09.2026. */
  storeHandle: string;
  name: string;
  dims: string;
  expanded: string;
  volume: string;
  material: string;
};

const CARRYON_55_ROWS: readonly Row[] = [
  { sku: "KL909001", storeHandle: "samsonite-intuo-55-black-kl909001", name: "Intuo 55, שחור", dims: "55×40×20", expanded: "55×40×23", volume: "39/45 ל׳", material: "פוליפרופילן" },
  { sku: "KL901001", storeHandle: "samsonite-intuo-55-blue-nights-kl901001", name: "Intuo 55, כחול לילה", dims: "55×40×20", expanded: "55×40×23", volume: "39/45 ל׳", material: "פוליפרופילן" },
  { sku: "KL924001", storeHandle: "samsonite-intuo-55-olive-green-kl924001", name: "Intuo 55, ירוק זית", dims: "55×40×20", expanded: "55×40×23", volume: "39/45 ל׳", material: "פוליפרופילן" },
  { sku: "KL966001", storeHandle: "samsonite-intuo-55-citrus-kl966001", name: "Intuo 55, צהוב הדרים", dims: "55×40×20", expanded: "55×40×23", volume: "39/45 ל׳", material: "פוליפרופילן" },
  { sku: "KL974001", storeHandle: "samsonite-intuo-55-lime-kl974001", name: "Intuo 55, ליים", dims: "55×40×20", expanded: "55×40×23", volume: "39/45 ל׳", material: "פוליפרופילן" },
  { sku: "KL909005", storeHandle: "samsonite-intuo-55-easy-access-black-kl909005", name: "Intuo 55 Easy Access, שחור", dims: "55×40×23", expanded: "55×40×26", volume: "42/48 ל׳", material: "פוליפרופילן" },
  { sku: "KL901005", storeHandle: "samsonite-intuo-55-easy-access-blue-nights-kl901005", name: "Intuo 55 Easy Access, כחול לילה", dims: "55×40×23", expanded: "55×40×26", volume: "42/48 ל׳", material: "פוליפרופילן" },
  { sku: "KL924005", storeHandle: "samsonite-intuo-55-easy-access-olive-green-kl924005", name: "Intuo 55 Easy Access, ירוק זית", dims: "55×40×23", expanded: "55×40×26", volume: "42/48 ל׳", material: "פוליפרופילן" },
  { sku: "KL966005", storeHandle: "samsonite-intuo-55-easy-access-citrus-kl966005", name: "Intuo 55 Easy Access, צהוב הדרים", dims: "55×40×23", expanded: "55×40×26", volume: "42/48 ל׳", material: "פוליפרופילן" },
  { sku: "KL974005", storeHandle: "samsonite-intuo-55-easy-access-lime-kl974005", name: "Intuo 55 Easy Access, ליים", dims: "55×40×23", expanded: "55×40×26", volume: "42/48 ל׳", material: "פוליפרופילן" },
  { sku: "KJ109001", storeHandle: "samsonite-upscape-55-black-kj109001", name: "Upscape 55, שחור", dims: "55×40×20", expanded: "55×40×23", volume: "45 ל׳ בהרחבה", material: "פוליפרופילן" },
  { sku: "KJ111001", storeHandle: "samsonite-upscape-55-nautical-blue-kj111001", name: "Upscape 55, כחול", dims: "55×40×20", expanded: "55×40×23", volume: "45 ל׳ בהרחבה", material: "פוליפרופילן" },
  { sku: "KJ114001", storeHandle: "samsonite-upscape-55-climbing-ivy-kj114001", name: "Upscape 55, ירוק", dims: "55×40×20", expanded: "55×40×23", volume: "45 ל׳ בהרחבה", material: "פוליפרופילן" },
  { sku: "KJ106001", storeHandle: "samsonite-upscape-55-yellow-kj106001", name: "Upscape 55, צהוב", dims: "55×40×20", expanded: "55×40×23", volume: "45 ל׳ בהרחבה", material: "פוליפרופילן" },
  { sku: "KJ114007", storeHandle: "samsonite-upscape-55-easy-access-climbing-ivy-kj114007", name: "Upscape 55 Easy Access, ירוק", dims: "55×40×23", expanded: "55×40×26", volume: "42/48 ל׳", material: "פוליפרופילן" },
  { sku: "KJ106007", storeHandle: "samsonite-upscape-55-easy-access-yellow-kj106007", name: "Upscape 55 Easy Access, צהוב", dims: "55×40×23", expanded: "55×40×26", volume: "42/48 ל׳", material: "פוליפרופילן" },
  { sku: "KO709005", storeHandle: "samsonite-urbify-55-black-ko709005", name: "Urbify 55, שחור", dims: "55×40×23", expanded: "55×40×26", volume: "39/46 ל׳", material: "פוליאסטר ממוחזר" },
  { sku: "KO701005", storeHandle: "samsonite-urbify-55-navy-blue-ko701005", name: "Urbify 55, כחול נייבי", dims: "55×40×23", expanded: "55×40×26", volume: "39/46 ל׳", material: "פוליאסטר ממוחזר" },
  { sku: "KO704005", storeHandle: "samsonite-urbify-55-pine-green-ko704005", name: "Urbify 55, ירוק אורן", dims: "55×40×23", expanded: "55×40×26", volume: "39/46 ל׳", material: "פוליאסטר ממוחזר" },
  { sku: "KO776005", storeHandle: "samsonite-urbify-55-lava-ko776005", name: "Urbify 55, לבה", dims: "55×40×23", expanded: "55×40×26", volume: "39/46 ל׳", material: "פוליאסטר ממוחזר" },
];

const INTUO_COLORS: ReadonlyArray<{ color: string; base: string; easyAccess: string }> = [
  { color: "שחור", base: "KL909001", easyAccess: "KL909005" },
  { color: "כחול לילה", base: "KL901001", easyAccess: "KL901005" },
  { color: "ירוק זית", base: "KL924001", easyAccess: "KL924005" },
  { color: "צהוב הדרים", base: "KL966001", easyAccess: "KL966005" },
  { color: "ליים", base: "KL974001", easyAccess: "KL974005" },
];

export function GalleryContentSections() {
  return (
    <section className="gallery-info" dir="rtl" aria-labelledby="gallery-info-sizes">
      <h2 id="gallery-info-sizes" className="gallery-info-title">מדריך מידות לפי מק״ט: טרולי 55 ס״מ בגלריה</h2>
      <p className="gallery-info-text">
        הטבלה מרכזת את מידות היצרן של דגמי ה-55 ס״מ של Samsonite המוצגים בגלריה, כפי שהן מופיעות בעמודי
        המוצר הרשמיים. ״בהרחבה״ — עומק הדגם כשרוכסן ההרחבה פתוח; נפח כפול (למשל 39/45 ל׳) — סגור/מורחב;
        בדגמי Upscape הבסיסיים היצרן מפרסם נפח בהרחבה בלבד. מידות מותרות בקבינה משתנות בין חברות
        התעופה — בדקו מול חברת התעופה לפני הטיסה.
      </p>
      <div className="gallery-info-tablewrap" role="region" aria-label="טבלת מידות לפי מק״ט" tabIndex={0}>
        <table className="gallery-info-table">
          <caption className="gallery-info-caption">מידות יצרן, ס״מ (גובה×רוחב×עומק)</caption>
          <thead>
            <tr>
              <th scope="col">מק״ט</th>
              <th scope="col">דגם וצבע</th>
              <th scope="col">מידות</th>
              <th scope="col">בהרחבה</th>
              <th scope="col">נפח</th>
              <th scope="col">חומר</th>
            </tr>
          </thead>
          <tbody>
            {CARRYON_55_ROWS.map((row) => (
              <tr key={row.sku}>
                <th scope="row" dir="ltr">{row.sku}</th>
                <td>{row.name}</td>
                <td dir="ltr">{row.dims}</td>
                <td dir="ltr">{row.expanded}</td>
                <td>{row.volume}</td>
                <td>{row.material}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="gallery-info-text gallery-info-note">
        טרולי Mandarina Duck בגלריה (Smile &amp; Go בפלדה ובכחול, Logoduck+ Glitter בטורקיז) מוצגים
        בתמונות מכמה זוויות; מידות יצרן שמורות אינן זמינות להם כרגע, ולכן אינן בטבלה.
      </p>
      <div className="gallery-info-cards"><ArticleProductCard sku="P10JNV05465" /></div>

      <h2 className="gallery-info-title">Samsonite Intuo: השוואה בין שתי הגרסאות</h2>
      <p className="gallery-info-text">
        סדרת Intuo היא סדרה קשיחה מפוליפרופילן עם רוכסן הרחבה ואחריות עולמית מוגבלת של 5 שנים,
        לפי היצרן. בגודל 55 ס״מ היא מגיעה בשתי גרסאות, וההבדל ביניהן מדיד:
      </p>
      <div className="gallery-info-tablewrap" role="region" aria-label="השוואת גרסאות Intuo 55" tabIndex={0}>
        <table className="gallery-info-table">
          <thead>
            <tr>
              <th scope="col">נתון יצרן</th>
              <th scope="col">Intuo 55 (דגם 146913)</th>
              <th scope="col">Intuo 55 Easy Access (דגם 150720)</th>
            </tr>
          </thead>
          <tbody>
            <tr><th scope="row">מידות</th><td dir="ltr">55×40×20</td><td dir="ltr">55×40×23</td></tr>
            <tr><th scope="row">בהרחבה</th><td dir="ltr">55×40×23</td><td dir="ltr">55×40×26</td></tr>
            <tr><th scope="row">נפח (סגור/מורחב)</th><td>39/45 ל׳</td><td>42/48 ל׳</td></tr>
            <tr><th scope="row">משקל</th><td>2.3 ק״ג</td><td>3 ק״ג</td></tr>
          </tbody>
        </table>
      </div>
      <p className="gallery-info-text">
        כלומר: ה-Easy Access עמוקה ב-3 ס״מ ומוסיפה כ-3 ליטר נפח. אופן הפתיחה של כל גרסה מוצג
        בתמונות הזוויות בגלריה ובעמוד היצרן. כך הן נראות זו לצד זו, בשחור:
      </p>
      <div className="gallery-info-cards">
        <ArticleProductCard sku="KL909001" />
        <ArticleProductCard sku="KL909005" />
      </div>
      <p className="gallery-info-text">שתי הגרסאות זמינות בגלריה בחמישה צבעים:</p>
      <div className="gallery-info-tablewrap" role="region" aria-label="צבעי Intuo בגלריה" tabIndex={0}>
        <table className="gallery-info-table">
          <thead>
            <tr>
              <th scope="col">צבע</th>
              <th scope="col">Intuo 55</th>
              <th scope="col">Intuo 55 Easy Access</th>
            </tr>
          </thead>
          <tbody>
            {INTUO_COLORS.map((row) => (
              <tr key={row.color}>
                <th scope="row">{row.color}</th>
                <td dir="ltr">{row.base}</td>
                <td dir="ltr">{row.easyAccess}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="gallery-info-text">
        כל דגם מצולם בגלריה מכמה זוויות — חזית, צד, ידית וגלגלים ופנים המזוודה — כך שאפשר להשוות
        צבעים וגרסאות לפני שבוחרים. מהסדרה מוצגת גם Intuo 81 ס״מ (דגם 146916): ‏81×54×33 ס״מ,
        בהרחבה 81×54×36 ס״מ. מחירים, מלאי ורכישה — ב<a className="gallery-info-link" href={`${STORE_ORIGIN}/`}>חנות TopTik</a>.
      </p>
      <div className="gallery-info-cards"><ArticleProductCard sku="KL974004" /></div>
      <p className="gallery-info-text gallery-info-note">
        מקורות הנתונים: עמודי המוצר הרשמיים של Samsonite שמהם שמור המפרט בגלריה (samsonite.fi,
        samsonite.co.uk, samsonite.com.au); אומת 30.09.2026.
      </p>
    </section>
  );
}
