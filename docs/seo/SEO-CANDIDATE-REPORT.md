> **הוחלף:** דוח זה מתאר את הגרסה הראשונה של המועמד (עם `sitemap.ts`). לפי ההמלצה העדכנית במאסטר, ה-Sitemap הוסר משלב 1. המקור המחייב: `docs/seo/SEO-GO-NO-GO.md` (גרסה 2).

# דוח מועמד SEO טכני — Preview בלבד

תאריך: 29.9.2026. ענף: `claude/gallery-seo-candidate-20260929`. בסיס: `master` = `fac1678` (Production, לא שונה).
קומיט הקוד: `9c0818d`. Preview: `https://toptik-ncyggteep-toptik.vercel.app` (Ready, 51 שנ').
`noindex, follow` נשאר בכל הסביבות. לא הוגש sitemap, לא התבקש אינדוקס, לא שונו Supabase / Shopify / Vercel / DNS / Search Console / env.

## 1. מפת דומיינים

| דומיין | מה מוגש | הערה |
|---|---|---|
| `landing.toptik.co.il` | אותה אפליקציה | מומלץ כקנוני |
| `site.toptik.co.il` | אותה אפליקציה | ללא redirect |
| `admin.toptik.co.il` | אותה אפליקציה; `/` מפנה ל-`/login`, `/carousel` ציבורי | חשיפת תוכן ציבורי תחת שם admin |
| `toptik-iota.vercel.app` | אותה אפליקציה | דומיין vercel |
| `www.toptik.co.il` | Shopify (חנות + בלוג) | נפרד, קריאה בלבד |

המלצה: קנוני = `landing.toptik.co.il`. ארבעת האחרים ינותבו/יקבלו canonical אליו בהחלטה עתידית של טל. לא בוצע שינוי DNS או דומיין.

## 2. מה נבנה (diff: 7 קבצים, +208/−3)

- `src/lib/seo/site.ts`: קבועים (origin, נתיבי sitemap, כותרת ותיאור).
- `src/lib/seo/structured-data.ts`: `CollectionPage` יחיד, משקף את הכותרת הנראית. ללא Product / Offer / מחיר / זמינות / דירוג / ItemList (מחיר וזמינות שייכים ל-Shopify).
- `src/app/sitemap.ts`: `/carousel` בלבד, ללא lastmod. לא מפורסם ב-`robots.ts`.
- `src/app/carousel/page.tsx`: metadata (title, description, canonical, OG, twitter) ו-JSON-LD.
- `src/app/page.tsx`: canonical ל-`/`.
- `tests/indexing-hold.test.mjs`: הותר `src/app/sitemap.ts` בלבד.
- `tests/seo-candidate.test.mjs`: 8 בדיקות חדשות.

## 3. תוצאות בדיקות

מקומי: 111/111 עוברים (בסיס `fac1678`: 103/103).

Preview חי (קריאה בלבד):
- `/carousel`: 200; canonical `https://landing.toptik.co.il/carousel`; meta robots `noindex, follow`; כותרת `X-Robots-Tag: noindex, follow`.
- `/`: 200; canonical `https://landing.toptik.co.il` (ללא slash סופי, שקול); `noindex, follow`.
- metadata: title, description, `og:*` (website, he_IL, TopTik), `twitter:card=summary` קיימים.
- JSON-LD: נפרס תקין; `CollectionPage`; `name` = "קולקציה נבחרת" (תואם ל-h1 הנראה); ללא סוגים אסורים.
- `/sitemap.xml`: 200, `application/xml`, כתובת אחת: `https://landing.toptik.co.il/carousel`. נושא `X-Robots-Tag: noindex, follow` (ראו חסמים).
- `/robots.txt`: allow + רשימת disallow (admin, dashboard, settings, setup, login, reset, auth, api/admin, api/panel); אין שורת Sitemap.
- `/api/carousel`: 82 פריטים, 0 American Tourister.
- תמונות: 82/82 תמונות כיסוי נטענו ופוענחו.
- אבטחה: `/api/debug` 404, `/api/admin/products` 404, `/api/panel/me` 404 (נתיבים אלה אינם קיימים; בדיקות 401/400 המלאות נבדקו ב-Production ב-fac1678 ולא שונו בענף), `/login` = `noindex, nofollow`.
- build ב-Vercel: Ready.
- master: `fac1678`, לא שונה.

## 4. מפת תוכן ו-URL

- גלריה: דף תוכן ציבורי אחד (`/carousel`); `/` דף מותג דק. אין URL לכל מוצר (בדיקה קיימת אוסרת נתיבים חדשים). פרטי מוצר בחלון מודאלי בלבד.
- בלוג Shopify: 57 מאמרים = 27 ישנים + 30 מ-24.9.2026. אף אחד לא מקשר לגלריה.
- מיפוי מלא: `docs/seo/article-map.csv` (אשכול, כוונת חיפוש, חפיפה, תפקיד מוצע).
- אשכולות מובילים: cabin-baggage 8, business-class 8, low-cost 8, business-travel 7, sizing 6, choosing 4, samsonite 4.
- הצעה: לתת לכל מאמר בתוך אשכול תפקיד ייחודי (מדריך מידות / מדיניות חברה / בחירה) ולקשר מאמרים רלוונטיים ל-`/carousel`. לא בוצע.

## 5. Search Console ו-GA4

- Search Console: הגלריה אינה property מאומת. הנכס היחיד הידוע הוא `www.toptik.co.il`. דרישת קדם לאינדוקס. לא נוצר ולא נבדק.
- GA4: לא נבדק, אין גישה. מדידה אופציונלית, לא חוסמת.

## 6. חסמים לפני אינדוקס

1. Search Console property לגלריה (על הדומיין הקנוני).
2. הסרת `noindex`: גם meta וגם כותרת `X-Robots-Tag` ב-`next.config.ts`, רק על הדומיין הקנוני. יש להחליט מה קורה בשלושת האחרים (canonical/redirect). הכותרת חלה גם על `/sitemap.xml`; יש להחליט על כך בעת ה-GO.
3. תוכן `/` דורש סקירה לפני שייכנס ל-sitemap.
4. אסטרטגיית דפי מוצר (אין URL לכל מוצר).
5. סיכוני אבטחה נפרדים (לא בוצעו, החלטת טל): מדיניות פתוחה ב-`llm_usage_log`; `ADMIN_PANEL_TOKEN` ו-`SUPABASE_SERVICE_ROLE_KEY` כסוג רגיל ב-Vercel. הצעה: הידוק מדיניות, רוטציה והגדרה כ-Secret, כל אחד בנפרד.
6. רענון מאמרי מדיניות חברות תעופה (צוות תוכן).

אבטחה אינה מוצהרת כמושלמת.

## 7. NOT TESTED

iPhone וגלישה נקייה; כניסת admin חי; שמירת עורך; rollback בפועל; 403 למשתמש מחובר בלי תפקיד מול Supabase אמיתי; חלון מפרט מלא ל-BXL38124101, BXL58145.* ו-Samsonite; סיבת הריבועים האפורים בדפדפן הפנימי; נתוני GSC ו-GA4; Rich Results Test של Google; השפעה על דירוגים; 401/400 של נתיבי admin/product-details על ה-Preview הזה (נבדקו רק ב-Production ב-`fac1678`).
