# GO / NO-GO — מועמד SEO (29.9.2026, לילה)

מצב בסיס: Production = `master` = `fac1678` (Current). `noindex, follow` פעיל בכל 4 מארחי הגלריה (header + meta).
מועמד: ענף `claude/gallery-seo-candidate-20260929`. קומיט קוד `9c0818d`. קומיט docs קודם `013b086` (Preview Ready, 1m18s). קומיט docs זה נוסף אחריו.

## 1. אימות מצב
- Vercel: Preview ל-`013b086` = Ready. Production `fac1678` = Current. אין פריסה ל-Production מהענף.
- master ב-origin = `fac1678`.
- לא בוצע merge, DNS, Shopify, Supabase, הגדרות Vercel, Search Console או Analytics.

## 2. מפת מארחים (נבדק חי, same-origin fetch, Production)
| מארח | `/` | `/carousel` | canonical | meta robots | X-Robots-Tag | `/sitemap.xml` | הערה |
|---|---|---|---|---|---|---|---|
| landing.toptik.co.il | 200 | 200 | אין | noindex, follow | noindex, follow | 404 | `/login` ו-`/dashboard` מפנים (redirect); יעד ההפניה NOT TESTED (חסום ב-CORS) |
| site.toptik.co.il | 200 | 200 | אין | noindex, follow | noindex, follow | 404 | זהה ל-landing |
| admin.toptik.co.il | 200 (מפנה ל-`/login`) | 200 | אין | `/`→`/login`: noindex, nofollow; `/carousel`: noindex, follow | noindex, follow | 404 | ממשק ניהול; `/carousel` מוגש גם כאן |
| toptik-iota.vercel.app | 200 | 200 | אין | noindex, follow | noindex, follow | 404 | דומיין Vercel |
| www.toptik.co.il | 200 | 404 | עצמי | אין | אין | 200 | Shopify, נפרד; `/carousel` לא קיים שם |

Preview (ענף, `013b086`): `/carousel` canonical `https://landing.toptik.co.il/carousel`; `/` canonical `https://landing.toptik.co.il`.

המלצה יחידה: לאחד סביב `landing.toptik.co.il` (המסקנה בעדכון המאסטר: החנות נשארת ב-www, הגלריה נשארת ב-landing). ל-`site.` ול-`toptik-iota.vercel.app`: 301 ל-landing או canonical ל-landing (החלטה עתידית, לא בוצעה). `admin.` לא לטפל כאתר ציבורי: להשאיר `noindex` לצמיתות ולהחליט אם `/carousel` צריך להיות מוגש שם בכלל. לא שונו הפניות או DNS.

## 3. בדיקות Preview חי (`toptik-git-…-toptik.vercel.app`, 013b086)
- `/carousel`: 200, canonical נכון, `noindex, follow` ב-meta וב-header.
- `/`: 200, canonical, `noindex, follow`.
- `/sitemap.xml`: 200, XML תקין, כתובת אחת: `https://landing.toptik.co.il/carousel`.
- `robots.txt`: `Allow: /`, disallow לנתיבים פרטיים, אין שורת Sitemap; אינו חוסם `/carousel` ולכן ה-noindex ניתן לקריאה.
- metadata, OG, twitter, JSON-LD `CollectionPage`: תואמים לכותרת הנראית ולכתובת הקנונית (נבדק ב-Preview הקודם, הקוד לא השתנה).
- `/api/carousel`: 82 פריטים, 0 American Tourister; 82/82 תמונות נטענו ופוענחו.
- אבטחה: `debug-colors` 404, `debug-scrape` 404, `admin/debug-scrape` 401, `admin/carousel` 401, `warm-tech-specs` (POST) 401, `panel/users` 401, `product-details` עם כתובת לא מאושרת 400.

### בדיקות מקומיות (נפרד)
- `node --test tests/*.test.mjs`: 111/111.
- `next build` מקומי נכשל בגלל fetch של Google Fonts (חסימת רשת בסביבה). ה-build האמיתי הוא ב-Vercel (Ready). לא מוצג כאימות אתר.

## 4. מפת תוכן
- 57 מאמרי בלוג: הקבוצה שב-CSV זהה לחלוטין ל-sitemap החי של Shopify (בדיקת hash על רשימת ה-URL: זהה). כולם 200. 27 ישנים (`lastmod` עד 19.9) + 30 עם `lastmod` 24.9.
- בעלות: כל 57 שייכים לבלוג החנות. לגלריה אין מאמרים (דף תוכן ציבורי יחיד: `/carousel`). אף מאמר לא מקשר לגלריה.
- `docs/seo/article-map.csv` עודכן: `live_status`, `owner`, `gallery_role`, `freshness_flag`.
- עדכניות מדיניות: 31 מאמרים סומנו `airline-policy` (כבודת יד, חברות לואו-קוסט, נתב"ג, מחלקת עסקים). תאריכי פרסום/עדכון שלהם 19–24.9.2026, כלומר כ-5 ימים. לא אומתה אף טענה מול אתר חברה/נמל. לא נכתבו מחדש.
- NOT TESTED: קנוניקל לכל מאמר (הבדיקה האוטומטית נכשלה על קידוד; רק דף המדריכים ו-`/` אומתו); ספירת מילים אמינה (הבדיקה כללה תבנית).

### שלושה briefs לגלריה (לא נכתבו, ללא routes חדשים)
1. **מידות טרולי 55 ס״מ לפי מק״ט, טבלה חזותית** — קהל: מחפשי טרולי לעלייה למטוס מתוך דגמים מסוימים. ערך מקורי: נתוני `techSpecs` בפועל של פריטי הגלריה, תמונות וזוויות. חפיפה: בינונית עם "טרולי עלייה למטוס" ו"איך מודדים"; ההבדל הוא פר-דגם ולא כללי. מקורות: אתרי יצרן (Bric's, Mandarina Duck, Samsonite), לאמת מק״טים. קישורים: החנות לכל דגם. חסם: הגלריה ללא URL לכל מוצר, לכן יידרש להיות חלק מ-`/carousel` או להישאר בבלוג.
2. **סדרה אחת, כל הצבעים והזוויות (למשל Logoduck+ / X-Travel)** — קהל: מי שכבר בחר מותג/סדרה וקובע צבע. ערך: השוואה חזותית של צבעים וזוויות שאין בבלוג. חפיפה: נמוכה-בינונית עם "מזוודה צבעונית או שחורה". מקורות: אתר היצרן לשמות צבע וקודים. קישורים: עמודי הסדרה בחנות.
3. **מתרחבת: לפני/אחרי (עומק 20→23 ס״מ) בדגמים אמיתיים** — קהל: נוסעים לפני טיסה שבודקים כבודה. ערך: נתוני הרחבה מהמפרט. חפיפה: גבוהה עם "מזוודה מתרחבת: מתי צריך עוד נפח"; מומלץ להעדיף קישור מהמאמר לגלריה על פני תוכן חדש. מקור: יצרן + מדיניות חברת תעופה (לאמת).
לא נמדדו נפחי חיפוש ולא נבדק Search Console; אין כאן הבטחה לביקוש.

## 5. החלטת שחרור

### א. שחרור תיקוני SEO ל-Production כשה-`noindex` נשאר — **GO מותנה** (טל מאשר בנפרד)
מה ישתנה בפועל ב-Production: canonical ל-`/` ול-`/carousel`, metadata ו-OG/twitter, JSON-LD, ו-`/sitemap.xml` שיחזיר 200 (כיום 404) עם `noindex` ב-header. לא יוגש ל-Search Console ולא מפורסם ב-`robots.txt`.
חומרה/סיכון: נמוך. `sitemap.xml` ציבורי אך ללא הגשה; ה-header חל גם עליו.
תנאים: טל מאשר; Preview עדכני ל-HEAD הסופי Ready; לאחר הפריסה חוזרים על הבדיקות החיות במארחי Production.
פעולה מדויקת (לא בוצעה): `git fetch origin && git checkout master && git merge --ff-only <HEAD של ענף ה-SEO> && git push origin master` (fast-forward בלבד, ללא force; Vercel בונה Production מ-master).
Rollback (לא בוצע): ב-Vercel, Promote/Instant Rollback לפריסה `B4fjiBVFakcL6p1RtixNHXmKEHCE` (`fac1678`, `toptik-jpwq0s668-toptik.vercel.app`); לחלופין `git revert` של קומיטי ה-SEO ו-push.

### ב. פתיחת אינדוקס — **NO-GO כעת** (שלב נפרד, אישור נפרד)
תנאי קבלה להסרת `noindex`:
1. נכס Search Console שמכסה את `landing.toptik.co.il` (Domain של toptik.co.il או URL-prefix). כיום רק `www` (URL-prefix).
2. טל מאשר רשימת URL, תפקיד ושאילתה לכל URL. כיום מוצע `/carousel` בלבד; `/` דורש סקירת תוכן.
3. הסרה מתואמת: meta ב-`layout.tsx` וה-header ב-`next.config.ts`, רק במארח הקנוני; החלטה על `site.`, `admin.`, `vercel.app` (301/canonical/noindex), ועל ה-header של `/sitemap.xml`.
4. אימות Preview ואחר כך Production: קנוניקל, robots, sitemap, 82 פריטים ותמונות, בדיקת רינדור.
5. החלטה על דפי מוצר (אין URL לכל מוצר).
6. טיפול או קבלה מפורשת של סיכוני האבטחה הפתוחים.
7. רק אחר כך: הגשת sitemap ובקשת אינדוקס, באישור נפרד.

## 6. בעיות פתוחות
| בעיה | השפעה | חומרה | בעלים | דרך תיקון |
|---|---|---|---|---|
| `llm_usage_log` עם מדיניות Allow all (ALL, public) | כתיבה/קריאה אנונימית לטבלה שאינה בשימוש הגלריה | בינונית-גבוהה | טל | הידוק מדיניות ב-Supabase (החלטה נפרדת) |
| `ADMIN_PANEL_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` כסוג רגיל ב-Vercel | ערך גלוי לכל בעל גישה לפרויקט | בינונית | טל | רוטציה + סוג Secret (החלטה נפרדת) |
| אין Search Console לגלריה | חוסם אינדוקס מנוהל | חוסם | טל | להוסיף נכס |
| כפילות מארחים ללא canonical/redirect ב-Production | תוכן זהה ב-4 מארחים | בינונית (לפני אינדוקס) | טל | ראו סעיף 2 |
| `/admin` בגלריה מחזיר 200 עם דף הבית | לא דף ניהול; דורש הבנה | נמוכה | פיתוח | לבדוק |
| מדיניות חברות תעופה בבלוג לא אומתה | תוכן עלול להיות לא מדויק | בינונית | צוות תוכן | אימות מול מקורות |
| Supabase Free, "grace period is over" (לפי המאסטר) | יציבות | לבדוק | טל | החלטת תוכנית |

אבטחה אינה מוצהרת כמושלמת.

## 7. Search Console / Analytics
- Search Console: נכס `www.toptik.co.il` בלבד ידוע; לא נבדק שוב; אין נתוני ביצועים. NOT TESTED.
- GA4: חסום/אין analytics בגלריה. NOT TESTED. לא נמדדו ביצועים.

## 8. NOT TESTED
iPhone וגלישה נקייה; כניסת admin חי; שמירת עורך; rollback בפועל; 403 למשתמש מחובר בלי תפקיד מול Supabase; חלון מפרט מלא ל-BXL38124101, BXL58145.*, Samsonite; יעד ההפניה של `/login` ב-landing/site; canonical לכל 57 מאמרי Shopify; Rich Results Test; GSC/GA4; השפעה על דירוגים; אימות עובדות תעופה; build של קומיט docs זה.
