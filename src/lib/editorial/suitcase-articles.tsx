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
  publishedAt: "2026-11-03",
  updatedAt: "2026-11-03",
  byline: "מערכת מגזין TopTik",
} as const;

const lightContent: ReactNode = <>
  <p>משקל עצמי הוא נתון יצרן, ולכן ההשוואה כאן מתייחסת לדגמים ולמק״טים שנבדקו בקטלוג. המידה המחייבת של כל מוצר היא בסנטימטרים כפי שמופיעה בעמוד המוצר.</p>
  <Table label="השוואת מזוודות קלות לפי נתוני יצרן" headings={["דגם", "מק״ט", "גודל", "משקל", "חומר"]} rows={[
    ["Samsonite C-Lite", "S209004", "75 ס״מ", "2.8 ק״ג", "Curv"],
    ["Samsonite C-Lite", "S281006", "86 ס״מ", "3.6 ק״ג", "Curv"],
    ["Samsonite Urbify", "KO709005", "55 ס״מ", "2.3 ק״ג", "פוליאסטר ממוחזר"],
    ["Samsonite Urbify", "KO709006", "68 ס״מ", "2.8 ק״ג", "פוליאסטר ממוחזר"],
    ["Samsonite Urbify", "KO709007", "78 ס״מ", "3.2 ק״ג", "פוליאסטר ממוחזר"],
    ["Samsonite Intuo", "KL909001", "55 ס״מ", "2.3 ק״ג", "פוליפרופילן"],
    ["Samsonite Upscape", "KJ109001", "55 ס״מ", "2.3 ק״ג", "פוליפרופילן"],
  ]} />
  <h2>איך לבחור מזוודה קלת משקל</h2>
  <p>השוו תמיד בין המשקל, המידות, הנפח והחומר של אותו מק״ט. מזוודה קלה יותר אינה בהכרח מתאימה יותר לכל נסיעה, וחברת התעופה קובעת את מגבלות הכבודה.</p>
  <ArticleProductCards skus={["S209004", "S281006", "KO709005", "KL909001", "KJ109001"]} />
</>;

const mandarinaContent: ReactNode = <>
  <p>בעמודי המוצרים הפעילים של Mandarina Duck מופיעות מזוודות וטרולי מסדרות Logoduck+, Zephyr ו־Eco Coated. ההשוואה מפרידה בין מעטפת קשיחה לבין מזוודות בד, ומפנה לעמודי הרכישה לפי הדגם הזמין.</p>
  <Table label="השוואת מזוודות מנדרינה דאק" headings={["סדרה", "דגם לדוגמה", "גודל", "מבנה מתועד"]} rows={[
    ["Logoduck+", "SZV24", "55 ס״מ", "מעטפת פוליקרבונט, הרחבה ומנעול TSA"],
    ["Zephyr", "OTV01", "55 ס״מ", "מזוודת בד עם כיסים קדמיים והרחבה"],
    ["Eco Coated", "OSV01", "55 ס״מ", "מזוודת בד עם ארבעה גלגלים וכיסים"],
    ["Eco Coated", "OSV03", "67 ס״מ", "מזוודה בינונית מתרחבת"],
    ["Zephyr", "OTV04", "78 ס״מ", "מזוודה גדולה מתרחבת"],
  ]} />
  <h2>קשיחה או רכה</h2>
  <p>Logoduck+ מציעה מעטפת קשיחה, בעוד Zephyr ו־Eco Coated הן סדרות רכות. המחיר, הצבע והזמינות משתנים לפי מק״ט, ולכן יש לבדוק אותם בעמוד המוצר לפני רכישה.</p>
  <ArticleProductCards skus={["P10SZV2405J", "P10OTV0108Q", "P10OSV0116Q", "P10OSV0316Q", "P10OTV0408Q"]} />
</>;

const matchingSetContent: ReactNode = <>
  <p>אפשר להרכיב זוג או שלישייה מאותה סדרה רק כאשר הדגמים והצבעים זמינים בפועל. המוצרים נמכרים כיחידות נפרדות, ולכן אין לראות בטבלה הצעה לסט ארוז או למחיר משולב.</p>
  <Table label="סדרות עם כמה גדלים" headings={["סדרה", "גדלים שנבדקו", "מה לבדוק לפני רכישה"]} rows={[
    ["Samsonite Intuo", "55, 69 ו־81 ס״מ", "אותו צבע, מק״ט וגודל מדויק"],
    ["Samsonite Urbify", "55, 68 ו־78 ס״מ", "מצב הרחבה ומגבלות כבודה"],
    ["Bric's Taormina", "55, 69, 75 ו־82 ס״מ", "צבע ומידות של כל וריאנט"],
    ["American Tourister Deep Dive", "55, 66 ו־77 ס״מ", "זמינות הדגם והצבע"],
  ]} />
  <h2>איך להרכיב התאמה נכונה</h2>
  <p>התחילו מהגודל הנדרש לנסיעה, בדקו שהסדרה מופיעה בגודל נוסף, ולאחר מכן התאימו צבע ומפרט. לפני ההזמנה יש לבדוק את עמוד המוצר, משום שמחיר וזמינות אינם משותפים לכל הגדלים.</p>
  <ArticleProductCards skus={["KL909001", "KL909002", "KL909004", "KO709005", "KO709006", "KO709007"]} />
</>;

export const suitcaseArticles: readonly GalleryArticle[] = [
  {
    ...common,
    slug: "lightweight-suitcases-brand-comparison",
    category: "השוואת דגמים",
    title: "מזוודות קלות משקל: השוואת דגמים לפי משקל יצרן",
    description: "השוואת מזוודות קלות של סמסונייט לפי משקל, גודל, חומר ומק״ט, עם קישורי רכישה לקטגוריות הרלוונטיות.",
    standfirst: "נתוני משקל יצרן של דגמים נבחרים, בלי להמציא מידות או נפחים.",
    readingMinutes: 4,
    sourceUrls: [`${STORE}/collections/samsonite-c-lite`, `${STORE}/collections/samsonite-urbify`, `${STORE}/collections/מזוודות-סמסונייט`],
    storeCategoryLinks: [link("מזוודות-סמסונייט", "מזוודות סמסונייט"), link("מזוודות-קשיחות", "מזוודות קשיחות"), link("מזוודות-רכות", "מזוודות רכות")],
    content: lightContent,
  },
  {
    ...common,
    slug: "mandarina-duck-suitcases-comparison",
    category: "השוואת דגמים",
    title: "מזוודות מנדרינה דאק: השוואת Logoduck+, Zephyr ו־Eco Coated",
    description: "השוואת מזוודות וטרולי Mandarina Duck לפי סדרה, גודל ומבנה, עם קישור ישיר לרכישה.",
    standfirst: "מזוודות קשיחות ורכות של Mandarina Duck לפי מק״ט ודגם.",
    readingMinutes: 4,
    sourceUrls: [`${STORE}/collections/mandarina-duck`, `${STORE}/collections/מזוודות-מנדרינה-דאק`],
    storeCategoryLinks: [link("מזוודות-מנדרינה-דאק", "מזוודות מנדרינה דאק"), link("mandarina-duck", "כל מוצרי מנדרינה דאק"), link("טרולי-carry-on", "טרולי ומזוודות עלייה למטוס")],
    content: mandarinaContent,
  },
  {
    ...common,
    slug: "matching-suitcase-set-by-size",
    category: "השוואת מידות וארגון",
    title: "הרכבת סט מזוודות תואם בשלושה גדלים",
    description: "איך להרכיב זוג או שלישייה מאותה סדרה לפי גדלים, צבעים ומק״טים, כאשר המוצרים נמכרים כיחידות נפרדות.",
    standfirst: "מיפוי סדרות שמופיעות בכמה גדלים, עם בדיקת רכישה לכל דגם בנפרד.",
    readingMinutes: 3,
    sourceUrls: [`${STORE}/collections/מזוודות`, `${STORE}/collections/מזוודות-וטרולי`],
    storeCategoryLinks: [link("מזוודות", "מזוודות"), link("מזוודות-וטרולי", "כל המזוודות והטרולי"), link("מזוודות-סמסונייט", "מזוודות סמסונייט")],
    content: matchingSetContent,
  },
];
