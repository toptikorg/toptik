import type { Metadata } from "next";
import Image from "next/image";
import homePageImage from "../../images/images_from_mandarina/Home_page.png";
import MobileLayer from "./MobileLayer";
import { HomeToCarouselCta } from "@/components/carousel/HomeToCarouselCta";
import { InfoMenu } from "@/components/InfoMenu";
import { AccessibilityWidget } from "@/components/AccessibilityWidget";
import { isCarouselEnabled } from "@/lib/carousel/feature-flag";

const navItems = [
  { href: "#deals", label: "מבצעים" },
];

const bbCategories = [
  {
    label: "עיצוב איטלקי",
    sublabel: "אלגנטיות על-זמנית",
    icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M5 21V10l7-6 7 6v11M3 21h18M9 21v-6h6v6M9 8h.01M12 8h.01M15 8h.01" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "פונקציונליות חכמה",
    sublabel: "חכמת חדשנית",
    icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "חומרי גלם איכותיים",
    sublabel: "איכות יוצאת דופן",
    icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M6 3l-4 6 10 12L22 9l-4-6H6z M11 3 L8 9 L12 21 L16 9 L13 3 M2 9h20" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    ),
  },
];

// Canonical host only; indexing directives stay noindex, follow (root layout).
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  const carouselEnabled = isCarouselEnabled();

  return (
    <div className="page">
      <div className="stage" data-variant="v1" id="main-content">
        {/* Hero — desktop landscape (1366x666) */}
        <Image
          src={homePageImage}
          alt="TopTik Hero"
          fill
          preload
          sizes="100vw"
          className="hero-img hero-desktop"
        />

        {/* Hero — mobile portrait — Next image pipeline serves AVIF/WebP at deviceSize widths */}
        <Image
          src="/hero-mobile-sizes/hero-mobile-414.png"
          alt="TopTik Hero Mobile"
          fill
          sizes="(max-width: 414px) 100vw, 414px"
          className="hero-img hero-mobile"
        />

        {/* Top scrim */}
        <div className="scrim-top" aria-hidden />
        <div className="warm-tone" aria-hidden />
        <div className="halation" aria-hidden />
        <div className="vignette" aria-hidden />

        {/* ─── TOP NAVBAR (restored to original) ─── */}
        <header className="navbar">
          <div className="brand">
            <div className="title">TOPTIK COLLECTION</div>
            <div className="slogan">Move in Style. Travel with Purpose.</div>
          </div>

          <nav aria-label="Primary" dir="rtl">
            {navItems.map((item) => (
              <a key={item.href} href={item.href}>
                {item.label}
              </a>
            ))}
            <InfoMenu variant="desktop" />
          </nav>

          <div className="cta-actions">
            {carouselEnabled && <HomeToCarouselCta heroImageUrl="/hero-web-airport.png" />}
            <a
              className="cta-icon"
              href="https://wa.me/"
              target="_blank"
              rel="noopener"
              aria-label="דברו איתנו בוואטסאפ"
            >
              <span className="cta-text">צ&#39;וטטו עימנו</span>
              <span className="cta-icon-badge" aria-hidden>
                <Image
                  src="/whatsapp.png"
                  alt="WhatsApp"
                  width={96}
                  height={96}
                  preload
                />
              </span>
            </a>
          </div>
        </header>

        {/* ─── BOTTOM BAR — fully composed of independent elements (no baked PNG) ─── */}
        <div className="bottom-bar" dir="rtl">
          {/* TopTik logo (right in RTL) */}
          <div className="bb-logo-slot bb-toptik">
            {/* Plain img — avoids Next.js Image inline style height override that breaks CSS centering */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/toptiklogo.png"
              alt="TopTik"
              className="bb-logo-img bb-toptik-img"
            />
          </div>

          {/* 3 categories (icon + label + sublabel) */}
          <div className="bb-cats">
            {bbCategories.map((c, i) => (
              <div key={c.label} className={`bb-cat bb-cat-${i + 1}`}>
                <div className="bb-cat-icon">{c.icon}</div>
                <div className="bb-cat-text">
                  <div className="bb-cat-label">{c.label}</div>
                  <div className="bb-cat-sublabel">{c.sublabel}</div>
                </div>
              </div>
            ))}
          </div>

          {/* MANDARINA DUCK logo (left in RTL) */}
          <div className="bb-logo-slot bb-mandarina">
            {/* Use plain <img> for SVG to keep crisp vector at any scale */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/bb-logos/mandarina-414.svg"
              alt="Mandarina Duck"
              className="bb-logo-img bb-mandarina-img"
            />
          </div>
        </div>

        {/* ═══ MOBILE LAYER (<768px only - hidden on desktop via CSS) ═══ */}
        <MobileLayer isCarouselEnabled={carouselEnabled} />
      </div>

      {/* Site-wide accessibility menu (floating button, bottom-left in RTL) */}
      <AccessibilityWidget />

      <style>{`
        /* Desktop: stage ALWAYS fills full viewport (width + height) — no side margins, no scroll.
           Hero image stretches/crops via object-fit:cover to whatever aspect the viewport is. */
        .page {
          margin: 0;
          width: 100%;
        }

        .stage {
          --bb-h: 11.57dvh;
          position: relative;
          width: 100vw;
          height: 100dvh;
          overflow: hidden;
          background: #fdf8ee;
        }

        .hero-img {
          object-fit: cover;
          object-position: center top;
          filter:
            contrast(var(--contrast))
            saturate(var(--sat))
            brightness(var(--brightness));
          image-rendering: -webkit-optimize-contrast;
          image-rendering: crisp-edges;
          transform: translateZ(0);
          backface-visibility: hidden;
        }
        .hero-mobile-picture {
          position: absolute;
          inset: 0;
          display: block;
        }
        .hero-mobile-picture .hero-mobile {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .hero-desktop {
          top: 0 !important;
          right: 0 !important;
          bottom: auto !important;
          left: 0 !important;
          width: 100% !important;
          height: calc(100% - var(--bb-h)) !important;
          object-position: center bottom;
        }

        .scrim-top {
          position: absolute; inset: 0 0 auto 0;
          height: 42%;
          pointer-events: none;
          background:
            radial-gradient(ellipse 55% 90% at 26% 18%,
              rgba(255,252,246, calc(var(--scrim-strength) * 0.75)) 0%,
              rgba(255,252,246, calc(var(--scrim-strength) * 0.30)) 35%,
              rgba(255,252,246, 0) 70%);
          mix-blend-mode: screen;
        }
        .warm-tone {
          position: absolute; inset: 0;
          pointer-events: none;
          background: radial-gradient(ellipse 90% 60% at 70% 40%,
            rgba(255, 196, 120, calc(var(--warm) * 1.2)) 0%,
            rgba(255, 196, 120, 0) 70%);
          mix-blend-mode: soft-light;
        }
        .halation {
          position: absolute; inset: 0;
          pointer-events: none;
          background:
            radial-gradient(ellipse 30% 40% at 60% 55%, rgba(255,200,90, calc(var(--halation)*0.45)) 0%, transparent 60%),
            radial-gradient(ellipse 55% 35% at 50% 15%, rgba(255,220,160, calc(var(--halation)*0.35)) 0%, transparent 70%);
          mix-blend-mode: screen;
        }
        .vignette {
          position: absolute; inset: 0;
          pointer-events: none;
          background:
            radial-gradient(ellipse 80% 70% at 50% 50%, transparent 55%, rgba(0,0,0, calc(var(--vignette) * 0.55)) 100%);
        }

        /* ===== TOP NAVBAR (RESTORED to original Figma spec) ===== */
        .navbar {
          position: absolute;
          left: 0; right: 0; top: 0;
          height: 11.5%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 clamp(18px, 3.2%, 48px);
          z-index: 6;
          direction: ltr;

          background: var(--bar-bg);
          backdrop-filter: blur(12px) saturate(1.08);
          -webkit-backdrop-filter: blur(12px) saturate(1.08);
        }

        .brand {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          line-height: 1.02;
          color: var(--ink);
          user-select: none;
        }
        .brand .title {
          font-family: var(--font-italiana), var(--font-playfair), serif;
          font-weight: 400;
          letter-spacing: 0.22em;
          font-size: clamp(16px, 2.2vw, 28px);
          color: var(--ink);
          white-space: nowrap;
        }
        .brand .slogan {
          font-family: var(--font-great-vibes), cursive;
          font-size: clamp(13px, 1.5vw, 19px);
          color: var(--ink-soft);
          margin-top: 2px;
          white-space: nowrap;
          line-height: 1.1;
        }

        .navbar nav {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: clamp(14px, 2.2vw, 30px);
          z-index: 1;
        }
        .navbar nav a {
          font-family: var(--font-assistant), var(--font-rubik), sans-serif;
          font-size: clamp(13px, 1.15vw, 16px);
          font-weight: 600;
          letter-spacing: 0.02em;
          color: var(--ink);
          text-decoration: none;
          position: relative;
          padding: 6px 2px;
          transition: color .2s ease;
        }
        .navbar nav a::after {
          content: "";
          position: absolute; left: 0; right: 0; bottom: 0;
          height: 1px;
          background: currentColor;
          transform: scaleX(0);
          transform-origin: center;
          transition: transform .25s ease;
        }
        .navbar nav a:hover { color: #8a6a2d; }
        .navbar nav a:hover::after { transform: scaleX(1); }

        .cta-actions {
          display: flex;
          align-items: center;
          gap: clamp(8px, 0.8vw, 12px);
        }

        .enter-catalog-btn {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 0;
          background: transparent;
          color: var(--ink);
          width: clamp(128px, 9.4vw, 154px);
          height: clamp(40px, 3vw, 48px);
          padding: 0;
          background-repeat: no-repeat;
          background-position: center;
          background-size: 116% 470%;
          font-family: var(--font-assistant), var(--font-rubik), sans-serif;
          font-size: clamp(12px, 0.92vw, 14px);
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.18s ease, filter 0.18s ease;
          white-space: nowrap;
          overflow: hidden;
        }
        .enter-catalog-btn:hover {
          transform: translateY(-1px);
          filter: brightness(1.03);
        }
        .enter-catalog-btn:disabled {
          opacity: 0.72;
          cursor: wait;
        }
        .catalog-svg-btn-text {
          position: relative;
          font-family: var(--font-assistant), var(--font-rubik), sans-serif;
          font-weight: 700;
          color: var(--ink);
          line-height: 1;
          transform: translateY(-1px);
        }

        .shatter-overlay {
          position: fixed;
          inset: 0;
          z-index: 90;
          pointer-events: none;
          overflow: hidden;
        }
        .shatter-fragment {
          position: absolute;
          background-repeat: no-repeat;
          will-change: transform, opacity;
        }

        /* WhatsApp CTA */
        .navbar .cta-icon {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: clamp(6px, 0.7vw, 10px);
          min-height: clamp(40px, 3vw, 48px);
          text-decoration: none;
          transition: transform .2s ease, filter .2s ease;
        }
        .navbar .cta-text {
          font-family: var(--font-assistant), var(--font-rubik), sans-serif;
          font-size: clamp(12px, 0.95vw, 15px);
          font-weight: 700;
          color: var(--ink);
          white-space: nowrap;
          line-height: 1;
        }
        .navbar .cta-icon-badge {
          width: clamp(40px, 3vw, 48px);
          height: clamp(40px, 3vw, 48px);
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }
        .navbar .cta-icon-badge img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          display: block;
        }
        .navbar .cta-icon:hover {
          transform: translateY(-1px) scale(1.05);
          filter: brightness(1.08);
        }

        /* ===== BOTTOM BAR — flex row of independent elements =====
           Bar height = 11.57% of stage = 11.57vh.
           Logos taller than bar: toptik=19.3vh (167%), mandarina=16.9vh (146%).
           Each logo container is its own flex cell — fully isolated, no shared sizing. */
        .bottom-bar {
          position: absolute;
          left: 0; right: 0; bottom: 0;
          height: var(--bb-h);          /* 125px at 1080 stage */
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
          padding: 0 clamp(16px, 2%, 36px);
          gap: clamp(12px, 2%, 32px);
          background: #f1e5d3;
          border-top: 1px solid rgba(31, 39, 49, 0.06);
          z-index: 5;
          overflow: visible;             /* logos allowed to grow above bar */
        }

        /* — TopTik logo (right in RTL) — isolated flex cell, vh-based height */
        .bb-logo-slot {
          flex: 0 0 auto;
          position: relative;
          height: 100%;
          line-height: 0;
          overflow: visible;
        }
        .bb-toptik {
          width: calc(var(--bb-h) * 4.23);
        }
        .bb-mandarina {
          width: calc(var(--bb-h) * 2.9);
        }

        .bb-logo-img {
          --logo-y-offset: 0px;
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, calc(-50% + var(--logo-y-offset)));
          width: auto;
          object-fit: contain;
          flex-shrink: 0;
          display: block;
        }

        .bb-toptik-img {
          --logo-y-offset: 6px;               /* optical correction: move down */
          height: calc(var(--bb-h) * 1.67);  /* 167% of bar */
        }

        /* — Categories (center, evenly spaced) — */
        .bb-cats {
          flex: 1 1 auto;
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: center;
          gap: clamp(20px, 3vw, 56px);
        }
        .bb-cat {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: clamp(8px, 0.8vw, 14px);
          color: var(--ink);
          line-height: 1.1;
        }
        .bb-cat-icon {
          flex: 0 0 auto;
          width: clamp(22px, 1.8vw, 32px);
          height: clamp(22px, 1.8vw, 32px);
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .bb-cat-icon svg {
          width: 100%;
          height: 100%;
        }
        .bb-cat-text {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
        }
        .bb-cat-label {
          font-family: var(--font-assistant), var(--font-rubik), sans-serif;
          font-size: clamp(13px, 1vw, 16px);
          font-weight: 600;
          color: var(--ink);
        }
        .bb-cat-sublabel {
          font-family: var(--font-assistant), var(--font-rubik), sans-serif;
          font-size: clamp(11px, 0.78vw, 13px);
          font-weight: 400;
          color: var(--ink-soft);
          margin-top: 1px;
        }

        /* — MANDARINA DUCK logo (left in RTL) — isolated flex cell, vh-based height */
        .bb-mandarina-img {
          --logo-y-offset: -12px;             /* optical correction: move up */
          height: calc(var(--bb-h) * 1.46);  /* 146% of bar */
        }

        /* Lowered breakpoint: nav hides only on real mobile (<560px),
           not on narrow desktop preview windows */
        @media (max-width: 560px) {
          .stage { aspect-ratio: 4 / 5; }
          .navbar { height: 14%; padding: 0 14px; }
          .navbar nav { display: none; }
          .cta-actions { gap: 4px; }
          .enter-catalog-btn { width: 112px; height: 36px; font-size: 11px; }
          .navbar .cta-icon { gap: 6px; }
          .navbar .cta-icon-badge { width: 36px; height: 36px; }
          .navbar .cta-text { font-size: 12px; }
          .brand .title { font-size: 15px; letter-spacing: 0.16em; }
          .brand .slogan { font-size: 13px; }
        }
      `}</style>
    </div>
  );
}
