# GO / NO-GO — מועמד SEO, שלב 1 ללא Sitemap (29.9.2026, לילה, גרסה 2)

**החלטה שעודכנה:** ההמלצה העדכנית בסוף המאסטר ("המלצה עדכנית — כתובת הגלריה, canonical ומפת אתר") גוברת על ההחלטה הקודמת במועמד. לפיה Sitemap נוצר ומוגש רק בשלב פתיחת האינדוקס, אחרי סגירת שערי הקבלה. לכן `src/app/sitemap.ts` וקבוע `SITEMAP_PATHS` **הוסרו** מהמועמד. `/sitemap.xml` מחזיר 404 ב-Production ובמועמד. הגרסה הקודמת של הדוח (עם sitemap) בוטלה.

מצב בסיס: Production = `master` = `fac1678` (Current). `noindex, follow` פעיל ב-4 מארחי הגלריה, ב-meta וב-header.
ענף: `claude/gallery-seo-candidate-20260929`. ה-diff מול `master` מפורט בסעיף 3. ה-HEAD המדויק ותוצאת ה-Preview מצוינים בסעיף 3.

## 1. הפרדת שלבים
**שלב 1 (ניתן לפרסום תוך שמירת `noindex`):** canonical ל-`/` ול-`/carousel`, metadata (title, description, Open Graph, twitter), JSON-LD מסוג `CollectionPage`. אין sitemap, אין שינוי ב-`robots.txt`, אין שינוי בהוראות noindex.
**שלב 2 (פתיחת אינדוקס, שלב נפרד ואישור נפרד):** יצירת `/sitemap.xml` בדומיין הקנוני עם URL מאושרים בלבד, הסרת `noindex` (meta ו-header) בדומיין הקנוני בלבד, הגשה ל-Search Console ובקשת אינדוקס. פירוט תנאי הקבלה בסעיף 8.

## 2. מפת מארחים (נבדק חי, same-origin fetch, Production)
| מארח | סוג | `/` | `/carousel` | canonical | meta robots | X-Robots-Tag | `/sitemap.xml` | המלצה לפעולה (לא בוצעה) |
|---|---|---|---|---|---|---|---|---|
| landing.toptik.co.il | גלריה ציבורית, קנוני | 200 | 200 | אין | noindex, follow | noindex, follow | 404 | המארח הקנוני. שלב 1 מוסיף canonical |
| site.toptik.co.il | alias של הגלריה | 200 | 200 | אין | noindex, follow | noindex, follow | 404 | 301 ל-landing (המלצה), אחרי אישור; עד אז canonical ל-landing |
| toptik-iota.vercel.app | alias של Vercel | 200 | 200 | אין | noindex, follow | noindex, follow | 404 | להשאיר `noindex` תמיד או להפנות ל-landing; אין להגיש |
| admin.toptik.co.il | ממשק ניהול | `/` מפנה ל-`/login` (200) | 200 (מוגש שם גם כן) | אין | `/login`: noindex, nofollow; `/carousel`: noindex, follow | noindex, follow | 404 | לא מארח ציבורי. `noindex` קבוע. לשקול שלא להגיש שם `/carousel` (החלטה עתידית) |
| www.toptik.co.il | החנות (Shopify) | 200 | 404 | עצמי | אין | אין | 200 (של Shopify) | ללא שינוי. מחוץ לתחום |

- ב-landing וב-site: `/login` ו-`/dashboard` מחזירים redirect (`proxy.ts`: נתיבי פאנל שמתבקשים במארח ציבורי מופנים ל-`admin.toptik.co.il`). זה תואם לקוד; יעד ההפניה עצמו לא נבדק חי (חסום ב-CORS): NOT TESTED.
- ב-Preview: אין canonical זהה לארבעת המארחים; ה-canonical ב-Preview מצביע תמיד ל-landing (מכוון).
- המלצה יחידה לאיחוד: כל כתובות הגלריה סביב `landing.toptik.co.il`. aliases: 301 או canonical. `admin.` לא מטופל כמארח ציבורי. לא שונו DNS או הפניות.

### `landing.toptik.co.il/admin` (200 עם "דף הבית") — נחקר
- זה לא דף הבית. זה עורך הגלריה (`src/app/admin/page.tsx`, "use client"), נתיב קיים ומכוון (`GALLERY_EDITOR_URL` = `https://landing.toptik.co.il/admin`). ה-`<title>` הוא כותרת ה-layout הראשי ("TopTik Collection…"), ולכן נראה כמו דף הבית.
- מה מוצג ללא התחברות (נבדק חי ב-Production ובצילום מסך): טופס עם שדה סיסמה ("סיסמת אדמין") וכפתור "כניסה"; הודעה "הזן טוקן אדמין כדי להתחבר". לא נחשפים נתוני ניהול; לא נעשו קריאות `/api/` לפני כניסה; HTML של 9.8KB.
- מה מקבלים ב-Preview: אותו טופס (HTML: "כניסה / טוען...").
- header: `X-Robots-Tag: noindex, follow`. `robots.txt` כולל `Disallow: /admin`, ולכן מנועי חיפוש לא יקראו אותו.
- ממצא לשלב 2: כשמסירים את ה-`noindex` הגלובלי, `/admin` חייב להישאר `noindex, nofollow`. כיום הוא מוגן רק מהגלובלי. בנוסף `/carousel` מקשר ציבורית ל-`/admin` (נמצא ב-HTML). זו התנהגות צפויה, אך תנאי קבלה חדש (סעיף 8). לא שונה כעת.

## 3. המועמד (שלב 1) והבדיקות
diff מול `master` `fac1678` (קבצי קוד ובדיקות): `src/app/carousel/page.tsx`, `src/app/page.tsx`, `src/lib/seo/site.ts`, `src/lib/seo/structured-data.ts`, `tests/seo-candidate.test.mjs`. `tests/indexing-hold.test.mjs` זהה ל-`master` (sitemap שוב אסור). בנוסף קבצי docs.
בדיקות מקומיות: 111/111 (בדיקה חדשה: אין `sitemap.ts` ו-`SITEMAP_PATHS`, ו-`robots.txt` ללא Sitemap).
build מקומי נכשל בגלל Google Fonts בסביבה, ו-build אמיתי ב-Vercel. Preview חי: ראו סעיף 4.

## 4. Preview חי (מועמד ללא Sitemap)
Preview של קומיט `9ce4488` (הקוד המלא של שלב 1): Vercel Ready, 44 שנ'. כתובת: `https://toptik-git-claude-gallery-seo-candidate-20260929-toptik.vercel.app`. קומיטי docs שאחריו לא משנים קוד.
תוצאות חיות (קריאה בלבד):
- `/carousel`: 200; canonical `https://landing.toptik.co.il/carousel`; `noindex, follow` ב-meta וב-header; h1 "קולקציה נבחרת"; JSON-LD `CollectionPage` תואם (שם וכתובת); `og:url` קנוני.
- `/`: 200; canonical `https://landing.toptik.co.il`; `noindex, follow` (meta + header).
- `/admin`: 200 (טופס כניסה), `noindex, follow`, ללא canonical. `/login`: `noindex, nofollow`.
- `/sitemap.xml`: **404**. `robots.txt`: ללא שורת Sitemap, `Allow: /`, `Disallow: /admin`.
- `/api/carousel`: 82 פריטים, 0 American Tourister, 82/82 תמונות נטענו.
- אבטחה: `debug-colors` 404, `debug-scrape` 404, `admin/debug-scrape` 401, `admin/carousel` 401, `warm-tech-specs` POST 401, `panel/users` 401, `product-details` עם כתובת לא מאושרת 400.
- Production (`fac1678`) נבדק שוב באותו לילה: `landing`, `site`, `vercel.app`, `admin`: `noindex, follow` (header ו-meta), ללא canonical, `/sitemap.xml` 404. `admin` `/` מפנה ל-`/login` (`noindex, nofollow`).

## 5. `/` מול `/carousel` — הכרעה
| | `/` | `/carousel` |
|---|---|---|
| תוכן | דף מותג: hero, ניווט (`#deals`, סניפים, אודות, WhatsApp), שלושה ערכי מותג, כפתור "כניסה לגלריה" | דף קולקציה: כותרת "קולקציה נבחרת", בורר מותגים, טקסט הסבר, גריד של 82 מוצרים (נטענים בצד לקוח) |
| מילים ב-HTML | כ-38, ללא h1 | כ-55 ב-HTML הראשוני ("טוען מוצרים…"); תוכן המוצרים מרונדר בצד לקוח |
| title | "TopTik Collection — Move in Style. Travel with Purpose." (אנגלית, כללי) | "קולקציה נבחרת \| גלריית TopTik" |
| canonical במועמד | `https://landing.toptik.co.il` (שקול ל-`/`) | `https://landing.toptik.co.il/carousel` |
| קישורים | ל-`/carousel` | ל-`/` ול-`/admin` |

התוכן שונה, לא זהה. המלצה: **להשאיר עמוד בית ייחודי עם canonical עצמי**. אין canonical ל-`/carousel` ואין הפניה (הם מגישים תוכן שונה, וההפניה תסתיר את דף המותג). `/` דק (38 מילים, בלי h1, title אנגלי כללי) ולכן **לא ייכלל ב-sitemap העתידי** לפני סקירת תוכן ואישור מפורש. שינוי כזה אינו חלק משלב 1.
ממצא נוסף: תוכן המוצרים ב-`/carousel` נטען בצד לקוח; ב-HTML הראשוני אין מוצרים. תלות ברינדור של Google, ולכן יש לבדוק אינדוקס בפועל רק בשלב 2 (NOT TESTED כעת).

## 6. מפת תוכן
- 57 מאמרי הבלוג ב-`docs/seo/article-map.csv` זהים ל-sitemap החי של Shopify (בדיקת hash), כולם 200; 27 ישנים (`lastmod` עד 19.9) + 30 עם `lastmod` 24.9. כולם בבעלות בלוג החנות; אין מאמרים בגלריה; אף מאמר לא מקשר לגלריה.
- 31 מאמרי תעופה/נמל/כבודה סומנו `freshness_flag=airline-policy` לרענון עתידי; פרסום/עדכון שלהם 19–24.9.2026. לא אומתו מול מקורות ולא שוכתבו.
- שלושה briefs (הצעות בלבד, לא תוכן מוכן, לא נכתבו ולא נוצרו routes). בדיקת חפיפה מול כותרות הבלוג (לא מול דפי מוצר ב-Shopify; NOT TESTED):
  1. מידות טרולי 55 ס״מ לפי מק״ט: **חפיפה בינונית-גבוהה** עם "טרולי עלייה למטוס", "טרולי למטוס: איך מודדים מידות", ו"טרולי סמסונייט 55 ס״מ". להצדקה רק כטבלת נתוני SKU מהגלריה, לא כמדריך.
  2. סדרה אחת, כל הצבעים והזוויות: **חפיפה נמוכה** ("מזוודה צבעונית או שחורה" הוא ייעוץ כללי, לא לפי סדרה). הכי מובחן.
  3. מזוודה מתרחבת לפני/אחרי: **חפיפה גבוהה** ("מזוודה מתרחבת: מתי צריך עוד נפח", "…סמסונייט 55 EASY ACCESS או מתרחב"). המלצה: לא לפתח; קישור מהמאמר לגלריה עדיף.
- אין נתוני Search Console או Analytics; לא נמדדה תנועה ואין הוכחת ביקוש לאף brief.

## 7. החלטת שחרור
**א. שלב 1 ל-Production עם `noindex`: מוכן לבקשת אישור** (אם הבדיקות החיות של ה-Preview הסופי עברו, סעיף 4).
פעולה מדויקת (לא בוצעה, ובאישור נפרד בלבד): `git fetch origin && git checkout master && git merge --ff-only <HEAD של ענף ה-SEO> && git push origin master`. Rollback: Instant Rollback ל-`B4fjiBVFakcL6p1RtixNHXmKEHCE` (`fac1678`), או `git revert` ו-push.

**ב. פתיחת אינדוקס: NO-GO.** חוסמים: Search Console לגלריה, תוכן `/`, הכרעת aliases, אבטחה, רענון מאמרים (פירוט בסעיף 8).

## 8. תנאי קבלה לפתיחת אינדוקס (שלב 2)
1. נכס Search Console שמכסה `landing.toptik.co.il` (Domain של toptik.co.il או URL-prefix). כיום רק `www` (URL-prefix). ללא גישה לנתונים, ללא הוכחת ביצועים.
2. אישור טל של רשימת URL, תפקיד ושאילתה לכל URL. מוצע `/carousel` בלבד; `/` רק אחרי סקירת תוכן.
3. `/sitemap.xml` ייווצר רק בשלב זה, בדומיין הקנוני, עם URL קנוניים מאושרים 200 בלבד. החלטה על `X-Robots-Tag` שחל גם על `/sitemap.xml`.
4. הסרת `noindex` (meta ב-`layout.tsx` ו-header ב-`next.config.ts`) בדומיין הקנוני בלבד, ו-`/admin`, `/login`, `/dashboard`, `/settings`, `/setup`, `/reset`, `/auth` ו-`/api/*` נשארים `noindex` (`/admin` חדש, ראו סעיף 2).
5. הכרעה לכל alias (`site.`, `vercel.app`, `admin.`).
6. אסטרטגיית דפי מוצר (אין URL לכל מוצר) ובדיקת אינדוקס בפועל של תוכן שנטען בצד לקוח.
7. אבטחה: `llm_usage_log` עם מדיניות Allow all; `ADMIN_PANEL_TOKEN` ו-`SUPABASE_SERVICE_ROLE_KEY` כסוג רגיל. כל אחד בהחלטה נפרדת. אבטחה אינה מוצהרת כמושלמת.
8. רענון/אימות 31 מאמרי התעופה (צוות תוכן).
9. אימות Preview ואחריו Production, ואישור נפרד לבקשת אינדוקס.

## 9. בעיות פתוחות
| בעיה | השפעה | חומרה | בעלים | דרך תיקון |
|---|---|---|---|---|
| `llm_usage_log` Allow all (public) | גישה אנונימית לטבלה שאינה בשימוש הגלריה | בינונית-גבוהה | טל | הידוק מדיניות (החלטה נפרדת) |
| מפתחות כסוג רגיל ב-Vercel | ערך גלוי לבעלי גישה לפרויקט | בינונית | טל | רוטציה + Secret (החלטה נפרדת) |
| אין Search Console לגלריה | חוסם ניהול אינדוקס | חוסם | טל | להוסיף נכס |
| כפילות מארחים ללא canonical/redirect ב-Production | תוכן זהה ב-4 מארחים | בינונית | טל | סעיף 2 |
| `/admin` ללא `noindex, nofollow` ייעודי | הגנה רק מהגלובלי | נמוכה כעת, גבוהה בשלב 2 | פיתוח | להוסיף לפני הסרת noindex |
| `/` דק ועם title אנגלי | חלש לאינדוקס | נמוכה | טל/תוכן | סקירה |
| מוצרים מרונדרים בצד לקוח | ייתכן שלא ייראו לזחלן | בינונית | פיתוח | בדיקה בשלב 2 |
| מדיניות תעופה בבלוג לא אומתה | תוכן לא מדויק | בינונית | תוכן | אימות מול מקורות |

## 10. Search Console / Analytics
Search Console: נכס `www` בלבד ידוע. GA4: אין analytics בגלריה. לא נמדדו ביצועים. NOT TESTED.

## 11. NOT TESTED
iPhone וגלישה נקייה; כניסת admin חי; שמירת עורך; rollback בפועל; 403 למשתמש בלי תפקיד מול Supabase אמיתי; חלון מפרט מלא ל-BXL38124101, BXL58145.*, Samsonite; יעד ההפניה של `/login` ב-landing/site; canonical לכל מאמר Shopify; חפיפה מול דפי מוצר ב-Shopify; Rich Results Test; GSC/GA4; אינדוקס תוכן שנטען בצד לקוח; השפעה על דירוגים; אימות עובדות תעופה.
