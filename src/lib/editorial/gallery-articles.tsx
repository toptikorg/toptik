import type { ReactNode } from "react";
import { premiumArticles } from "./premium-articles";
import { lifestyleArticles } from "./lifestyle-articles";
import { practicalArticles } from "./practical-articles";
import { collectionArticles } from "./collection-articles";
import { ArticleProductCards } from "@/components/editorial/ArticleProductCards";

export type GalleryArticle = {
  slug: string;
  category: string;
  title: string;
  description: string;
  standfirst: string;
  publishedAt: string;
  updatedAt: string;
  readingMinutes: number;
  byline: string;
  sourceUrls: readonly string[];
  releaseBlocker?: string;
  hero?: { src: string; alt: string; width: number; height: number; caption: string; href?: string };
  content: ReactNode;
};

const CARRYON_55_ROWS = [
  ["KL909001", "Intuo 55 · שחור", "55×40×20", "55×40×23", "39/45 ל׳", "פוליפרופילן"],
  ["KL901001", "Intuo 55 · כחול לילה", "55×40×20", "55×40×23", "39/45 ל׳", "פוליפרופילן"],
  ["KL924001", "Intuo 55 · ירוק זית", "55×40×20", "55×40×23", "39/45 ל׳", "פוליפרופילן"],
  ["KL966001", "Intuo 55 · צהוב הדרים", "55×40×20", "55×40×23", "39/45 ל׳", "פוליפרופילן"],
  ["KL974001", "Intuo 55 · ליים", "55×40×20", "55×40×23", "39/45 ל׳", "פוליפרופילן"],
  ["KL909005", "Intuo 55 Easy Access · שחור", "55×40×23", "55×40×26", "42/48 ל׳", "פוליפרופילן"],
  ["KL901005", "Intuo 55 Easy Access · כחול לילה", "55×40×23", "55×40×26", "42/48 ל׳", "פוליפרופילן"],
  ["KL924005", "Intuo 55 Easy Access · ירוק זית", "55×40×23", "55×40×26", "42/48 ל׳", "פוליפרופילן"],
  ["KL966005", "Intuo 55 Easy Access · צהוב הדרים", "55×40×23", "55×40×26", "42/48 ל׳", "פוליפרופילן"],
  ["KL974005", "Intuo 55 Easy Access · ליים", "55×40×23", "55×40×26", "42/48 ל׳", "פוליפרופילן"],
  ["KJ109001", "Upscape 55 · שחור", "55×40×20", "55×40×23", "45 ל׳ בהרחבה", "פוליפרופילן"],
  ["KJ111001", "Upscape 55 · כחול", "55×40×20", "55×40×23", "45 ל׳ בהרחבה", "פוליפרופילן"],
  ["KJ114001", "Upscape 55 · ירוק", "55×40×20", "55×40×23", "45 ל׳ בהרחבה", "פוליפרופילן"],
  ["KJ106001", "Upscape 55 · צהוב", "55×40×20", "55×40×23", "45 ל׳ בהרחבה", "פוליפרופילן"],
  ["KJ114007", "Upscape 55 Easy Access · ירוק", "55×40×23", "55×40×26", "42/48 ל׳", "פוליפרופילן"],
  ["KJ106007", "Upscape 55 Easy Access · צהוב", "55×40×23", "55×40×26", "42/48 ל׳", "פוליפרופילן"],
  ["KO709005", "Urbify 55 · שחור", "55×40×23", "55×40×26", "39/46 ל׳", "פוליאסטר ממוחזר"],
  ["KO701005", "Urbify 55 · כחול נייבי", "55×40×23", "55×40×26", "39/46 ל׳", "פוליאסטר ממוחזר"],
  ["KO704005", "Urbify 55 · ירוק אורן", "55×40×23", "55×40×26", "39/46 ל׳", "פוליאסטר ממוחזר"],
  ["KO776005", "Urbify 55 · לבה", "55×40×23", "55×40×26", "39/46 ל׳", "פוליאסטר ממוחזר"],
] as const;

function SizesTable() {
  return (
    <div className="journal-table-scroll" role="region" aria-label="מידות יצרן לפי מק״ט" tabIndex={0}>
      <table className="journal-table">
        <caption>מידות היצרן בסנטימטרים (גובה × רוחב × עומק)</caption>
        <thead><tr><th scope="col">מק״ט</th><th scope="col">דגם וצבע</th><th scope="col">מידות</th><th scope="col">בהרחבה</th><th scope="col">נפח</th><th scope="col">חומר</th></tr></thead>
        <tbody>{CARRYON_55_ROWS.map((row) => <tr key={row[0]}><th scope="row" dir="ltr">{row[0]}</th><td>{row[1]}</td><td dir="ltr">{row[2]}</td><td dir="ltr">{row[3]}</td><td>{row[4]}</td><td>{row[5]}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function IntuoColorsTable() {
  const colors = [
    ["שחור", "KL909001", "KL909005"],
    ["כחול לילה", "KL901001", "KL901005"],
    ["ירוק זית", "KL924001", "KL924005"],
    ["צהוב הדרים", "KL966001", "KL966005"],
    ["ליים", "KL974001", "KL974005"],
  ] as const;
  return (
    <div className="journal-table-scroll" role="region" aria-label="צבעי Intuo 55 לפי מק״ט" tabIndex={0}>
      <table className="journal-table"><thead><tr><th scope="col">צבע</th><th scope="col">Intuo 55</th><th scope="col">Intuo 55 Easy Access</th></tr></thead><tbody>
        {colors.map((row) => <tr key={row[0]}><th scope="row">{row[0]}</th><td dir="ltr">{row[1]}</td><td dir="ltr">{row[2]}</td></tr>)}
      </tbody></table>
    </div>
  );
}

const carryOnSizesContent: ReactNode = <>
  <p>״טרולי 55 ס״מ״ אינו מפרט אחיד בין דגמים. רוחב, עומק, נפח וחומר משתנים לפי הסדרה, וגם בין גרסה רגילה לגרסת Easy Access. ריכזנו כאן את נתוני היצרן של דגמי Samsonite בגודל הזה שמופיעים בגלריה, לפי המק״ט המדויק.</p>
  <p>בכל שורה אפשר להשוות בין הדגם והצבע לבין מידותיו כשהוא סגור וכשההרחבה פתוחה. הנתונים מתארים את המוצר עצמו; הם אינם אישור לכך שהוא עומד במידות כבודת היד של חברת תעופה מסוימת.</p>
  <h2>השוואת הדגמים</h2>
  <SizesTable />
  <p className="journal-note">היצרנים מפרסמים נפח בשיטות שונות. בדגמי Upscape הבסיסיים מוצג נפח כשהמזוודה מורחבת בלבד; אין להשוות אותו ישירות לנפח סגור/מורחב של דגם אחר.</p>
  <h2>איך לקרוא את הטבלה</h2>
  <ul><li><strong>בהרחבה:</strong> עומק המזוודה כשהרוכסן ההיקפי פתוח.</li><li><strong>נפח כפול:</strong> הנתון הראשון הוא הנפח הסגור והשני הוא הנפח לאחר הרחבה.</li><li><strong>מק״ט:</strong> מזהה את השילוב המדויק של דגם וגרסה, ולא רק את שם הסדרה.</li></ul>
  <p>מידות כבודת היד והכללת טרולי בכרטיס הטיסה נקבעות לפי חברת התעופה, סוג הכרטיס והמסלול. כדאי לבדוק את המידע העדכני ישירות מול חברת התעופה לפני הנסיעה.</p>
  <h2>דגמים לדוגמה בגלריה</h2>
  <p>אפשר לראות את ההבדלים החזותיים בין מעטפת קשיחה, מזוודה מבד ושתי גרסאות באותה סדרה:</p>
  <ArticleProductCards skus={["KL909001", "KJ109001", "KO709005"]} />
</>;

const intuoContent: ReactNode = <>
  <p>ב-Samsonite Intuo בגודל 55 ס״מ קיימות בגלריה שתי גרסאות שנראות דומות במבט ראשון: Intuo הרגילה ו-Intuo Easy Access. ההבדל המעשי הבולט במפרט הוא העומק: גרסת Easy Access עמוקה יותר גם כשהיא סגורה וגם כשההרחבה פתוחה.</p>
  <h2>הבדלים במידות ובנפח</h2>
  <div className="journal-table-scroll" role="region" aria-label="השוואת Intuo 55 ו-Easy Access" tabIndex={0}>
    <table className="journal-table"><thead><tr><th scope="col">נתון יצרן</th><th scope="col">Intuo 55</th><th scope="col">Intuo 55 Easy Access</th></tr></thead><tbody>
      <tr><th scope="row">מידות סגורות</th><td dir="ltr">55×40×20 ס״מ</td><td dir="ltr">55×40×23 ס״מ</td></tr>
      <tr><th scope="row">מידות בהרחבה</th><td dir="ltr">55×40×23 ס״מ</td><td dir="ltr">55×40×26 ס״מ</td></tr>
      <tr><th scope="row">נפח סגור / מורחב</th><td>39 / 45 ליטר</td><td>42 / 48 ליטר</td></tr>
    </tbody></table>
  </div>
  <p>לפי הנתונים האלה, Easy Access עמוקה ב-3 ס״מ ומציעה כ-3 ליטר נוספים בשני מצבי ההרחבה. זהו הבדל במידות ובנפח, לא קביעה איזו גרסה מתאימה יותר לכל נוסע.</p>
  <h2>כך נראות שתי הגרסאות</h2>
  <p>התמונות בגלריה מאפשרות לבדוק את החזית, הצד, הפתיחה והפרטים החיצוניים של כל גרסה. אפשר לפתוח כל מוצר, לעבור בין הזוויות, ואז להמשיך לעמוד הדגם המדויק בחנות.</p>
  <ArticleProductCards skus={["KL909001", "KL909005"]} />
  <h2>הצבעים שמופיעים בגלריה</h2>
  <IntuoColorsTable />
  <p>הצבעים והמק״טים בטבלה מתייחסים למוצרים המוצגים בגלריה בזמן עדכון העמוד. תמונות המוצר מאפשרות להשוות את המראה בין הגרסאות; מחיר, מלאי וזמינות רכישה מוצגים בחנות.</p>
  <p className="journal-note">מידות כבודת היד בפועל תלויות במדיניות חברת התעופה ובכרטיס שנרכש. יש לבדוק את התנאים העדכניים מול המפעיל לפני הטיסה.</p>
</>;

const intuoSizeLadderContent: ReactNode = <>
  <p>בתוך סדרת Intuo, גובה חיצוני לבדו לא מספר את כל הסיפור. כשעוברים מ-55 ל-69 ואז ל-81 ס״מ, גם הרוחב והעומק גדלים, והנפח הרשמי עולה בהתאם. הטבלה משווה שלושה גדלים שהמק״טים שלהם מוצגים כעת בגלריה; היא מתארת מידות מוצר, לא התאמה לכל חברת תעופה או משך נסיעה.</p>
  <h2>שלושה גדלים לפי נתוני היצרן</h2>
  <div className="journal-table-scroll" role="region" aria-label="השוואת מידות Intuo 55, 69 ו-81 ס״מ" tabIndex={0}>
    <table className="journal-table">
      <caption>מידות חיצוניות: גובה × רוחב × עומק; נפח סגור/מורחב</caption>
      <thead><tr><th scope="col">גודל</th><th scope="col">מידות סגורות</th><th scope="col">בהרחבה</th><th scope="col">נפח</th><th scope="col">מק״ט מוצג</th></tr></thead>
      <tbody>
        <tr><th scope="row">55 ס״מ</th><td dir="ltr">55×40×20</td><td dir="ltr">55×40×23</td><td>39/45 ל׳</td><td dir="ltr">KL909001</td></tr>
        <tr><th scope="row">69 ס״מ</th><td dir="ltr">69×48×28</td><td dir="ltr">69×48×31</td><td>79/87 ל׳</td><td dir="ltr">KL909002</td></tr>
        <tr><th scope="row">81 ס״מ</th><td dir="ltr">81×54×33</td><td dir="ltr">81×54×36</td><td>132/144 ל׳</td><td dir="ltr">KL909004</td></tr>
      </tbody>
    </table>
  </div>
  <h2>איך השינוי מתחלק בין המידות לנפח</h2>
  <p>בין 55 ל-69 ס״מ, הגובה גדל ב-14 ס״מ והרוחב ב-8 ס״מ. הנפח שמפרסם Samsonite עולה מ-39/45 ליטר ל-79/87 ליטר. בין 69 ל-81 ס״מ מתווספים 12 ס״מ לגובה ו-6 ס״מ לרוחב, והנפח עולה ל-132/144 ליטר. אלה הבדלים בין נתוני הדגמים, לא הבטחה לכמות מסוימת של פריטים שתיכנס בפועל.</p>
  <p>לכל אחד משלושת הדגמים יש רוכסן הרחבה, והיצרן מציג לכל אחד תוספת עומק של 3 ס״מ. תוספת הנפח אינה אחידה: 6 ליטר בגודל 55, 8 ליטר בגודל 69 ו-12 ליטר בגודל 81. לכן כדאי להשוות גם את מצב הסגירה וגם את מצב ההרחבה, ולא להסתפק בכותרת המציינת גובה.</p>
  <h2>לראות את קנה המידה בתמונות</h2>
  <p>בגלריה אפשר לפתוח כל דגם, לעבור בין התמונות ולבחון את החזית, הצד והחלוקה הפנימית. הכרטיסים הבאים מובילים לדגמים המדויקים בחנות; צבע ומחיר נבדקים שם לפי הווריאנט העדכני.</p>
  <ArticleProductCards skus={["KL909001", "KL909002", "KL909004"]} />
  <p className="journal-note">מידות כבודת יד, כבודה לבטן המטוס ותנאי הכרטיס משתנים בין חברות תעופה ומסלולים. בדקו את הכללים העדכניים ישירות מול המפעיל לפני הנסיעה.</p>
</>;

const bricsPilotCaseContent: ReactNode = <>
  <p>תיק פיילוט על גלגלים יושב בין תיק עבודה למזוודת קבינה: המידות שלו קומפקטיות, אבל בפנים יש חלוקה שנועדה גם למחשב וגם לבגדים. דגם BXL38124 של Bric&apos;s X-Collection מציע שתי דרכי נשיאה ביד וגלגלים לנסיעה קצרה; המדריך הזה מפרט מה היצרן מציג בו ואיך לבדוק את המבנה בתמונות הגלריה.</p>
  <ArticleProductCards skus={["BXL38124078"]} />
  <h2>חלוקה פנימית לשני תאים</h2>
  <p>לפי עמוד היצרן, בתא הראשון נמצאים כיס מרופד למחשב ושני כיסים לארגון כבלים ואביזרים. התא השני כולל רצועה לבגדים או לחולצות ושלושה כיסים שטוחים. הדופן הצדדית נסגרת ברצועת ולקרו, שבעזרתה אפשר לווסת את פתיחת התיק.</p>
  <p>היצרן לא מפרסם בעמוד הזה מידות פנימיות לכיס המחשב, ולכן אין להסיק ממנו התאמה לגודל מסך מסוים. לפני בחירה, כדאי להשוות את המחשב עצמו למידות שהיצרן מספק בחנות או לפנות אליה לבירור.</p>
  <h2>ידית, גלגלים ושתי דרכי נשיאה</h2>
  <p>ידית המשיכה מתכווננת לגבהים שונים ומתקפלת לתוך תא סגור ברוכסן כשהיא אינה בשימוש. שתי ידיות עליונות עם סגירת כפתור מאפשרות נשיאה ביד. בבסיס נמצאים שני גלגלים ושתי רגליות תמיכה — מבנה שונה מטרולי ארבעה-גלגלים, ולכן כדאי להתבונן בתחתית ובצדדים ולא להסתמך רק על צילום החזית.</p>
  <h2>מידות וחומרים</h2>
  <p>מידות הדגם הן 40.5×35×16 ס״מ. היצרן מציין פוליאמיד עם ציפוי PVC, ובפרטי הטיפול — 100% פוליאמיד וכביסה ביד. פרטי החומר והטיפול מובאים כפי שמופיעים בעמוד Bric&apos;s; אין בכך הבטחה לעמידות בפני גשם או הגנה למחשב מעבר לכיס המרופד.</p>
  <p>בגלריה אפשר לעבור בין הזוויות של הצבעים השונים ולבדוק מקרוב את הידיות, הרוכסנים, החלוקה והגלגלים. כפתור הרכישה בכרטיס מוביל לווריאנט המדויק בחנות.</p>
</>;

const bricsTaorminaSizesContent: ReactNode = <>
  <p>משפחת Taormina של Bric&apos;s כוללת ארבעה גדלים עם אותה שפה חיצונית: 55, 69, 75 ו-82 ס״מ. הנתונים שלהלן מגיעים מעמודי היצרן ומציגים את הגובה, הרוחב והעומק לפני פתיחת ההרחבה ואחריה. זו השוואת מידות בין הדגמים, לא המלצה לגודל מסוים או אישור לכללי כבודה.</p>
  <h2>ארבעת הגדלים לפי Bric&apos;s</h2>
  <div className="journal-table-scroll" role="region" aria-label="מידות דגמי Taormina לפי גודל" tabIndex={0}>
    <table className="journal-table"><caption>גובה × רוחב × עומק, בסנטימטרים</caption><thead><tr><th scope="col">גודל</th><th scope="col">מידות</th><th scope="col">דגם יצרן</th></tr></thead><tbody>
      <tr><th scope="row">55</th><td dir="ltr">40×55×22/26</td><td dir="ltr">BAH08451.001</td></tr>
      <tr><th scope="row">69</th><td dir="ltr">47×69×26/30</td><td dir="ltr">BAH08452</td></tr>
      <tr><th scope="row">75</th><td dir="ltr">52×75×28/32</td><td dir="ltr">BAH08453.001</td></tr>
      <tr><th scope="row">82</th><td dir="ltr">57×82×30/34</td><td dir="ltr">BAH08454.001</td></tr>
    </tbody></table>
  </div>
  <p>בכל אחד מארבעת הגדלים הנתון האחרון משתנה כשההרחבה פתוחה. התוספת לעומק שמציג היצרן היא 4 ס״מ ל-55, ל-69 ול-75; בדגם 82 היא גם 4 ס״מ. בדקו את המידות של הדגם והווריאנט המדויקים, משום ששם הסדרה לבדו אינו אומר מהו הגודל.</p>
  <h2>לראות את ההבדל בקנה מידה</h2>
  <p>בתמונות הגלריה אפשר להשוות את הדגמים המוצגים ולפתוח כל אחד לבדיקת הזוויות. כרטיסי המוצר מובילים לווריאנטים המדויקים בחנות; המחיר והזמינות מוצגים שם.</p>
  <ArticleProductCards skus={["BAH08451.001", "BAH08453.001", "BAH08454.001"]} />
  <p className="journal-note">המידות והמאפיינים עשויים להשתנות לפי דגם ושוק. הנתונים כאן מתייחסים לדפי Bric&apos;s המקושרים במרשם המקורות, שנבדקו ב-30 בספטמבר 2026.</p>
</>;

const bricsXCollectionSizesContent: ReactNode = <>
  <p>ב-X-Collection מופיעים בגלריה שני טרולים רכים בקצוות שונים של טווח הגודל: דגם carry-on בגובה 55 ס״מ ודגם XL בגובה 77 ס״מ. שניהם בנויים מבד עם ציפוי, אבל המידות, קיבולת הארגון והגלגלים מתאימים להשוואה חזותית בין תיק קטן יותר למזוודה גדולה.</p>
  <h2>מה משתנה בין 55 ל-77 ס״מ</h2>
  <div className="journal-table-scroll" role="region" aria-label="השוואת X-Collection בגודל 55 ו-77" tabIndex={0}>
    <table className="journal-table"><caption>מידות חיצוניות ופרטים מעמודי Bric&apos;s</caption><thead><tr><th scope="col">דגם</th><th scope="col">מידות</th><th scope="col">מבנה מתועד</th></tr></thead><tbody>
      <tr><th scope="row">Carry-on · BXL58117</th><td dir="ltr">36×55×23 ס״מ</td><td>4 גלגלים כפולים, שני כיסים קדמיים, כיסים פנימיים ורצועות אריזה</td></tr>
      <tr><th scope="row">XL · BXL58145</th><td dir="ltr">48×77×26 ס״מ</td><td>4 גלגלים כפולים, שני כיסים קדמיים, כיסים פנימיים ורצועות אריזה</td></tr>
    </tbody></table>
  </div>
  <p>בשני עמודי המוצר Bric&apos;s מתארת את המבנה הפנימי ואת הכיסים הקדמיים, ומציינת גלגלים שקועים שמטרתם למקסם את המקום הפנימי. פירושו של דבר אינו הבטחה לנפח מסוים: הנפח לא פורסם בעמודים ששימשו כאן, ולכן לא הוספנו הערכת ליטרים.</p>
  <h2>השוואה חזותית בגלריה</h2>
  <p>הכרטיסים מציגים את הצבעים הזמינים בגלריה. לחיצה על כפתור החנות פותחת את עמוד המוצר ואת הווריאנט המדויק באותה לשונית.</p>
  <ArticleProductCards skus={["BXL58117.101", "BXL58145.101"]} />
</>;

const urbifySizesContent: ReactNode = <>
  <p>Urbify היא סדרת מזוודות רכות של Samsonite שמוצגת בגלריה בשלושה גבהים: 55, 68 ו-78 ס״מ. ההשוואה כאן מתמקדת במידות החיצוניות ובעומק ההרחבה כפי שמופיעים בעמודי המותג; היא אינה משווה כמה ציוד ייכנס בפועל.</p>
  <h2>מידות של שלושת הגדלים</h2>
  <div className="journal-table-scroll" role="region" aria-label="מידות Urbify 55, 68 ו-78" tabIndex={0}>
    <table className="journal-table"><caption>גובה × רוחב × עומק, בסנטימטרים</caption><thead><tr><th scope="col">גודל</th><th scope="col">סגור</th><th scope="col">בהרחבה</th><th scope="col">SKU יצרן במקור</th></tr></thead><tbody>
      <tr><th scope="row">55</th><td dir="ltr">55×40×23</td><td dir="ltr">55×40×26</td><td dir="ltr">150715-1693</td></tr>
      <tr><th scope="row">68</th><td dir="ltr">68×43×27</td><td dir="ltr">68×43×31</td><td dir="ltr">150716-1693</td></tr>
      <tr><th scope="row">78</th><td dir="ltr">78×48×30</td><td dir="ltr">78×48×34</td><td dir="ltr">150717-1693</td></tr>
    </tbody></table>
  </div>
  <p>כל שלושת הדגמים הם טרולים רכים עם ארבעה גלגלים והרחבה. מידות הרוחב והעומק גדלות יחד עם הגובה; לכן לא כדאי לבחור לפי המספר שבשם בלבד. השוו את שלושת הצירים ואת מצב ההרחבה, ואז בדקו את מגבלות הכבודה הספציפיות לנסיעה מול חברת התעופה.</p>
  <ArticleProductCards skus={["KO709005", "KO709006", "KO709007"]} />
</>;

const mandarinaMetalSetContent: ReactNode = <>
  <p>בגלריה מופיעים שני פריטים בגימור Logoduck+ Metal בגוון Lunar: טרולי קבינה ותיק יופי. התאמת העיצוב מאפשרת לראות אותם יחד, אבל לכל אחד תפקיד ומבנה משלו.</p>
  <h2>מה יש בתיק היופי</h2>
  <p>לפי Mandarina Duck, תיק היופי עשוי מעטפת קשיחה, כולל רצועת כתף נשלפת, חלוקה לשני תאים, מחיצה פנימית וכיס רוכסן. רצועה בגב התיק מיועדת לחיבור לידית הטרולי. מידות היצרן הן 28.5×26.5×16.5 ס״מ; הסדר כאן מציג את אותם שלושה צירים כפי שנמסרו בעמוד.</p>
  <h2>לראות את שני הפריטים זה לצד זה</h2>
  <p>תמונות הגלריה מציגות את המרקם המתכתי ואת ההבדל בין צורת הטרולי לתיק היופי. כפתורי החנות מובילים לכל עמוד מוצר בנפרד, שם ניתן לבדוק את הווריאנט ואת זמינותו העדכנית.</p>
  <ArticleProductCards skus={["P10OUV24-A89-TU", "P10OUN01-A89-TU"]} />
  <p className="journal-note">העמוד מתאר התאמה עיצובית ואמצעי חיבור שמפרסם היצרן; אין כאן טענה שהפריטים נמכרים כסט או שמחירם/זמינותם משותפים.</p>
</>;

const ecoCoatedOrganizationContent: ReactNode = <>
  <p>ב-Mandarina Duck Eco Coated Large, המבט בתמונות החזית והפתיחה עוזר להבין איך מחולק הטרולי הרך. עמוד היצרן מתאר תא ראשי אחד, כיס קדמי גדול, כיס עליון עם מחזיק אלסטי לתיק, ושלושה כיסים פנימיים עם רוכסן.</p>
  <h2>חלוקה ופתיחה</h2>
  <p>רצועות פנימיות עם אבזמים נועדו לקבע פריטים בתוך התא הראשי. הידית נשלפת ומתכווננת לכמה שלבים, ובדף היצרן מצוינים גם ידית עליונה וידית צדדית ומנעול TSA משולב. אלה פרטים שניתן לבדוק בתמונות המוצר ובמפרט, בלי לייחס להם תכונות שלא נמדדו.</p>
  <h2>החומר לפי היצרן</h2>
  <p>Mandarina Duck מתארת את הבד החיצוני כ-100% פוליאסטר ממוחזר עם ציפוי. המותג מציין גם כי למשטח יש ציפוי עמיד במים; ניסוח זה מתאר את הצהרת היצרן בלבד ואינו דירוג אטימות או הבטחה לשימוש בגשם כבד.</p>
  <ArticleProductCards skus={["P10OSV04-05J-TU"]} />
</>;

const activeLuxPocketMapContent: ReactNode = <>
  <p>תיק ה-Shopper של Active Lux מציג במבט אחד כמה אזורי אחסון: כיסי רוכסן בחוץ לצד חלוקה קטנה לפריטים בתוך התיק. העמוד הזה ממפה את הכיסים לפי תיאור Mandarina Duck, כדי שאפשר יהיה להשוות בין מראה התיק בגלריה לבין המבנה המתואר.</p>
  <h2>מפת הכיסים</h2>
  <ul><li><strong>בחוץ:</strong> כיס קדמי אחד עם רוכסן, כיס אחורי אחד עם רוכסן ושני כיסי צד קטנים עם רוכסן.</li><li><strong>בפנים:</strong> כיס פנימי אחד עם רוכסן ושני כיסי טלאי לטלפון.</li><li><strong>נשיאה:</strong> לפי היצרן אפשר לשאת ביד או על הכתף; רצועת הסרט מתכווננת באמצעות טבעת הזזה.</li></ul>
  <p>המידות שמופיעות בדף הרשמי הן 30×35×16 ס״מ. כדאי לראות בתמונות כיצד הכיסים ממוקמים, ובחנות לבדוק את הדגם והצבע המדויקים לפני רכישה. העמוד אינו טוען שחפצים במידה מסוימת יתאימו לכל כיס.</p>
  <ArticleProductCards skus={["P10ZJT06-24U-TU"]} />
</>;

const bricsTaorminaCabinDetailsContent: ReactNode = <>
  <p>עמוד מידות Taormina משווה את ארבעת הגבהים של הסדרה. כאן מתמקדים בדגם הקבינה BAH08451: בפרטי המבנה והארגון הפנימי שמופיעים בתיאור הרשמי ובתמונות המוצר.</p>
  <h2>החלוקה בפנים</h2>
  <p>Bric’s מציינת בטנה מפוליאסטר, משטח פנימי שקל לנקות, רוכסן פנימי ורצועות שמחזיקות בגדים. התמונות בגלריה מאפשרות לראות את החלוקה ואת מיקום הרצועות בלי להסתמך על הדמיה של מוצר אחר.</p>
  <h2>הפרטים החיצוניים</h2>
  <p>לפי היצרן, המעטפת עשויה פוליקרבונט, והרוכסן ההיקפי מאפשר הרחבה. בדגם מצוינים גם מנעול TSA, רוכסן נגד חדירה, שקע USB מובנה, ארבעה גלגלים כפולים שקטים, מערכת גרירה רב-מצבית וידית עליונה מעור רך.</p>
  <p className="journal-note">היצרן מציין שקע USB, אך בעמוד המקור שנבדק לא מפורט אם מקור מתח נכלל. אין לראות בשקע עצמו הוכחה שסוללה או power bank מגיעים עם הטרולי.</p>
  <ArticleProductCards skus={["BAH08451.001"]} />
</>;

const samsoniteCLite75vs86Content: ReactNode = <>
  <p>שני דגמי C-Lite המופיעים בגלריה מדגימים את המעבר ממזוודה גדולה ל-XXL: 75 ס״מ בשחור ו-86 ס״מ בלבנדר. ההשוואה כאן היא של נתוני היצרן והמבנה, לא המלצה על גודל שמתאים לכל נסיעה.</p>
  <h2>ההבדל במידות ובנפח</h2>
  <div className="journal-table-scroll" role="region" aria-label="השוואת Samsonite C-Lite 75 ו-86 ס״מ" tabIndex={0}>
    <table className="journal-table"><thead><tr><th scope="col">נתון יצרן</th><th scope="col">C-Lite 75 · שחור</th><th scope="col">C-Lite 86 · לבנדר</th></tr></thead><tbody>
      <tr><th scope="row">מידות חיצוניות</th><td dir="ltr">75×51×31 ס״מ</td><td dir="ltr">86×58×36 ס״מ</td></tr>
      <tr><th scope="row">נפח</th><td>94 ליטר</td><td>144 ליטר</td></tr>
      <tr><th scope="row">גודל לפי היצרן</th><td>Large</td><td>XXL</td></tr>
      <tr><th scope="row">חומר המעטפת</th><td>Curv™ — פוליפרופילן ארוג</td><td>Curv™ — פוליפרופילן ארוג</td></tr>
    </tbody></table>
  </div>
  <p>ההפרש בין שני המפרטים הוא 11 ס״מ בגובה, 7 ס״מ ברוחב, 5 ס״מ בעומק ו-50 ליטר בנפח הרשמי. המספרים מתארים את הדגמים הספציפיים; הם לא אומדן לכמות פריטים שתיכנס בפועל.</p>
  <h2>מה משותף למבנה</h2>
  <p>בשני עמודי Samsonite מצוינים מעטפת Curv™, מנעול קומבינציה עם TSA, ידיות עליונה, צדית ותחתונה, ידית משיכה דו-צינורית וארבעה גלגלים עם מתלה שמפחית רעש וזעזועים. בפנים, תחתית עם רצועות ותא עליון עם מחיצה מרופדת.</p>
  <p className="journal-note">לפני נסיעה, בדקו בנפרד את מגבלות המידות והמשקל של חברת התעופה. ההשוואה אינה קובעת שאחד הגדלים מתקבל בטיסה מסוימת.</p>
  <ArticleProductCards skus={["S209004", "S281006"]} />
</>;

const samsoniteRespark79MaterialsContent: ReactNode = <>
  <p>בעמוד הרשמי של Samsonite, Respark Spinner 79/29 מתואר כמזוודה מתרחבת בצבע Light Sage. הנה הנתונים של הדגם המדויק שמופיע בגלריה, לצד פירוט חומרי המיחזור כפי שהיצרן עצמו מגדיר אותם.</p>
  <h2>מידות ונפח לפני ואחרי הרחבה</h2>
  <p>המידות הן 79×48×31 ס״מ כשהמזוודה סגורה ו-79×48×35 ס״מ כשההרחבה פתוחה. Samsonite מציינת נפח של 124/140 ליטר. לכן, בבדיקת מקום אחסון או תנאי כבודה, חשוב להביא בחשבון גם את עומק ה-35 ס״מ במצב המורחב.</p>
  <h2>מה כולל נתון החומר הממוחזר?</h2>
  <p>לפי עמוד היצרן, הבד החיצוני מכיל לפחות 80% PET ממוחזר מפסולת צרכנית, והבטנה הפנימית לפחות 95% PET ממוחזר מאותו מקור. האחוזים מתייחסים לרכיבים האלה לפי משקל; הם אינם טענה שכל חלקי המזוודה עשויים מחומר ממוחזר או מדד להשפעה הסביבתית הכוללת שלה.</p>
  <h2>הדגם בגלריה</h2>
  <p>כרטיס המוצר מציג את המק״ט של TopTik עבור Respark 79 בגוון Light Sage. אפשר לפתוח את תמונות הדגם בגלריה, ואז לעבור לעמוד המוצר המדויק בחנות.</p>
  <ArticleProductCards
    skus={["KJ344007"]}
    descriptionOverrides={{ KJ344007: "Respark 79 בגוון מרווה בהירה: נפח 124 ליטר, עם הרחבה ל־140 ליטר; עומק המזוודה גדל מ־31 ל־35 ס״מ." }}
  />
</>;

export const galleryArticles: readonly GalleryArticle[] = [
  ...premiumArticles,
  ...collectionArticles,
  ...practicalArticles,
  ...lifestyleArticles,
  {
    slug: "samsonite-carry-on-55-sku-dimensions",
    category: "מידות לפי מק״ט",
    title: "טרולי Samsonite בגודל 55 ס״מ: מידות היצרן לפי מק״ט",
    description: "השוואת מידות, נפח וחומר של דגמי Samsonite בגודל 55 ס״מ שמוצגים בגלריית TopTik, לפי מק״ט וגרסת המוצר.",
    standfirst: "טבלת יצרן ממוקדת ל-20 מק״טים: Intuo, Upscape ו-Urbify, כולל גרסאות Easy Access והמידות בהרחבה.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 4,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://www.samsonite.fi/intuo-spinner-expandable-55cm--black/146913-1041.html",
      "https://www.samsonite.fi/intuo-spinner-55-20-exp-easy-access-55cm--black/150720-1041.html",
      "https://www.samsonite.com.au/upscape/spinner-55-exp/ss-143108-9199.html",
      "https://www.samsonite.co.uk/urbify-spinner-expandable-55cm-pine-green/150715-1693.html",
    ],
    content: carryOnSizesContent,
  },
  {
    slug: "samsonite-intuo-55-vs-easy-access",
    category: "השוואה חזותית",
    title: "Samsonite Intuo 55 מול Easy Access: ההבדלים במידות ובנפח",
    description: "השוואה בין שתי גרסאות Samsonite Intuo בגודל 55 ס״מ: מידות סגורות ובהרחבה, נפח, צבעים ותמונות המוצרים בגלריה.",
    standfirst: "שתי גרסאות באותה סדרה ובאותו גובה — עם הבדל מדיד בעומק ובנפח, ותמונות שאפשר להשוות זו לצד זו.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://www.samsonite.fi/intuo-spinner-expandable-55cm--black/146913-1041.html",
      "https://www.samsonite.fi/intuo-spinner-55-20-exp-easy-access-55cm--black/150720-1041.html",
    ],
    content: intuoContent,
  },
  {
    slug: "samsonite-intuo-sizes-55-69-81",
    category: "מידות לפי סדרה",
    title: "Samsonite Intuo: ההבדלים בין 55, 69 ו-81 ס״מ",
    description: "השוואת מידות ונפח יצרן בשלושה גדלי Samsonite Intuo שמופיעים בגלריה, כולל השינוי שמוסיפה ההרחבה.",
    standfirst: "גובה המזוודה משתנה יחד עם הרוחב, העומק והנפח. כך נראים שלושה גדלי Intuo זה לצד זה לפי מפרט Samsonite.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://www.samsonite.fi/intuo-spinner-expandable-55cm--black/146913-1041.html",
      "https://www.samsonite.fi/intuo-spinner-expandable-69cm--black/146914-1041.html",
      "https://www.samsonite.fi/intuo-spinner-expandable-81cm--black/146916-1041.html",
    ],
    content: intuoSizeLadderContent,
  },
  {
    slug: "brics-x-collection-wheeled-pilot-case-bxl38124",
    category: "מבט מקרוב על הדגם",
    title: "Bric's X-Collection BXL38124: תיק פיילוט על גלגלים מבפנים",
    description: "סקירה של מבנה תיק הפיילוט BXL38124 לפי מפרט Bric's: חלוקת תאים, כיס מרופד למחשב, ידיות, גלגלים ומידות.",
    standfirst: "שני תאים, כיס מרופד למחשב, רצועת בגדים וגלגלים דו-גלגליים — כך בנוי דגם BXL38124 לפי היצרן.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: ["https://www.bricsmilano.com/en-eu/collections/x-collection/products/laptop-bag-with-wheels-in-recycled-fabric-bxl38124"],
    content: bricsPilotCaseContent,
  },
  {
    slug: "brics-taormina-four-sizes-dimensions",
    category: "מידות לפי סדרה",
    title: "Bric's Taormina: השוואת מידות בין 55, 69, 75 ו-82 ס״מ",
    description: "טבלת מידות היצרן לארבעת גדלי Bric's Taormina, כולל עומק בהרחבה ודרך להשוות את המוצרים בתמונות הגלריה.",
    standfirst: "ארבעה גדלים באותה סדרה: כך משתנים הגובה, הרוחב והעומק לפי מפרט Bric's.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://www.bricsmilano.com/en-eu/collections/new-arrivals/products/taormina-ultra-light-cabin-trolley-bah08451",
      "https://www.bricsmilano.com/en-eu/collections/new-arrivals/products/taormina-ultra-light-medium-trolley-bah08452",
      "https://www.bricsmilano.com/en-eu/collections/new-arrivals/products/taormina-ultra-light-large-trolley-bah08453",
      "https://www.bricsmilano.com/en-eu/collections/new-arrivals/products/taormina-ultra-light-xl-trolley-bah08454",
    ],
    content: bricsTaorminaSizesContent,
  },
  {
    slug: "brics-x-collection-soft-trolley-55-vs-77",
    category: "השוואת מידות וארגון",
    title: "Bric's X-Collection: טרולי 55 ס״מ מול מזוודת XL בגודל 77",
    description: "השוואה בין שני דגמי X-Collection לפי מידות היצרן, כיסים, חלוקה וגלגלים, עם כרטיסי המוצרים בגלריה.",
    standfirst: "שני טרולים רכים באותה קולקציה, עם מידות שונות ופרטי ארגון שאפשר לבדוק בתמונות.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://www.bricsmilano.com/en-eu/collections/new-arrivals/products/trolley-carry-on-x-collection-bxl58117",
      "https://www.bricsmilano.com/en-eu/collections/large-trolleys/products/xl-trolley-x-collection-bxl58145",
    ],
    content: bricsXCollectionSizesContent,
  },
  {
    slug: "samsonite-urbify-55-68-78-dimensions",
    category: "מידות לפי סדרה",
    title: "Samsonite Urbify: מה משתנה בין 55, 68 ו-78 ס״מ",
    description: "השוואת מידות סגורות ובהרחבה בשלושה גדלי Samsonite Urbify לפי מק״ט יצרן ותמונות הגלריה.",
    standfirst: "שלושה גדלים של Urbify, עם שינוי הדרגתי בגובה, ברוחב ובעומק לפני ואחרי הרחבה.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://www.samsonite.co.uk/urbify-spinner-expandable-55cm-pine-green/150715-1693.html",
      "https://www.samsonite.co.uk/urbify-spinner-expandable-68cm-pine-green/150716-1693.html",
      "https://www.samsonite.co.uk/urbify-spinner-expandable-78cm-pine-green/150717-1693.html",
    ],
    content: urbifySizesContent,
  },
  {
    slug: "mandarina-logoduck-metal-trolley-beauty-case",
    category: "התאמה חזותית",
    title: "Mandarina Duck Logoduck+ Metal: טרולי ותיק יופי בגוון Lunar",
    description: "סקירה של שני פריטי Logoduck+ Metal בגוון Lunar: מידות תיק היופי, חלוקתו וחיבורו לידית טרולי לפי היצרן.",
    standfirst: "אותו גימור מתכתי בשני פריטים נפרדים — תיק יופי עם רצועת כתף ורצועה לחיבור לטרולי.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://mandarinaduck.com/en-us/products/logoduck-metal-cabin-expandable-lunar-ouv24a89",
      "https://mandarinaduck.com/en-gb/products/logoduck-metal-beauty-case-lunar-oun01a89",
    ],
    content: mandarinaMetalSetContent,
  },
  {
    slug: "mandarina-eco-coated-large-interior-map",
    category: "מבט מקרוב על הדגם",
    title: "Mandarina Duck Eco Coated Large: מפת הכיסים והחלוקה",
    description: "מיפוי התא הראשי, הכיסים, הרצועות והמנעול בטרולי Eco Coated Large לפי עמוד היצרן.",
    standfirst: "כיס קדמי גדול, כיס עליון ושלושה כיסים פנימיים — כך מתוארת החלוקה בדגם Eco Coated Large.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: ["https://mandarinaduck.com/en-us/products/eco-coated-trolley-large-expandable-duck-yellow-osv0405j"],
    content: ecoCoatedOrganizationContent,
  },
  {
    slug: "mandarina-active-lux-shopper-pocket-layout",
    category: "מבט מקרוב על הדגם",
    title: "Mandarina Duck Active Lux Shopper: איפה נמצא כל כיס",
    description: "מפת כיסים ותיאור נשיאה של Active Lux Shopper לפי Mandarina Duck, יחד עם תמונת הדגם המדויקת בגלריה.",
    standfirst: "כיסי רוכסן בחזית, בגב ובצדדים, לצד חלוקה פנימית לטלפון ולאביזרים.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 2,
    byline: "מערכת מגזין TopTik",
    releaseBlocker: "אין מיפוי מאומת לעמוד מוצר Shopify של המק״ט P10ZJT06-24U-TU.",
    sourceUrls: ["https://mandarinaduck.com/en-us/products/active-lux-shopper-gun-metal-zjt0624u"],
    content: activeLuxPocketMapContent,
  },
  {
    slug: "brics-taormina-55-interior-and-features",
    category: "מבט מקרוב על הדגם",
    title: "Bric’s Taormina 55: מבט מקרוב על הארגון והפרטים",
    description: "מבט במבנה הפנימי ובפרטים החיצוניים של טרולי Bric’s Taormina 55 לפי עמוד היצרן ותמונות הדגם בגלריה.",
    standfirst: "לא טבלת מידות נוספת: סקירה ממוקדת של הבטנה, רצועות הארגון, ההרחבה והגלגלים בדגם BAH08451.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 2,
    byline: "מערכת מגזין TopTik",
    sourceUrls: ["https://www.bricsmilano.com/en-eu/collections/new-arrivals/products/taormina-ultra-light-cabin-trolley-bah08451"],
    content: bricsTaorminaCabinDetailsContent,
  },
  {
    slug: "samsonite-c-lite-75-vs-86",
    category: "השוואת מידות וארגון",
    title: "Samsonite C-Lite 75 מול 86 ס״מ: מידות, נפח ומבנה",
    description: "השוואה בין שני דגמי C-Lite המוצגים בגלריה: מידות חיצוניות, נפח, חומר המעטפת ופרטי הארגון לפי Samsonite.",
    standfirst: "C-Lite 75 שחורה מול C-Lite 86 בלבנדר: נתוני היצרן זה לצד זה, יחד עם תמונות של שני הדגמים המדויקים.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [
      "https://www.samsonite.co.uk/c-lite-spinner-75cm-black/122861-1041.html",
      "https://www.samsonite.co.uk/c-lite-spinner-86cm-lavender/122863-1491.html",
    ],
    content: samsoniteCLite75vs86Content,
  },
  {
    slug: "samsonite-respark-79-recycled-materials",
    category: "מפרט לפי מק״ט",
    title: "Samsonite Respark 79: מידות ההרחבה וחומרי הבד הממוחזרים",
    description: "מידות, נפח והגדרת Samsonite לחומר הממוחזר בבד החיצוני ובבטנה של Respark Spinner 79/29 בגוון Light Sage.",
    standfirst: "מפרט לפי דגם מדויק: מה משתנה כשההרחבה פתוחה, ואילו חלקים מקבלים אחוז PET ממוחזר לפי היצרן.",
    publishedAt: "2026-09-30",
    updatedAt: "2026-09-30",
    readingMinutes: 2,
    byline: "מערכת מגזין TopTik",
    sourceUrls: ["https://www.samsonite.de/respark-spinner-79-29-exp-79cm-light-sage/143331-2570.html"],
    content: samsoniteRespark79MaterialsContent,
  },
];

export const publishableGalleryArticles = galleryArticles.filter((article) => !article.releaseBlocker);

export function getGalleryArticle(slug: string): GalleryArticle | undefined {
  return publishableGalleryArticles.find((article) => article.slug === slug);
}
