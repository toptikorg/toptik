"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useEffect } from "react";
import catalogButton from "../../images/cataloge_bottun.svg";
import { InfoMenu } from "@/components/InfoMenu";

const catalogButtonUrl = typeof catalogButton === "string" ? catalogButton : catalogButton.src;

const navItems = [
  { href: "https://www.toptik.co.il/collections/מזוודות-וטרולי", label: "מזוודות" },
  { href: "https://www.toptik.co.il/collections/טרולי-carry-on", label: "טרולי לעלייה למטוס" },
  { href: "https://www.toptik.co.il/collections/fashion-bags", label: "תיקי אופנה" },
  { href: "https://www.toptik.co.il/collections/backpacks", label: "תיקי גב" },
  { href: "https://www.toptik.co.il/collections/תיקי-גב-למחשב", label: "תיקים למחשב" },
  { href: "https://www.toptik.co.il/collections/תיקי-נסיעות", label: "תיקי נסיעות" },
  { href: "https://www.toptik.co.il/collections/wallets", label: "ארנקים" },
  { href: "https://www.toptik.co.il/collections/toiletry-pouches", label: "תיקי רחצה ונרתיקים" },
  { href: "https://www.toptik.co.il/collections/toptik-promotions", label: "מבצעים" },
];

const categories = [
  {
    label: "עיצוב איטלקי",
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-7h6v7M9 9V7M12 9V6M15 9V7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "פונקציונליות חכמה",
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "חומרי גלם איכותיים",
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M6 3l-4 6 10 12L22 9l-4-6H6z M11 3 L8 9 L12 21 L16 9 L13 3 M2 9h20" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    ),
  },
];


type MobileLayerProps = {
  isCarouselEnabled?: boolean;
};

export default function MobileLayer({ isCarouselEnabled = true }: MobileLayerProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    // Safety cleanup: remove old runtime class that caused hero jump on Android.
    document.documentElement.classList.remove("is-android");
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  return (
    <div className="m-layer">
      {/* Top bar */}
      <header className="m-topbar">
        <div className="m-brand">
          <div className="m-title">TOPTIK COLLECTION</div>
          <div className="m-slogan">Move in Style.</div>
        </div>
        <div className="m-topbar-actions">
          <span className="m-wa-label">צ&#39;וטטו עימנו</span>
          <a
            className="m-wa-icon"
            href="https://wa.me/"
            target="_blank"
            rel="noopener"
            aria-label="דברו איתנו בוואטסאפ"
          >
            <span className="m-wa-badge" aria-hidden>
              <Image
                src="/whatsapp.png"
                alt="WhatsApp"
                width={96}
                height={96}
              />
            </span>
          </a>
          <button
            className="m-burger"
            aria-label={open ? "סגור תפריט" : "פתח תפריט"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className={`m-burger-icon ${open ? "is-open" : ""}`} />
            <span className="m-burger-text">תפריט</span>
          </button>
        </div>
      </header>

      {isCarouselEnabled && (
        <Link
          className="m-catalog-btn catalog-svg-btn"
          href="/carousel"
          aria-label="כניסה לגלריה"
          style={{ backgroundImage: `url(${catalogButtonUrl})` }}
        >
          <span className="catalog-svg-btn-text">כניסה לגלריה</span>
        </Link>
      )}

      {/* Slide-down menu */}
      <div className={`m-menu ${open ? "is-open" : ""}`} aria-hidden={!open} inert={!open}>
        <nav dir="rtl" aria-label="תפריט ראשי">
          <h2 className="m-menu-heading">גלריית המוצרים</h2>
          {isCarouselEnabled && <Link href="/carousel" onClick={() => setOpen(false)}>כניסה לגלריית המוצרים</Link>}
          <h2 className="m-menu-heading">קנייה בחנות לפי סוג מוצר</h2>
          {navItems.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
              {item.label}
            </a>
          ))}
          <h2 className="m-menu-heading">מגזין ושירות</h2>
          <Link href="/journal" onClick={() => setOpen(false)}>מגזין ומדריכי נסיעות</Link>
          <InfoMenu variant="mobile" ids={["stores"]} onItemSelect={() => setOpen(false)} />
          <Link href="/accessibility" onClick={() => setOpen(false)}>הצהרת נגישות</Link>
          <h2 className="m-menu-heading">על טופ תיק והמותגים</h2>
          <InfoMenu variant="mobile" ids={["about", "aboutMandarina", "aboutBrics"]} onItemSelect={() => setOpen(false)} />
          <h2 className="m-menu-heading">מידע נוסף</h2>
          <InfoMenu variant="mobile" ids={["terms", "privacy", "accessibility"]} onItemSelect={() => setOpen(false)} />
        </nav>
      </div>

      {/* Bottom bar — Figma 3-tier responsive (320/375/414). Logos sourced as exact SVG exports per tier. */}
      <div className="m-bottombar" dir="rtl">
        <picture className="m-bb-toptik-pic">
          <source media="(min-width: 414px)" srcSet="/bb-logos/toptik-414.svg" />
          <source media="(min-width: 375px)" srcSet="/bb-logos/toptik-375.svg" />
          <img src="/bb-logos/toptik-320.svg" alt="TopTik" className="m-bb-toptik-img" />
        </picture>
        <picture className="m-bb-mandarina-pic">
          <source media="(min-width: 414px)" srcSet="/bb-logos/mandarina-414.svg" />
          <source media="(min-width: 375px)" srcSet="/bb-logos/mandarina-375.svg" />
          <img src="/bb-logos/mandarina-320.svg" alt="Mandarina Duck" className="m-bb-mandarina-img" />
        </picture>
        {categories.map((c, i) => (
          <div key={c.label} className={`m-bb-cat m-bb-cat-${i + 1}`}>
            <div className="m-bb-icon">{c.icon}</div>
            <div className="m-bb-label">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
