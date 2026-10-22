import type { ReactNode } from "react";
import { EditorialProductFigure, EditorialProductLink } from "@/components/editorial/EditorialProductReference";
import type { GalleryArticle } from "./gallery-articles";
import stories from "./mandarina-image-stories.json";

// Three comparison articles that replace the twelve single model pages of
// 2026-10-12. The single pages repeated one template and competed with the
// store product pages for the model name; their URLs now redirect here (see
// MANDARINA_HUB_REDIRECTS and next.config.ts). Specs below are the catalog
// figures already verified for those pages; OSV04 uses the manufacturer
// dimensions recorded in the store audit of 2026-10-11.
type Story = (typeof stories)[number];
const bySlug = new Map<string, Story>(stories.map((story) => [story.slug, story]));
function story(slug: string): Story {
  const found = bySlug.get(slug);
  if (!found) throw new Error(`Missing Mandarina story ${slug}`);
  return found;
}

type SpecRow = {
  readonly slug: string;
  readonly model: string;
  readonly type: string;
  readonly size: string;
  readonly weight: string;
  readonly strap: string;
  readonly material: string;
  readonly pockets: string;
};

function SpecTable({ caption, rows }: { caption: string; rows: readonly SpecRow[] }) {
  return (
    <div className="journal-table-scroll" role="region" aria-label={caption} tabIndex={0}>
      <table className="journal-table">
        <caption>{caption}</caption>
        <thead><tr><th scope="col">דגם</th><th scope="col">סוג</th><th scope="col">מידות בס״מ</th><th scope="col">משקל</th><th scope="col">רצועה</th><th scope="col">חומר</th><th scope="col">כיסים</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.slug}><th scope="row" dir="ltr">{row.model}</th><td>{row.type}</td><td dir="ltr">{row.size}</td><td>{row.weight}</td><td>{row.strap}</td><td>{row.material}</td><td>{row.pockets}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ModelFigures({ slugs }: { slugs: readonly string[] }) {
  return <>{slugs.map((slug) => {
    const item = story(slug);
    const product = item.products[0];
    if (!product) return null;
    return <EditorialProductFigure key={slug} image={{ ...item.hero, color: item.hero.color ?? product.color }} href={product.url} />;
  })}</>;
}

function ProductLinks({ slugs }: { slugs: readonly string[] }) {
  return <ul>{slugs.flatMap((slug) => story(slug).products).map((product) => (
    <li key={product.url}><EditorialProductLink href={product.url}>{product.title}</EditorialProductLink></li>
  ))}</ul>;
}

const CITY_ROWS: readonly SpecRow[] = [
  { slug: "mandarina-duck-mellow-leather-fzt46", model: "Mellow Leather FZT46", type: "תיק גב", size: "33 x 25 x 12", weight: "0.6 ק״ג", strap: "93 ס״מ", material: "עור", pockets: "קדמי עם רוכסן, פנימי עם רוכסן, פנימי לטלפון" },
  { slug: "mandarina-duck-md20-qmt39", model: "MD20 QMT39", type: "תיק גב", size: "40 x 30 x 11", weight: "0.5 ק״ג", strap: "91 ס״מ", material: "פוליאסטר", pockets: "שני קדמיים עם רוכסן, פנימי עם רוכסן, פנימי לטלפון" },
  { slug: "mandarina-duck-revival-2-0-oxt03", model: "Revival 2.0 OXT03", type: "תיק כתף", size: "26 x 38 x 12", weight: "0.3 ק״ג", strap: "123 ס״מ", material: "פוליאסטר ממוחזר", pockets: "קדמי עם רוכסן, פנימי עם רוכסן" },
  { slug: "mandarina-duck-mellow-leather-fzt10", model: "Mellow Leather FZT10", type: "תיק צד", size: "25 x 30 x 8", weight: "0.5 ק״ג", strap: "137 ס״מ", material: "עור", pockets: "פנימי עם רוכסן, פנימי לטלפון" },
  { slug: "mandarina-duck-md20-leather-tktv8", model: "MD20 Leather TKTV8", type: "תיק צד", size: "18.5 x 25 x 9", weight: "0.4 ק״ג", strap: "בעמוד המוצר", material: "עור נאפה", pockets: "בעמוד המוצר" },
  { slug: "mandarina-duck-mellow-leather-fzt82", model: "Mellow Leather FZT82", type: "תיק צד", size: "15 x 23 x 9", weight: "0.4 ק״ג", strap: "137 ס״מ", material: "עור", pockets: "בעמוד המוצר" },
  { slug: "mandarina-duck-revival-2-0-oxt01", model: "Revival 2.0 OXT01", type: "תיק צד", size: "16 x 24 x 6", weight: "0.2 ק״ג", strap: "137 ס״מ", material: "פוליאסטר ממוחזר", pockets: "קדמי עם רוכסן, פנימי לטלפון" },
];

const POUCH_ROWS: readonly SpecRow[] = [
  { slug: "mandarina-duck-revival-2-0-oxm04", model: "Revival 2.0 OXM04", type: "נרתיק", size: "11.5 x 21 x 7.5", weight: "0.1 ק״ג", strap: "ללא", material: "פוליאסטר ממוחזר", pockets: "בעמוד המוצר" },
  { slug: "mandarina-duck-md20-qmmo1", model: "MD20 QMMO1", type: "נרתיק שטוח", size: "19 x 28.5 x 4", weight: "0.1 ק״ג", strap: "ללא", material: "פוליאסטר", pockets: "בעמוד המוצר" },
  { slug: "mandarina-duck-eco-coated-osn02", model: "Eco Coated OSN02", type: "תיק רחצה", size: "16.5 x 21.5 x 11.5", weight: "0.3 ק״ג", strap: "ללא", material: "פוליאסטר", pockets: "כיס עם רוכסן" },
];

const TRAVEL_ROWS: readonly SpecRow[] = [
  { slug: "mandarina-duck-eco-coated-osv04", model: "Eco Coated OSV04", type: "מזוודה גדולה רכה", size: "78 x 48 x 27.5, בהרחבה עד 32 בעומק", weight: "3.1 ק״ג", strap: "ללא", material: "בד מצופה", pockets: "שלושה פנימיים עם רוכסן" },
  { slug: "mandarina-duck-revival-2-0-oxb01", model: "Revival 2.0 OXB01", type: "תיק נסיעות", size: "25 x 40 x 20", weight: "0.4 ק״ג", strap: "137 ס״מ", material: "פוליאסטר ממוחזר", pockets: "פנימי עם רוכסן, פנימי לטלפון" },
];

const cityContent: ReactNode = <>
  <p>יום בעיר מתחיל בשאלה פשוטה: כמה דברים יוצאים איתכם מהבית. מחשב קטן ובקבוק מים צריכים תיק גב. טלפון, ארנק ומפתחות מסתדרים בתיק צד קטן. בין שני הקצוות יש תיק כתף, שנשאר צמוד לגוף ונפתח בתנועה אחת.</p>
  <p>ריכזנו כאן שבעה דגמים של Mandarina Duck שנמכרים בחנות TopTik, לפי מידות, משקל, אורך רצועה, חומר וכיסים. כל הנתונים לקוחים ממפרט היצרן.</p>
  <SpecTable caption="שבעה תיקים של Mandarina Duck ליום בעיר" rows={CITY_ROWS} />
  <h2>שני תיקי גב: עור מול פוליאסטר</h2>
  <p>FZT46 מסדרת Mellow Leather עשוי עור, והוא הקומפקטי מבין השניים: 33 על 25 ס״מ, עם כיס קדמי אחד עם רוכסן. QMT39 מסדרת MD20 גדול יותר, 40 על 30 ס״מ, ודווקא קל יותר, 0.5 ק״ג מול 0.6. יש לו שני כיסים קדמיים עם רוכסן, כך שקל להפריד בין המטען לבין המפתחות.</p>
  <p>מי שנושא מחשב קטן, ספר וסוודר ירוויח מהנפח של QMT39. מי שמחפש תיק גב שנראה טוב גם בפגישה, ונושא פחות, יעדיף את העור של FZT46.</p>
  <h2>תיק כתף אחד, לנפח בלי גב</h2>
  <p>OXT03 מסדרת Revival 2.0 הוא התיק הגדול ביותר ברשימה ברוחב, 38 ס״מ, ושוקל רק 0.3 ק״ג. הרצועה באורך 123 ס״מ, והתיק יושב בצד הגוף. הכיס הקדמי עם הרוכסן מתאים לטלפון ולכרטיסים, והתא המרכזי לכל השאר.</p>
  <h2>ארבעה תיקי צד: מהשטוח ועד הקטן ביותר</h2>
  <p>FZT10 הוא תיק הצד הרחב, 30 ס״מ ברוחב ו־8 בעומק, בעור. הוא מתאים למי שרוצה להכניס גם טאבלט קטן או מחברת. TKTV8 מסדרת MD20 Leather עשוי עור נאפה, רך למגע, במידות 18.5 על 25 ס״מ. FZT82 הוא הקומפקטי מבין דגמי העור, 15 על 23 ס״מ, לטלפון, ארנק ומפתחות. OXT01 הוא הקל ביותר ברשימה, 0.2 ק״ג, ועומקו 6 ס״מ בלבד.</p>
  <p>לשלושה מתוך הארבעה רצועה באורך 137 ס״מ, שמאפשרת לשאת אותם באלכסון על הגוף.</p>
  <h2>איך מחליטים</h2>
  <p>הדרך הפשוטה היא להניח על השולחן את מה שאתם באמת נושאים ביום רגיל, ולהשוות למידות בטבלה. אחר כך בוחרים חומר: עור מבקש ניגוב יבש והגנה ממים, ופוליאסטר מתנקה בבד לח. הצבע נבחר אחרון.</p>
  <ModelFigures slugs={CITY_ROWS.map((row) => row.slug)} />
  <h2>לפרטים ולרכישה בחנות TopTik</h2>
  <ProductLinks slugs={CITY_ROWS.map((row) => row.slug)} />
</>;

const pouchContent: ReactNode = <>
  <p>נרתיק טוב הוא מה שמונע מהכבלים, מהכרטיסים ומהאיפור להיעלם בתחתית התיק. שלושת הדגמים כאן של Mandarina Duck שוקלים בין 0.1 ל־0.3 ק״ג, ונבדלים בעיקר בצורה.</p>
  <SpecTable caption="נרתיקים ותיק רחצה של Mandarina Duck" rows={POUCH_ROWS} />
  <h2>נרתיק עמוק או נרתיק שטוח</h2>
  <p>OXM04 מסדרת Revival 2.0 צר ועמוק יחסית, 21 ס״מ באורך ו־7.5 בעומק, והוא מתאים לפריטים בעלי נפח: מטען, עכבר, אוזניות בקופסה. QMMO1 מסדרת MD20 שטוח, 4 ס״מ בעומק בלבד ו־28.5 באורך, ונכנס לתא של תיק גב או תיק מחשב לצד המסמכים.</p>
  <h2>תיק רחצה לנסיעה</h2>
  <p>OSN02 מסדרת Eco Coated הוא היחיד כאן שמיועד לנסיעה: 16.5 על 21.5 ס״מ ועומק של 11.5, עם כיס רוכסן נפרד לפריטים הקטנים. הוא מספיק לשגרה של כמה ימים ונכנס בפינה של מזוודה או טרולי.</p>
  <ModelFigures slugs={POUCH_ROWS.map((row) => row.slug)} />
  <h2>לפרטים ולרכישה בחנות TopTik</h2>
  <ProductLinks slugs={POUCH_ROWS.map((row) => row.slug)} />
</>;

const travelContent: ReactNode = <>
  <p>שני הדגמים כאן של Mandarina Duck עונים על שתי נסיעות שונות. OSV04 היא מזוודה גדולה לבטן המטוס, ו־OXB01 הוא תיק נסיעות קטן שנשאר איתכם בתא הנוסעים.</p>
  <SpecTable caption="מזוודה ותיק נסיעות של Mandarina Duck" rows={TRAVEL_ROWS} />
  <h2>OSV04: מזוודה רכה שגדלה בדרך חזרה</h2>
  <p>OSV04 מסדרת Eco Coated נמדדת 78 על 48 ס״מ, ובעומק 27.5 ס״מ שנפתחים עד 32 ברוכסן ההרחבה. היא שוקלת 3.1 ק״ג ריקה, ולכן נשארים בה כמעט 20 ק״ג מתוך מגבלה של 23 ק״ג. בפנים יש שלושה כיסים עם רוכסן, שמפרידים בין בגדים לבין אביזרים.</p>
  <h2>OXB01: תיק לסוף שבוע</h2>
  <p>OXB01 מסדרת Revival 2.0 נמדד 40 על 25 על 20 ס״מ ושוקל 0.4 ק״ג. לנסיעה קצרה הוא מספיק לבגדים של יומיים או שלושה, ורצועה באורך 137 ס״מ מאפשרת לשאת אותו על הכתף. לפני הטיסה כדאי לבדוק את מידות הפריט האישי של חברת התעופה, כי הן משתנות בין חברה לחברה.</p>
  <ModelFigures slugs={TRAVEL_ROWS.map((row) => row.slug)} />
  <h2>לפרטים ולרכישה בחנות TopTik</h2>
  <ProductLinks slugs={TRAVEL_ROWS.map((row) => row.slug)} />
</>;

const heroOf = (slug: string) => {
  const item = story(slug);
  return { ...item.hero, href: item.products[0]?.url };
};

export const mandarinaHubArticles: readonly GalleryArticle[] = [
  {
    slug: "mandarina-duck-city-bags-compared",
    category: "השוואת דגמים",
    title: "תיקי מנדרינה דאק (Mandarina Duck): השוואת 7 דגמי תיקי גב, כתף וצד ליום בעיר",
    description: "השוואה בין שבעה תיקים של Mandarina Duck ליום בעיר לפי מידות, משקל, אורך רצועה, חומר וכיסים, מתיק הגב FZT46 ועד תיק הצד OXT01.",
    standfirst: "שני תיקי גב, תיק כתף וארבעה תיקי צד, בטבלה אחת ולפי מפרט היצרן, כדי לבחור לפי מה שאתם באמת נושאים.",
    publishedAt: "2026-10-12",
    updatedAt: "2026-10-22",
    readingMinutes: 4,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [],
    hero: heroOf("mandarina-duck-mellow-leather-fzt46"),
    content: cityContent,
  },
  {
    slug: "mandarina-duck-pouches-toiletry-compared",
    category: "השוואת דגמים",
    title: "נרתיקים ותיקי רחצה מנדרינה דאק (Mandarina Duck): השוואת OXM04, QMMO1 ו־OSN02",
    description: "OXM04, QMMO1 ותיק הרחצה OSN02 של Mandarina Duck בהשוואה: מידות, משקל וחומר, ואיזה נרתיק מתאים לכבלים, למסמכים או לנסיעה.",
    standfirst: "שלושה נרתיקים קלים, שנבדלים בצורה: עמוק, שטוח ותיק רחצה לנסיעה.",
    publishedAt: "2026-10-12",
    updatedAt: "2026-10-22",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [],
    hero: heroOf("mandarina-duck-revival-2-0-oxm04"),
    content: pouchContent,
  },
  {
    slug: "mandarina-duck-suitcase-and-weekender",
    category: "השוואת דגמים",
    title: "מזוודה גדולה או תיק נסיעות מנדרינה דאק (Mandarina Duck): השוואת OSV04 ו־OXB01",
    description: "מזוודה גדולה רכה OSV04 ותיק נסיעות OXB01 של Mandarina Duck: מידות, משקל, הרחבה וכיסים, ומתי כל אחד מתאים לנסיעה.",
    standfirst: "מזוודה לבטן המטוס ותיק לתא הנוסעים, עם המספרים שחשוב לבדוק לפני הטיסה.",
    publishedAt: "2026-10-12",
    updatedAt: "2026-10-22",
    readingMinutes: 3,
    byline: "מערכת מגזין TopTik",
    sourceUrls: [],
    hero: heroOf("mandarina-duck-eco-coated-osv04"),
    content: travelContent,
  },
];

export { default as MANDARINA_HUB_REDIRECTS } from "./mandarina-hub-redirects.json";
