"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const ID = "G-LHWB69CV2M";
const KEY = "toptik-analytics-consent-v1";
type Choice = "granted" | "denied";
type AnalyticsWindow = Window & {
  "ga-disable-G-LHWB69CV2M"?: boolean;
  toptikGalleryAnalyticsConfigured?: boolean;
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
};

function permitted(path: string) {
  return window.location.hostname === "landing.toptik.co.il" &&
    !/^\/(admin|login|setup|reset|dashboard|settings|auth|api)(\/|$)/.test(path);
}

function setConsent(choice: Choice) {
  const w = window as AnalyticsWindow;
  // Consent Mode keeps measurement cookieless until the visitor opts in.
  w["ga-disable-G-LHWB69CV2M"] = false;
  if (!w.gtag) {
    w.dataLayer = w.dataLayer || [];
    // Google tag's documented queue uses Arguments objects.
    // eslint-disable-next-line prefer-rest-params
    w.gtag = function () { w.dataLayer!.push(arguments); };
    w.gtag("consent", "default", {
      analytics_storage: "denied", ad_storage: "denied",
      ad_user_data: "denied", ad_personalization: "denied",
      wait_for_update: 500,
    });
    w.gtag("js", new Date());
  }
  w.gtag("consent", "update", {
    analytics_storage: choice,
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  if (!w.toptikGalleryAnalyticsConfigured) {
    w.gtag("config", ID, {
      send_page_view: false, allow_google_signals: false,
      allow_ad_personalization_signals: false,
      // Share the first-party GA client cookie with the Shopify store. This
      // keeps one visitor identity while moving between the gallery and shop.
      cookie_domain: "toptik.co.il",
    });
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${ID}`;
    script.id = "toptik-gallery-google-tag";
    document.head.appendChild(script);
    w.toptikGalleryAnalyticsConfigured = true;
  }
}

function startMeasurement(path: string, choice: Choice) {
  const w = window as AnalyticsWindow;
  setConsent(choice);
  // Deliberately omit query strings, hashes and titles that might contain input.
  w.gtag!("event", "page_view", {
    page_location: `https://landing.toptik.co.il${path}`,
    page_title: document.title || "גלריית TopTik",
    page_referrer: document.referrer ? new URL(document.referrer).origin : "",
  });
}

function trackStoreSelection(link: HTMLAnchorElement, path: string) {
  const w = window as AnalyticsWindow;
  if (!w.gtag) return;
  const url = new URL(link.href, window.location.href);
  if (url.hostname !== "www.toptik.co.il" || !url.pathname.startsWith("/products/")) return;
  const itemName = link.dataset.productName
    || link.getAttribute("aria-label")?.replace(/^להמשך רכישה בחנות TopTik:\s*/, "")
    || link.textContent?.trim()
    || "מוצר בחנות TopTik";
  w.gtag("event", "select_item", {
    item_list_name: path.startsWith("/journal") ? "TopTik Journal" : "TopTik Gallery",
    link_url: `https://www.toptik.co.il${url.pathname}`,
    source_path: path,
    transport_type: "beacon",
    items: [{ item_id: url.pathname.split("/").filter(Boolean).at(-1), item_name: itemName }],
  });
}

export function GalleryAnalytics() {
  const path = usePathname();
  const [visible, setVisible] = useState(false);
  const [publicPage, setPublicPage] = useState(false);
  useEffect(() => {
    if (!permitted(path)) return;
    // Hydrate browser-only consent once without changing the static server output.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPublicPage(true);
    let choice: string | null = null;
    try { choice = localStorage.getItem(KEY); } catch { /* Optional storage. */ }
    setVisible(!choice);
    startMeasurement(path, choice === "granted" ? "granted" : "denied");
    const onStoreClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('a[href*="www.toptik.co.il/products/"]');
      if (link) trackStoreSelection(link, path);
    };
    document.addEventListener("click", onStoreClick, true);
    return () => document.removeEventListener("click", onStoreClick, true);
  }, [path]);

  function choose(choice: Choice) {
    try { localStorage.setItem(KEY, choice); } catch { /* Choice still applies now. */ }
    setConsent(choice);
    if (choice === "denied") {
      for (const part of document.cookie.split(";")) {
        const name = part.trim().split("=")[0];
        if (name === "_ga" || name.startsWith("_ga_")) {
          for (const domain of ["", "; domain=landing.toptik.co.il"]) {
            document.cookie = `${name}=; Max-Age=0; path=/${domain}; SameSite=Lax; Secure`;
          }
        }
      }
    }
    setVisible(false);
  }

  if (!publicPage || !permitted(path)) return null;
  return <>
    <div style={{ textAlign: "center", background: "#151515", padding: "8px" }}>
      <button type="button" onClick={() => setVisible(true)} style={{ color: "#fff", textDecoration: "underline", minHeight: 44, padding: "8px 16px", cursor: "pointer" }}>העדפות מדידה</button>
    </div>
    {visible && <section aria-label="העדפות מדידה" style={{ position: "fixed", bottom: 16, insetInline: 16, margin: "0 auto", maxWidth: 580, zIndex: 10000, background: "#fff", color: "#171717", padding: 18, borderRadius: 12, boxShadow: "0 4px 24px #0005", fontSize: 16, lineHeight: 1.6 }}>
      <p>אפשר לעזור לנו לשפר את הגלריה באמצעות Google Analytics. אפשר לבחור מדידה עם עוגיות או מדידה בסיסית ללא עוגיות, ולשנות את הבחירה בכל עת בתחתית העמוד.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" onClick={() => choose("granted")} style={{ border: "1px solid #333", borderRadius: 6, padding: "10px 18px", minHeight: 44, cursor: "pointer" }}>אישור מדידה</button>
        <button type="button" onClick={() => choose("denied")} style={{ border: "1px solid #333", borderRadius: 6, padding: "10px 18px", minHeight: 44, cursor: "pointer" }}>ללא עוגיות מדידה</button>
      </div>
    </section>}
  </>;
}
