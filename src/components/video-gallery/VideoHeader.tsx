import Link from "next/link";
import styles from "./VideoGallery.module.css";

const store = "https://www.toptik.co.il";
const groups = [
  { title: "מזוודות וטרולי", links: [["כל המזוודות והטרולי", "/collections/מזוודות-וטרולי"], ["טרולי לעלייה למטוס", "/collections/טרולי-carry-on"], ["מזוודות בינוניות", "/collections/מזוודות-בינוניות"], ["מזוודות גדולות", "/collections/מזוודות-גדולות"], ["מזוודות קשיחות", "/collections/מזוודות-קשיחות"], ["מזוודות רכות", "/collections/מזוודות-רכות"]] },
  { title: "תיקים", links: [["תיקי אופנה", "/collections/fashion-bags"], ["תיקי גב", "/collections/backpacks"], ["תיקי גב למחשב", "/collections/תיקי-גב-למחשב"], ["תיקי נסיעות", "/collections/תיקי-נסיעות"]] },
  { title: "ארנקים ואביזרים", links: [["ארנקים", "/collections/wallets"], ["תיקי רחצה ונרתיקים", "/collections/toiletry-pouches"]] },
  { title: "מותגים", links: [["Mandarina Duck", "/collections/mandarina-duck"], ["Bric’s", "/collections/brics"], ["סמסונייט Samsonite", "/collections/samsonite"], ["מזוודות סמסונייט", "/collections/מזוודות-סמסונייט"], ["תיקי סמסונייט", "/collections/תיקי-סמסונייט"], ["American Tourister", "/collections/american-tourister"]] },
  { title: "שירות ומידע", links: [["סניפים ושעות פתיחה", "/#toptik-footer"], ["משלוחים והחזרות", "/policies/shipping-policy"], ["יצירת קשר", "/pages/contact"], ["מגזין ומדריכי נסיעות", "/blogs/מדריכים"], ["מפת השקילה של הקבוצה", "/pages/מפת-השקילה"], ["אתם בוחרים", "/pages/אתם-בוחרים"]] },
];

export function VideoHeader() {
  return <header className={styles.siteHeader} dir="rtl">
    <a className={styles.announcement} href={`${store}/policies/shipping-policy`}>משלוח חינם לכל הארץ</a>
    <div className={styles.headerRow}>
      <a href={store} className={styles.logo} aria-label="טופ תיק, לדף הבית">
        <b>TOPTIK</b><i>Move in Style. Travel with Purpose.</i>
      </a>
      <div className={styles.quickLinks}><Link href="/carousel">גלריית המוצרים</Link><Link href="/journal">המגזין</Link><a href={store}>לחנות</a></div>
    </div>
    <nav className={styles.mainNav} aria-label="תפריט ראשי">
      {groups.slice(0, 4).map(group => <details key={group.title} className={styles.navGroup} name="video-nav"><summary>{group.title}</summary><div className={styles.navDropdown}>{group.links.map(([label, url]) => <a key={url} href={`${store}${url}`}>{label}</a>)}</div></details>)}
      <a className={styles.navLink} href={`${store}/collections/toptik-promotions`}>מבצעים</a>
      <Link className={styles.navLink} href="/videos" aria-current="page">סרטוני מוצרים</Link>
      <details className={styles.navGroup} name="video-nav"><summary>{groups[4].title}</summary><div className={styles.navDropdown}>{groups[4].links.map(([label, url]) => <a key={url} href={`${store}${url}`}>{label}</a>)}</div></details>
    </nav>
  </header>;
}
