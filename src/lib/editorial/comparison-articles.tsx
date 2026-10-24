import type { ReactNode } from "react";
import { ArticleProductCards } from "@/components/editorial/ArticleProductCards";
import type { GalleryArticle } from "./gallery-articles";
import type { StoreCategoryLink } from "./store-categories";

const STORE = "https://www.toptik.co.il";

const link = (handle: string, title: string): StoreCategoryLink => ({
  title,
  href: `${STORE}/collections/${encodeURIComponent(handle)}`,
});

const Table = ({ label, headings, rows }: { label: string; headings: readonly string[]; rows: readonly (readonly ReactNode[])[] }) => (
  <div className="journal-table-scroll" role="region" aria-label={label} tabIndex={0}>
    <table className="journal-table">
      <thead><tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
      <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => cellIndex === 0 ? <th key={cellIndex} scope="row">{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>
);

const common = {
  publishedAt: "2026-10-22",
  updatedAt: "2026-10-22",
  byline: "מערכת מגזין TopTik",
} as const;

const intuoUpscapeContent = <>
  <p>סדרות Intuo ו־Upscape של סמסונייט (Samsonite) הן שתי סדרות מזוודות קשיחות מרכזיות, העשויות מפוליפרופילן עם אפשרות הרחבה ובטנה פנימית נשלפת הניתנת לשטיפה. ההשוואה מציגה את נתוני היצרן של שתי הסדרות זו לצד זו בדגמי העלייה למטוס בגודל של 55 ס״מ, כולל גרסאות Easy Access עם תא מחשב קדמי, ובדגמים הגדולים בגודל של 81 ס״מ.</p>
  <h2>טבלת השוואת מפרט יצרן: Samsonite Intuo מול Samsonite Upscape</h2>
  <Table label="השוואת Samsonite Intuo מול Upscape" headings={["דגם וגודל", "מק״ט בגלריה", "מידות חיצוניות", "נפח", "משקל", "מאפיינים בולטים"]} rows={[
    ["Intuo בגודל של 55 ס״מ", "KL909001", "55 × 40 × 20 / 23 ס״מ", "39 / 45 ליטר", "2.3 ק״ג", "גלגלים כפולים, מנעול TSA ובטנה נשלפת"],
    ["Upscape בגודל של 55 ס״מ", "KJ109001", "55 × 40 × 20 / 23 ס״מ", "39 / 45 ליטר", "2.3 ק״ג", "גלגלים כפולים בולמי זעזועים ובטנה נשלפת"],
    ["Intuo Easy Access בגודל של 55 ס״מ", "KL909005", "55 × 40 × 23 / 26 ס״מ", "42 / 48 ליטר", "2.8 ק״ג", "תא קדמי למחשב בגודל של 15.6 אינץ׳ ולטאבלט"],
    ["Upscape Easy Access בגודל של 55 ס״מ", "KJ114007", "55 × 40 × 23 / 26 ס״מ", "42 / 48 ליטר", "2.6 ק״ג", "תא קדמי נגיש למחשב וגלגלים בולמי זעזועים"],
    ["Intuo בגודל של 81 ס״מ", "KL909004", "81 × 54 × 34 / 37 ס״מ", "132 / 144 ליטר", "4.1 ק״ג", "ארבעה גדלים וחמישה צבעים בסדרה"],
    ["Upscape בגודל של 81 ס״מ", "KJ17176004", "81 × 54 × 34 / 37 ס״מ", "133 / 145 ליטר", "3.9 ק״ג", "מתלה גלגלים בולם זעזועים ורעש"],
  ]} />
  <h2>מה משותף לשתי הסדרות?</h2>
  <p>שתי הסדרות מיוצרות מפוליפרופילן וכוללות בטנה פנימית עם רוכסן הניתנת לפירוק ולשטיפה ידנית. בדגם הבסיסי בגודל של 55 ס״מ הן מציגות מידות, נפח ומשקל זהים. בשתיהן קיימת גם גרסת Easy Access עם פתח קדמי למחשב נייד בגודל של עד 15.6 אינץ׳ ולטאבלט בגודל של עד 10.5 אינץ׳.</p>
  <h2>ההבדלים המעשיים</h2>
  <p>Intuo זמינה בארבע מידות ובחמישה צבעים תואמים, ולכן מתאימה להרכבת סט באותו גוון. Upscape מוסיפה גלגלים כפולים עם מתלה בולם זעזועים, ובדגם בגודל של 81 ס״מ היא קלה ב־200 גרם ומציעה ליטר נוסף בכל אחד ממצבי הנפח.</p>
  <ArticleProductCards skus={["KL909001", "KJ109001", "KL909005", "KJ114007", "KL909004", "KJ17176004"]} />
</>;

const hardSoftContent = <>
  <p>כאשר משווים בין מזוודה קשיחה למזוודה רכה בתוך קטלוג סמסונייט, שתי הסדרות המקבילות המלאות בגלריה הן Intuo, בעלת מעטפת פוליפרופילן קשיחה, ו־Urbify, בעלת מעטפת בד מפוליאסטר ממוחזר. שתיהן כוללות ארבעה גלגלים כפולים, מנעול TSA ואפשרות הרחבה בכל המידות.</p>
  <h2>טבלת גדלים מקבילים: Intuo מול Urbify</h2>
  <Table label="השוואת Intuo הקשיחה מול Urbify הרכה" headings={["קטגוריית גודל", "דגם ומק״ט", "חומר", "מידות סגור / מורחב", "נפח", "משקל"]} rows={[
    ["טרולי עלייה למטוס", "Intuo 55, KL909001", "פוליפרופילן", "55 × 40 × 20 / 23 ס״מ", "39 / 45 ליטר", "2.3 ק״ג"],
    ["טרולי עלייה למטוס", "Urbify 55, KO709005", "פוליאסטר ממוחזר", "55 × 40 × 23 / 26 ס״מ", "39 / 46 ליטר", "2.3 ק״ג"],
    ["מזוודה בינונית", "Intuo 69, KL909002", "פוליפרופילן", "69 × 48 × 28 / 31 ס״מ", "79 / 87 ליטר", "3.1 ק״ג"],
    ["מזוודה בינונית", "Urbify 68, KO709006", "פוליאסטר ממוחזר", "68 × 43 × 27 / 31 ס״מ", "68 / 76 ליטר", "2.8 ק״ג"],
    ["מזוודה גדולה", "Intuo 75, KL909003", "פוליפרופילן", "75 × 51 × 31 / 34 ס״מ", "105 / 115 ליטר", "3.6 ק״ג"],
    ["מזוודה גדולה", "Urbify 78, KO709007", "פוליאסטר ממוחזר", "78 × 48 × 30 / 34 ס״מ", "107 / 115 ליטר", "3.1 ק״ג"],
    ["מזוודה גדולה מאוד", "Intuo 81, KL909004", "פוליפרופילן", "81 × 54 × 34 / 37 ס״מ", "132 / 144 ליטר", "4.1 ק״ג"],
  ]} />
  <h2>שלושה הבדלים מרכזיים</h2>
  <p><strong>אופן הפתיחה:</strong> Intuo נפתחת באמצע לשני תאים שווים. Urbify נפתחת במבנה של תא עמוק אחד ומכסה קדמי, ולכן דורשת פחות שטח רצפה בעת הפתיחה.</p>
  <p><strong>המשקל העצמי:</strong> בטרולי בגודל של 55 ס״מ שתי הסדרות שוקלות 2.3 ק״ג. בנפח מורחב של 115 ליטר, Urbify בגודל של 78 ס״מ קלה בחצי קילוגרם מ־Intuo בגודל של 75 ס״מ.</p>
  <p><strong>כיסים מול מעטפת:</strong> Urbify כוללת כיס קדמי חיצוני. Intuo שומרת על מבנה קשיח וקבוע.</p>
  <ArticleProductCards skus={["KL909001", "KO709005", "KL909002", "KO709006", "KL909004", "KO709007"]} />
</>;

const largeSuitcasesContent = <>
  <p>בבחירת מזוודה קשיחה גדולה לבטן המטוס, המשקל העצמי של המזוודה הריקה הוא נתון חשוב. בגלריה מוצגות שתי גישות של Samsonite: סדרת C-Lite העשויה מחומר Curv™, פוליפרופילן ארוג, וסדרת Intuo העשויה מפוליפרופילן קשיח עם מנגנון הרחבה.</p>
  <h2>נתוני היצרן בגדלים הגדולים</h2>
  <Table label="השוואת C-Lite מול Intuo בגדלים הגדולים" headings={["דגם וגודל", "מק״ט", "מידות", "נפח", "משקל", "אחריות"]} rows={[
    ["C-Lite בגודל של 75 ס״מ", "S209004", "75 × 51 × 31 ס״מ", "94 ליטר", "2.8 ק״ג", "10 שנים"],
    ["Intuo בגודל של 75 ס״מ", "KL909003", "75 × 51 × 31 / 34 ס״מ", "105 / 115 ליטר", "3.6 ק״ג", "5 שנים"],
    ["C-Lite בגודל של 86 ס״מ", "S281006", "86 × 58 × 36 ס״מ", "144 ליטר", "3.6 ק״ג", "10 שנים"],
    ["Intuo בגודל של 81 ס״מ", "KL909004", "81 × 54 × 34 / 37 ס״מ", "132 / 144 ליטר", "4.1 ק״ג", "5 שנים"],
  ]} />
  <h2>מה אומרים המספרים?</h2>
  <p>בגודל של 75 ס״מ, C-Lite קלה ב־800 גרם מ־Intuo. דגם C-Lite בגודל של 86 ס״מ מציע 144 ליטר במשקל של 3.6 ק״ג, בעוד Intuo בגודל של 81 ס״מ מגיעה ל־144 ליטר לאחר פתיחת ההרחבה ושוקלת 4.1 ק״ג.</p>
  <p>C-Lite בנויה ללא רוכסן הרחבה וכוללת אחריות בינלאומית מוגבלת ל־10 שנים. Intuo מאפשרת להוסיף 10 עד 12 ליטר באמצעות רוכסן ההרחבה וכוללת בטנה נשלפת לשטיפה.</p>
  <ArticleProductCards skus={["S209004", "KL909003", "S281006", "KL909004"]} />
</>;

const laptopBackpacksContent = <>
  <p>בחירת תיק גב למחשב נייד של סמסונייט תלויה בגודל המחשב, במשקל העצמי על הגב ובשאלה אם התיק משמש רק למשרד או גם לנסיעות עבודה. בגלריה זמינות חמש סדרות עסקיות: PRO-DLX 6, Biz2Go, Guardit Classy 2.0, Guardit 3.0 ו־Mysight.</p>
  <h2>מפרט יצרן של תיקי הגב</h2>
  <Table label="השוואת תיקי גב למחשב של Samsonite" headings={["דגם", "מק״ט", "מחשב וטאבלט", "מידות", "נפח", "משקל"]} rows={[
    ["Guardit 3.0", "KR209001 / KR201001", "14.1 ו־10.5 אינץ׳", "40 × 29 × 18 ס״מ", "17.5 ליטר", "0.7 ק״ג"],
    ["Guardit 3.0", "KR209002", "15.6 ו־10.5 אינץ׳", "44 × 30 × 20 ס״מ", "22.5 ליטר", "0.7 ק״ג"],
    ["Mysight", "KF909003 / KF901003", "14.1 ו־10.5 אינץ׳", "40 × 28 × 13.5 ס״מ", "16.5 ליטר", "0.9 ק״ג"],
    ["Guardit Classy 2.0", "KT009004", "15.6 ו־10.5 אינץ׳", "44 × 30 × 20 ס״מ", "22.5 ליטר", "0.7 ק״ג"],
    ["Biz2Go", "KI109005", "15.6 ו־10.5 אינץ׳", "44 × 33 × 20 ס״מ", "22.5 ליטר", "1.1 ק״ג"],
    ["PRO-DLX 6 מתרחב", "KM209003", "15.6 ו־10.5 אינץ׳", "43 × 30 × 15 / 21 ס״מ", "21 / 26 ליטר", "1.3 ק״ג"],
    ["PRO-DLX 6 מתרחב", "KM203009", "17.3 ו־10.5 אינץ׳", "46 × 32 × 18 / 24 ס״מ", "24.5 / 31 ליטר", "1.5 ק״ג"],
  ]} />
  <h2>איך להחליט בין הסדרות?</h2>
  <p><strong>לתיק קל ופשוט לעבודה:</strong> דגמי Guardit 3.0 שוקלים 700 גרם. גרסת 14.1 אינץ׳ מציעה 17.5 ליטר, וגרסת 15.6 אינץ׳ מציעה 22.5 ליטר.</p>
  <p><strong>לתיק קומפקטי עם חיבור USB:</strong> Mysight בגודל של 14.1 אינץ׳ מציע 16.5 ליטר, תא לטאבלט ומערכת Easy Pass להעברת כבלים בין התאים.</p>
  <p><strong>למשקל מינימלי עם קו עיצוב נפרד:</strong> Guardit Classy 2.0 שוקל 700 גרם ומציע נפח של 22.5 ליטר, שני תאים מרכזיים ושרוול להלבשה על ידית טרולי.</p>
  <p><strong>לנסיעות יומיות:</strong> Biz2Go מוסיף יציאת USB, פרטים מחזירי אור, רצועות גב ארגונומיות ושרוול למזוודה.</p>
  <p><strong>לנסיעות עסקים:</strong> PRO-DLX 6 כולל הרחבה, הגנת RFID ויציאת USB. רוכסן ההרחבה מוסיף שישה ס״מ לעומק.</p>
  <ArticleProductCards skus={["KR209001", "KR201001", "KR209002", "KF909003", "KF901003", "KM203009", "KI109005", "KT009004"]} />
</>;

const urbanGrooveBackpacksContent = <>
  <p>סדרת Urban Groove של אמריקן טוריסטר כוללת כמה מבנים של תיקי גב. ההשוואה כאן מתמקדת בשני הדגמים החדשים בגלריה: UG16 לשימוש יום יומי ו־UG25 Tote עם תא למחשב בגודל של עד 15.6 אינץ׳. הנתונים המספריים נלקחו מעמודי המוצר הרשמיים של המותג.</p>
  <h2>Urban Groove UG16 מול UG25 Tote</h2>
  <Table label="השוואת תיקי גב American Tourister Urban Groove" headings={["דגם", "מק״טים בגלריה", "מידות", "נפח", "משקל", "התאמה"]} rows={[
    ["UG16", "24G09048", "36 × 25 × 20 ס״מ", "17 ליטר", "0.4 ק״ג", "תיק גב יום יומי"],
    ["UG25 Tote", "24G09057 / 24G54057 / 24GA4057 / 24G77057", "42.5 × 30.5 × 21 ס״מ", "20.5 ליטר", "0.6 ק״ג", "תא למחשב עד 15.6 אינץ׳"],
  ]} />
  <h2>מה ההבדל בשימוש?</h2>
  <p>UG16 קטן וקל יותר, ולכן מתאים למי שמחפש תיק יום יומי בסיסי. UG25 Tote מוסיף נפח, תא למחשב בגודל של עד 15.6 אינץ׳, כיס לבקבוק ושרוול לחיבור לידית מזוודה. המבנה העליון המתקפל מאפשר לסגור את התיק באבזם.</p>
  <h2>הצבעים הזמינים בגלריה</h2>
  <p>UG16 מופיע בשחור. UG25 Tote מופיע בשחור, ירוק, כחול אבן וכחול כהה. ההבדל בין ארבעת המק״טים הוא הצבע, בעוד המידות, הנפח והמשקל זהים לפי דפי הסדרה.</p>
  <ArticleProductCards skus={["24G09048", "24G09057", "24G54057", "24GA4057", "24G77057"]} />
</>;

const americanTouristerContent = <>
  <p>אמריקן טוריסטר (American Tourister), מותג מקבוצת Samsonite, מיוצג בגלריה בשתי סדרות של מזוודות בד רכות: Deep Dive ו־Nitestream. שתי הסדרות מגיעות בטרולי בגודל של 55 ס״מ, מזוודה בינונית בגודל של 66 ס״מ ומזוודה גדולה בגודל של 77 ס״מ.</p>
  <h2>Deep Dive מול Nitestream</h2>
  <Table label="השוואת American Tourister Deep Dive מול Nitestream" headings={["גודל", "סדרה ומק״ט", "נפח", "משקל", "חומר", "צבעים"]} rows={[
    ["55 ס״מ", "Deep Dive, 2694-55NAVY BLUE", "38 ליטר", "2.4 ק״ג", "פוליאסטר", "נייבי, טורקיז או שחור"],
    ["55 ס״מ", "Nitestream, MJ7014901S", "36 ליטר", "2.3 ק״ג", "פוליאסטר ארוג", "זית וכתום"],
    ["66 ס״מ", "Deep Dive, 1062-66BLACK GRE", "69 / 74 ליטר", "3.33 ק״ג", "פוליאסטר", "שחור, נייבי או טורקיז"],
    ["66 ס״מ", "Nitestream, MJ7014902L", "59 ליטר", "3.0 ק״ג", "פוליאסטר ארוג", "זית וכתום"],
    ["77 ס״מ", "Deep Dive, 2694-77NAVY BLUE", "108 / 118 ליטר", "4.05 ק״ג", "פוליאסטר", "נייבי, שחור או טורקיז"],
    ["77 ס״מ", "Nitestream, MJ7014903", "92 ליטר", "3.5 ק״ג", "פוליאסטר ארוג", "זית וכתום"],
  ]} />
  <h2>ההבדלים המרכזיים</h2>
  <p>Deep Dive מעניקה נפח גדול יותר בשלושת הגדלים ומציעה שלושה שילובי צבעים. Nitestream קלה יותר במשקל העצמי, עם קו עיצוב ירוק־זית והדגשים בכתום.</p>
  <ArticleProductCards skus={["2694-55NAVY BLUE", "MJ7014901S", "1062-66BLACK GRE", "MJ7014902L", "2694-77NAVY BLUE", "MJ7014903"]} />
</>;

const bricsContent = <>
  <p>בית המזוודות האיטלקי בריקס (Bric&apos;s Milano), שנוסד ב־1952, מציג בגלריה שתי קולקציות נסיעה בעלות אופי חומרי שונה: Taormina בעלת מעטפת פוליקרבונט קשיחה עם אפשרות הרחבה, ו־X-Collection העשויה מבד פוליאמיד או ניילון בציפוי PVC ובשילוב פרטי עור.</p>
  <h2>Taormina מול X-Collection</h2>
  <Table label="השוואת Bric's Taormina מול X-Collection" headings={["דגם וגודל", "מק״ט", "חומר", "מידות", "נפח", "משקל"]} rows={[
    ["Taormina טרולי 55", "BAH08451.001", "פוליקרבונט", "55 × 40 × 22 / 26 ס״מ", "42 ליטר", "2.3 ק״ג"],
    ["Taormina 55 עם כיס קדמי", "BAH08450001", "פוליקרבונט", "55 × 40 × 23 / 27 ס״מ", "43 ליטר", "2.8 ק״ג"],
    ["X-Collection טרולי 55", "BXL58117101", "ניילון ופרטי עור", "55 × 36 × 23 ס״מ", "42 ליטר", "2.5 ק״ג"],
    ["Taormina 75", "BAH08453.001", "פוליקרבונט", "75 × 52 × 28 / 32 ס״מ", "לא פורסם", "3.6 ק״ג"],
    ["X-Collection 77", "BXL58145101", "פוליאמיד בציפוי PVC ופרטי עור", "77 × 48 × 26 ס״מ", "לא פורסם", "3.9 ק״ג"],
    ["Taormina 82", "BAH08454.001", "פוליקרבונט", "82 × 57 × 30 / 34 ס״מ", "128 / 135 ליטר", "4.2 ק״ג"],
  ]} />
  <h2>מתי לבחור בכל סדרה?</h2>
  <p>כל דגמי Taormina מתרחבים בארבעה ס״מ. בגודל של 55 ס״מ קיימת בחירה בין טרולי קלאסי לבין גרסה עם תא קדמי נגיש למחשב נייד. X-Collection מתאימה למי שמעדיף שני כיסים חיצוניים ורוצה לשלב מזוודה עם תיק פיילוט, תיק גב או תיק יד מאותה קולקציה.</p>
  <ArticleProductCards skus={["BAH08451.001", "BAH08450001", "BXL58117.101", "BAH08453.001", "BXL58145.101", "BAH08454.001"]} />
</>;

const mandarinaTrolleysContent = <>
  <p>בקטגוריית הטרולי לעלייה למטוס של מנדרינה דאק, הקטלוג מתחלק לארבע סדרות: Logoduck+ הקשיחה, Zephyr הרכה והקלה, Eco Coated מבד בציפוי מגן, ו־Smile & Go המשלבת טרולי דו־גלגלי עם רצועות תרמיל גב.</p>
  <h2>השוואת דגמי הטרולי</h2>
  <Table label="השוואת טרולי Mandarina Duck" headings={["סדרה", "מק״ט", "מבנה", "מידות", "משקל", "חומר"]} rows={[
    ["Logoduck+ / Metal", "P10OUV24-A89-TU / P10SZV24-05J-TU", "קשיח, מתרחב, ארבעה גלגלים כפולים", "55 × 40 × 20 ס״מ", "2.4 ק״ג", "פוליקרבונט"],
    ["Zephyr OTV01", "P10OTV01651", "רך, ארבעה גלגלים כפולים", "55 × 40 × 20 ס״מ", "2.2 ק״ג", "בד סינתטי"],
    ["Eco Coated OSV01", "P10OSV0116Q", "רך, ארבעה גלגלים", "55 × 40 × 20 ס״מ", "2.4 ק״ג", "בד ממוחזר בציפוי"],
    ["Smile & Go JNV05", "P10JNV05465", "טרולי ותרמיל גב", "מידת קבינה", "לא פורסם", "פוליאסטר"],
  ]} />
  <h2>התאמה לפי סגנון הנסיעה</h2>
  <p>Logoduck+ מציעה מעטפת קשיחה והרחבה. Zephyr היא הקלה ביותר מבין הדגמים המושווים וכוללת כיסים חיצוניים. Eco Coated מוסיפה בד ממוחזר בציפוי עמיד במים. Smile & Go מיועדת למעבר בין גרירה לנשיאה על הגב.</p>
  <ArticleProductCards skus={["P10OUV24-A89-TU", "P10SZV24-05J-TU", "P10OTV01651", "P10OSV0116Q", "P10JNV05465"]} />
</>;

const md20Content = <>
  <p>סדרת MD20 מזוהה עם מנדרינה דאק בזכות הלוגו התלת־ממדי וחלוקת הכיסים. בגלריה מופיעה הקולקציה בשלוש מהדורות חומר השומרות על גזרות מבוקשות של תיקי צד ותיקי גב: MD20 הקלאסית, MD20 Leather ו־MD20 Lux 2.0.</p>
  <h2>שלוש מהדורות MD20</h2>
  <Table label="השוואת מהדורות MD20" headings={["תת־סדרה", "חומר וגימור", "דגמי תיקי גב", "תיקי צד", "גוונים"]} rows={[
    ["MD20", "בד Mitrix סינתטי קל", "QMT39, QMT71, QMTZ4", "QMTX5, QMT58, QMTV8", "שחור, פלדה, טאופ, ענבר, בורדו ועוד"],
    ["MD20 Leather", "עור במרקם טבעי", "TKTZ4", "TKTV8, TKT34", "שחור וטאופ חם"],
    ["MD20 Lux 2.0", "בד בגימור מבריק ומתכתי", "UYT39, UYTT1, UYTZ4", "UYTX5, UYTV1, UYTV8", "כסוף וחום עמוק"],
  ]} />
  <h2>איך להתאים את הדגם המדויק?</h2>
  <p>הסיומת של דגם המשפחה מסמנת גזרה מקבילה. כך, גזרת תיק הגב 39 קיימת ב־MD20 וב־Lux 2.0, וגזרת Z4 קיימת בשלוש המהדורות. גם גזרת תיק הצד V8 קיימת בבד, בעור וב־Lux 2.0.</p>
  <p>בסדרת MD20 הקלאסית אפשר להשלים את התיק בנרתיק ארגון, תיק רחצה או פאוץ׳ בגוונים תואמים.</p>
  <ArticleProductCards skus={["P10QMT3901V", "P10QMTX501V", "P10QMT5809K", "P10TKTV8001", "P10TKTZ4001", "P10UYT39466", "P10UYTX5466"]} />
</>;

const mandarinaBagsContent = <>
  <p>מעבר לסדרת MD20, קטלוג התיקים של מנדרינה דאק כולל שלוש סדרות מרכזיות: Mellow Leather, קולקציית עור רך, Revival 2.0, קולקציית בד קלה וגמישה לעיר ולנסיעה, ו־Daisy, סדרת תיקי צד בקו נקי.</p>
  <h2>השוואת הסדרות</h2>
  <Table label="השוואת Mellow Leather, Revival 2.0 ו-Daisy" headings={["סדרה", "חומר", "סוגי פריטים", "דגמים", "מאפיין עיקרי"]} rows={[
    ["Mellow Leather", "עור רך במרקם מגורען", "תיקי צד, כתף, גב, פאוצ׳ים וארנקים", "FZT46, FZT12, FZT82, FZP61", "מבחר רחב של גזרות וגוונים"],
    ["Revival 2.0", "בד קל וגמיש", "תיקי צד, יד, גב, נרתיקים ותיקי נסיעות", "OXT01, OXT03, OXT08, OXB01", "משקל נמוך ופריטים תואמים לנסיעה"],
    ["Daisy", "בד סינתטי", "תיקי צד וקרוסבודי", "UKT01, UKT03, UKT04, UKT07", "קו מינימליסטי בשחור ובטאופ"],
  ]} />
  <h2>בחירה מהירה</h2>
  <p>Mellow Leather מציעה תיקי עבודה, כתף וגב לצד ארנקים ופאוצ׳ים תואמים. Revival 2.0 זמינה בחמישה צבעים ומאפשרת לשלב תיק יומיומי עם נרתיקים ותיק סוף שבוע. Daisy מיועדת למי שמחפש תיק צד בקו נקי ומינימליסטי.</p>
  <ArticleProductCards skus={["P10FZT46A28", "P10FZT12A28", "P10FZT82001", "P10FZP61A28", "P10OXT01001", "P10OXT03001", "P10OXT08001", "P10UKT01001"]} />
</>;

const travelBagsContent = <>
  <p>לא כל נסיעה קצרה או טיסת עבודה מחייבת טרולי קשיח. לעיתים עדיף תיק שנכנס מתחת למושב, תיק פיילוט עסקי על גלגלים שמפריד בין המחשב לבגדים, או תיק סוף שבוע גמיש שמתלבש על ידית המזוודה.</p>
  <h2>השוואת תיקי נסיעות ותיקים על גלגלים</h2>
  <Table label="השוואת תיקי נסיעות ועבודה" headings={["דגם", "מותג וסדרה", "מק״ט", "נשיאה", "חומר", "שימוש"]} rows={[
    ["תיק נסיעות בשלוש דרכי נשיאה", "Samsonite Urbify", "סדרת Urbify", "יד, כתף או גב, ושרוול לטרולי", "פוליאסטר ממוחזר", "תיק אישי מתחת למושב, בכפוף לתנאי החברה"],
    ["תיק פיילוט על גלגלים", "Bric's X-Collection", "BXL38124101", "גלגלים, ידית טלסקופית וידיות עליונות", "פוליאמיד בציפוי PVC ופרטי עור", "נסיעת עבודה קצרה"],
    ["תיק גב על גלגלים OSV06", "Mandarina Duck Eco Coated", "P10OSV06651", "גרירה או נשיאה על הגב", "בד ממוחזר בציפוי", "מעבר בין שדה התעופה להליכה עירונית"],
    ["תיק מנשא OST02", "Mandarina Duck Eco Coated", "P10OST02651", "ידית, רצועת כתף ושרוול לטרולי", "בד ממוחזר בציפוי", "תיק קבינה משלים"],
    ["תיק סוף שבוע OXB01", "Mandarina Duck Revival 2.0", "משפחת P10OXB01", "יד, כתף ושרוול לידית מזוודה", "בד קל וגמיש", "חופשת סוף שבוע או תא נוסעים"],
  ]} />
  <h2>איך לבחור?</h2>
  <p>Urbify מתאים למי שמעדיף שלוש דרכי נשיאה. תיק הפיילוט BXL38124 מפריד בין תא מחשב ומסמכים לבין תא בגדים. OSV06 עובר מגרירה לנשיאה על הגב. OST02 ו־OXB01 הם פתרונות גמישים שמתחברים לידית המזוודה.</p>
  <ArticleProductCards skus={["BXL38124101", "P10OSV06651", "P10OST02651", "P10OXB01001", "P10OXB0129O", "P10OXB01645", "P10OXB01A96", "P10OXB01B11"]} />
</>;

export const comparisonArticles: readonly GalleryArticle[] = [
  {
    ...common,
    slug: "samsonite-intuo-vs-upscape-hard-suitcases",
    category: "השוואת דגמים",
    title: "מזוודות סמסונייט Intuo מול Upscape: השוואת דגמים קשיחים בגודל של 55 ו־81 ס״מ",
    description: "השוואה בין סדרות המזוודות הקשיחות Samsonite Intuo ו־Upscape מפוליפרופילן: מידות, נפח בליטרים, משקל, גלגלים וגרסאות Easy Access בגודל של 55 ו־81 ס״מ.",
    standfirst: "נתוני היצרן של Intuo ו־Upscape זה לצד זה, מטרולי עלייה למטוס ועד מזוודה גדולה בגודל של 81 ס״מ.",
    readingMinutes: 4,
    hero: { src: `${STORE}/cdn/shop/files/01-868538ee7e64.jpg?v=1788460841&width=1200`, alt: "מזוודת טרולי קשיחה סמסונייט Upscape בגודל של 55 ס״מ בצבע שחור", width: 1200, height: 1200, caption: "Samsonite Upscape בגודל של 55 ס״מ" },
    sourceUrls: [`${STORE}/collections/samsonite-intuo`, `${STORE}/collections/samsonite-upscape`],
    storeCategoryLinks: [link("samsonite", "מזוודות סמסונייט"), link("מזוודות-קשיחות", "מזוודות קשיחות"), link("samsonite-intuo", "סדרת Samsonite Intuo"), link("samsonite-upscape", "סדרת Samsonite Upscape")],
    content: intuoUpscapeContent,
  },
  {
    ...common,
    slug: "samsonite-hard-vs-soft-intuo-vs-urbify",
    category: "השוואת דגמים",
    title: "מזוודה קשיחה או רכה של סמסונייט: השוואת Samsonite Intuo מול Urbify",
    description: "מתלבטים בין מזוודה קשיחה למזוודת בד של סמסונייט? השוואת Samsonite Intuo מפוליפרופילן מול Urbify מפוליאסטר ממוחזר לפי מידות, נפח ומשקל בכל הגדלים.",
    standfirst: "השוואה בין מעטפת קשיחה למעטפת בד, לפי מידות, נפח, משקל ואופן הפתיחה בכל גודל.",
    readingMinutes: 4,
    hero: { src: `${STORE}/cdn/shop/files/01-432f62498d3c.jpg?v=1787391235&width=1200`, alt: "השוואת מזוודות סמסונייט קשיחות מסדרת Intuo ומזוודות רכות מסדרת Urbify", width: 1200, height: 1200, caption: "Samsonite Intuo הקשיחה מול Urbify הרכה" },
    sourceUrls: [`${STORE}/collections/samsonite-intuo`, `${STORE}/collections/samsonite-urbify`],
    storeCategoryLinks: [link("מזוודות-קשיחות", "מזוודות קשיחות"), link("מזוודות-רכות", "מזוודות רכות"), link("samsonite-intuo", "סדרת Samsonite Intuo"), link("samsonite-urbify", "סדרת Samsonite Urbify")],
    content: hardSoftContent,
  },
  {
    ...common,
    slug: "samsonite-c-lite-curv-vs-intuo-large-suitcases",
    category: "השוואת מידות וארגון",
    title: "מזוודות גדולות של סמסונייט: השוואת C-Lite מחומר Curv מול Intuo בגודל של 75 ו־81 ס״מ",
    description: "השוואת מזוודות גדולות Samsonite C-Lite מחומר Curv מול Samsonite Intuo מפוליפרופילן: פערי משקל, נפח בליטרים ואחריות בגודל של 75 עד 86 ס״מ.",
    standfirst: "C-Lite הקלה מול Intuo המתרחבת, עם נתוני משקל, נפח, חומר ואחריות בגדלים הגדולים.",
    readingMinutes: 3,
    hero: { src: `${STORE}/cdn/shop/files/01-ed7a6e3065b6.jpg?v=1787390986&width=1200`, alt: "מזוודה קשיחה גדולה Samsonite C-Lite מחומר Curv לצד Samsonite Intuo", width: 1200, height: 1200, caption: "Samsonite C-Lite לצד Samsonite Intuo" },
    sourceUrls: [`${STORE}/collections/samsonite-c-lite`, `${STORE}/collections/samsonite-intuo`],
    storeCategoryLinks: [link("מזוודות-גדולות", "מזוודות גדולות"), link("samsonite-c-lite", "סדרת Samsonite C-Lite"), link("samsonite-intuo", "סדרת Samsonite Intuo"), link("מזוודות-קשיחות", "מזוודות קשיחות")],
    content: largeSuitcasesContent,
  },
  {
    ...common,
    slug: "samsonite-laptop-backpacks-pro-dlx-6-vs-biz2go-vs-guardit",
    category: "תיקים ליום יום ולעבודה",
    title: "תיקי גב למחשב נייד סמסונייט: השוואת Guardit 3.0, Mysight, Biz2Go ו־PRO-DLX 6",
    description: "השוואת תיקי גב למחשב של סמסונייט בגודל של 14.1, 15.6 ו־17.3 אינץ׳: Guardit 3.0, Mysight, Guardit Classy 2.0, Biz2Go ו־PRO-DLX 6 לפי מידות, נפח ומשקל.",
    standfirst: "חמש סדרות עסקיות של Samsonite בהשוואת גודל מחשב, מידות, נפח, משקל ואבזור.",
    readingMinutes: 5,
    hero: { src: `${STORE}/cdn/shop/files/KM203009-front.jpg?v=1790926266&width=1200`, alt: "תיקי גב למחשב נייד של סמסונייט מסדרות PRO-DLX 6, Biz2Go, Guardit ו־Mysight", width: 1200, height: 1200, caption: "תיקי גב למחשב של Samsonite" },
    sourceUrls: [
      "https://www.samsonite.az/en/products/guardit-30-laptbackpack-m-156-100641",
      "https://www.samsonite.az/en/products/mysight-lpt-backpack-141",
      `${STORE}/collections/samsonite-pro-dlx-6`,
      `${STORE}/collections/samsonite-biz2go`,
      `${STORE}/collections/samsonite-guardit-classy-2-0`,
    ],
    storeCategoryLinks: [link("תיקי-גב-למחשב", "תיקי גב למחשב"), link("samsonite-guardit-3-0", "סדרת Samsonite Guardit 3.0"), link("samsonite-mysight", "סדרת Samsonite Mysight"), link("samsonite", "כל מוצרי סמסונייט")],
    content: laptopBackpacksContent,
  },
  {
    ...common,
    slug: "american-tourister-urban-groove-ug16-vs-ug25-backpacks",
    category: "תיקים ליום יום ולעבודה",
    title: "תיקי גב אמריקן טוריסטר Urban Groove: השוואת UG16 מול UG25 Tote",
    description: "השוואת תיקי הגב American Tourister Urban Groove UG16 ו־UG25 Tote לפי מידות, נפח, משקל, תא מחשב וצבעים, עם קישורים לחמשת הדגמים בגלריה ובחנות.",
    standfirst: "UG16 הקל לשימוש יום יומי מול UG25 Tote עם תא למחשב בגודל של עד 15.6 אינץ׳, בארבעה צבעים.",
    readingMinutes: 3,
    hero: { src: `${STORE}/cdn/shop/files/24G09057.webp?v=1792839461&width=1200`, alt: "תיק גב למחשב American Tourister Urban Groove UG25 Tote בצבע שחור", width: 1200, height: 1200, caption: "American Tourister Urban Groove UG25 Tote" },
    sourceUrls: [
      "https://www.samsonite.az/en/products/urban-groove-ug16-backpack-city",
      "https://samsonite.ua/urban-groove-ryukzak-dlya-noutbuka-156-24g09057",
    ],
    storeCategoryLinks: [link("american-tourister", "אמריקן טוריסטר American Tourister"), link("american-tourister-urban-groove", "סדרת American Tourister Urban Groove"), link("תיקי-גב-למחשב", "תיקי גב למחשב"), link("backpacks", "תיקי גב")],
    content: urbanGrooveBackpacksContent,
  },
  {
    ...common,
    slug: "american-tourister-deep-dive-vs-nitestream-soft-luggage",
    category: "השוואת דגמים",
    title: "מזוודות אמריקן טוריסטר Deep Dive מול Nitestream: השוואת טרולי, בינונית וגדולה",
    description: "השוואה מלאה בין שתי סדרות המזוודות הרכות של American Tourister מבית סמסונייט: Deep Dive מול Nitestream בגודל של 55, 66 ו־77 ס״מ לפי נפח, משקל וצבעים.",
    standfirst: "שתי סדרות רכות בשלושה גדלים, עם השוואת נפח, משקל וחומר לפי נתוני היצרן.",
    readingMinutes: 3,
    hero: { src: `${STORE}/cdn/shop/files/01-3bcc1eeda99e.jpg?v=1787390815&width=1200`, alt: "מזוודות רכות אמריקן טוריסטר American Tourister מסדרות Deep Dive ו־Nitestream", width: 1200, height: 1200, caption: "American Tourister Deep Dive ו־Nitestream" },
    sourceUrls: [`${STORE}/collections/american-tourister-deep-dive`, `${STORE}/collections/american-tourister-nitestream`],
    storeCategoryLinks: [link("american-tourister", "אמריקן טוריסטר American Tourister"), link("american-tourister-deep-dive", "סדרת American Tourister Deep Dive"), link("american-tourister-nitestream", "סדרת American Tourister Nitestream"), link("מזוודות-רכות", "מזוודות רכות")],
    content: americanTouristerContent,
  },
  {
    ...common,
    slug: "brics-taormina-vs-x-collection-hard-and-soft-luggage",
    category: "השוואת דגמים",
    title: "מזוודות וטרולי בריקס (Bric's): השוואת Taormina הקשיחה מול X-Collection הרכה",
    description: "השוואה בין שתי סדרות המזוודות של בית העיצוב האיטלקי Bric's: סדרת Taormina הקשיחה מפוליקרבונט מול X-Collection הרכה בגודל של 55 עד 82 ס״מ.",
    standfirst: "Taormina הקשיחה מול X-Collection הרכה, מהטרולי בגודל של 55 ס״מ ועד מזוודה גדולה בגודל של 82 ס״מ.",
    readingMinutes: 4,
    hero: { src: `${STORE}/cdn/shop/files/bah08454078-front.jpg?v=1791050091&width=1200`, alt: "מזוודות בריקס Bric's Taormina בירוק זית לצד קולקציית X-Collection", width: 1200, height: 1200, caption: "Bric's Taormina ו־X-Collection" },
    sourceUrls: [`${STORE}/collections/brics-taormina`, `${STORE}/collections/brics-x-collection`],
    storeCategoryLinks: [link("brics", "כל מוצרי בריקס Bric's"), link("brics-taormina", "סדרת Bric's Taormina"), link("brics-x-collection", "סדרת Bric's X-Collection"), link("מזוודות-קשיחות", "מזוודות קשיחות")],
    content: bricsContent,
  },
  {
    ...common,
    slug: "mandarina-duck-trolleys-logoduck-vs-zephyr-vs-eco-coated",
    category: "השוואת דגמים",
    title: "טרולי מנדרינה דאק (Mandarina Duck) לעלייה למטוס: Logoduck+, Zephyr, Eco Coated ו־Smile & Go",
    description: "השוואת דגמי הטרולי של Mandarina Duck לעלייה למטוס בגודל של 55 ס״מ: Logoduck+ הקשיח, Zephyr ו־Eco Coated הרכים, ודגם Smile & Go המשלב טרולי ותרמיל גב.",
    standfirst: "ארבע סדרות טרולי של Mandarina Duck, עם השוואת חומר, משקל ואופן נשיאה.",
    readingMinutes: 4,
    hero: { src: `${STORE}/cdn/shop/files/P10OTV01651-01.jpg?v=1790853604&width=1200`, alt: "טרולי מנדרינה דאק Mandarina Duck לעלייה למטוס בגודל של 55 ס״מ", width: 1200, height: 1200, caption: "טרולי Mandarina Duck לעלייה למטוס" },
    sourceUrls: [`${STORE}/collections/mandarina-duck-logoduck`, `${STORE}/collections/mandarina-duck-zephyr`, `${STORE}/collections/mandarina-duck-eco-coated`],
    storeCategoryLinks: [link("mandarina-duck", "כל מוצרי מנדרינה דאק Mandarina Duck"), link("טרולי-carry-on", "טרולי לעלייה למטוס"), link("mandarina-duck-zephyr", "סדרת Mandarina Duck Zephyr"), link("mandarina-duck-logoduck", "סדרת Mandarina Duck Logoduck+")],
    content: mandarinaTrolleysContent,
  },
  {
    ...common,
    slug: "mandarina-duck-md20-vs-md20-leather-vs-md20-lux-bags",
    category: "תיקים ליום יום ולעבודה",
    title: "תיקי מנדרינה דאק מסדרת MD20: השוואת בד MD20 מול MD20 Leather ו־MD20 Lux 2.0",
    description: "השוואה בין שלוש גרסאות סדרת MD20 של Mandarina Duck: בד ה־Mitrix הקל, גרסת העור MD20 Leather וגרסת MD20 Lux 2.0 בתיקי גב, תיקי צד ונרתיקים.",
    standfirst: "אותן גזרות מבוקשות בשלוש מהדורות חומר וגימור שונות של משפחת MD20.",
    readingMinutes: 4,
    hero: { src: "https://cdn.shopify.com/s/files/1/0622/8082/7130/files/P10QMT3901V-01.jpg?v=1790851433", alt: "תיקי גב ותיקי צד מנדרינה דאק Mandarina Duck מסדרת MD20", width: 1200, height: 1200, caption: "משפחת תיקי Mandarina Duck MD20" },
    sourceUrls: [`${STORE}/collections/mandarina-duck-md20`, `${STORE}/collections/mandarina-duck-md20-leather`, `${STORE}/collections/mandarina-duck-md20-lux-2-0`],
    storeCategoryLinks: [link("mandarina-duck-md20", "סדרת Mandarina Duck MD20"), link("mandarina-duck-md20-leather", "סדרת Mandarina Duck MD20 Leather"), link("mandarina-duck-md20-lux-2-0", "סדרת Mandarina Duck MD20 Lux 2.0"), link("fashion-bags", "תיקי צד ותיקי כתף")],
    content: md20Content,
  },
  {
    ...common,
    slug: "mandarina-duck-mellow-leather-vs-revival-vs-daisy-bags",
    category: "תיקים ליום יום ולעבודה",
    title: "תיקי צד ותיקי גב מנדרינה דאק: השוואת Mellow Leather מעור מול Revival 2.0 ו־Daisy",
    description: "איך לבחור תיק של Mandarina Duck ליום יום? השוואת סדרת העור הרך Mellow Leather מול סדרת Revival 2.0 הקלה לנסיעות וסדרת תיקי הצד Daisy לפי חומר ושימוש.",
    standfirst: "שלוש משפחות תיקים של Mandarina Duck, מעור רך ועד בד קל וגמיש ליום יום ולנסיעות.",
    readingMinutes: 4,
    hero: { src: `${STORE}/cdn/shop/files/P10FZP61B09-01.jpg?v=1790852586&width=1200`, alt: "קולקציית Mandarina Duck Mellow Leather לצד סדרות Revival 2.0 ו־Daisy", width: 1200, height: 1200, caption: "Mellow Leather, Revival 2.0 ו־Daisy" },
    sourceUrls: [`${STORE}/collections/mandarina-duck-mellow-leather`, `${STORE}/collections/mandarina-duck-revival-2-0`, `${STORE}/collections/mandarina-duck-daisy`],
    storeCategoryLinks: [link("mandarina-duck-mellow-leather", "סדרת Mandarina Duck Mellow Leather"), link("mandarina-duck-revival-2-0", "סדרת Mandarina Duck Revival 2.0"), link("mandarina-duck-daisy", "סדרת Mandarina Duck Daisy"), link("wallets", "ארנקי עור")],
    content: mandarinaBagsContent,
  },
  {
    ...common,
    slug: "underseat-and-wheeled-business-bags-urbify-vs-brics-vs-eco-coated",
    category: "תיקים ליום יום ולעבודה",
    title: "תיקי נסיעות, תיק פיילוט ותיק גב על גלגלים: השוואת סמסונייט Urbify, בריקס X-Collection ומנדרינה דאק",
    description: "מחפשים תיק נסיעות לתא הנוסעים או תיק פיילוט על גלגלים? השוואת תיק בשלוש דרכים Samsonite Urbify, תיק פיילוט Bric's X-Collection ותיקי Mandarina Duck.",
    standfirst: "פתרונות לנסיעה קצרה ולעבודה, מתיק אישי מתחת למושב ועד תיק פיילוט ותיק גב על גלגלים.",
    readingMinutes: 4,
    hero: { src: `${STORE}/cdn/shop/files/P10OXB01001-01.jpg?width=1200`, alt: "תיקי נסיעות, תיקי פיילוט ותיקי גב על גלגלים של סמסונייט, בריקס ומנדרינה דאק", width: 1200, height: 1200, caption: "תיקי נסיעות ועבודה של Samsonite, Bric's ו־Mandarina Duck" },
    sourceUrls: [`${STORE}/collections/תיקי-נסיעות`, `${STORE}/collections/brics-x-collection`, `${STORE}/collections/mandarina-duck-eco-coated`, `${STORE}/collections/mandarina-duck-revival-2-0`],
    storeCategoryLinks: [link("תיקי-נסיעות", "תיקי נסיעות"), link("samsonite-urbify", "סדרת Samsonite Urbify"), link("brics-x-collection", "סדרת Bric's X-Collection"), link("mandarina-duck-eco-coated", "סדרת Mandarina Duck Eco Coated")],
    content: travelBagsContent,
  },
];
