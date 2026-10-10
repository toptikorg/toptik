"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const ID = "G-LHWB69CV2M";
const KEY = "toptik-analytics-consent-v1";
type Choice = "granted" | "denied";
type AnalyticsWindow = Window & {
  "ga-disable-G-LHWB69CV2M"?: boolean;
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
};

function permitted(path: string) {
  return window.location.hostname === "landing.toptik.co.il" &&
    !/^\/(admin|login|setup|reset|dashboard|settings|auth|api)(\/|$)/.test(path);
}

function startMeasurement(path: string) {
  const w = window as AnalyticsWindow;
  w["ga-disable-G-LHWB69CV2M"] = false;
  if (!w.gtag) {
    w.dataLayer = w.dataLayer || [];
    // Google tag's documented queue uses Arguments objects.
    // eslint-disable-next-line prefer-rest-params
    w.gtag = function () { w.dataLayer!.push(arguments); };
    w.gtag("consent", "default", {
      analytics_storage: "granted", ad_storage: "denied",
      ad_user_data: "denied", ad_personalization: "denied",
    });
    w.gtag("js", new Date());
    w.gtag("config", ID, {
      send_page_view: false, allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_domain: "landing.toptik.co.il",
    });
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${ID}`;
    script.id = "toptik-gallery-google-tag";
    document.head.appendChild(script);
  }
  w.gtag("consent", "update", { analytics_storage: "granted" });
  // Deliberately omit query strings, hashes and titles that might contain input.
  w.gtag("event", "page_view", {
    page_location: `https://landing.toptik.co.il${path}`,
    page_title: "TopTik Gallery",
    page_referrer: document.referrer ? new URL(document.referrer).origin : "",
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
    if (choice === "granted") startMeasurement(path);
  }, [path]);

  function choose(choice: Choice) {
    try { localStorage.setItem(KEY, choice); } catch { /* Choice still applies now. */ }
    if (choice === "granted") startMeasurement(path);
    else {
      (window as AnalyticsWindow)["ga-disable-G-LHWB69CV2M"] = true;
      (window as AnalyticsWindow).gtag?.("consent", "update", { analytics_storage: "denied" });
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
      <p>אפשר לעזור לנו לשפר את הגלריה באמצעות Google Analytics ועוגיות מדידה. הבחירה אינה נדרשת לשימוש באתר, ואפשר לשנות אותה בתחתית העמוד.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" onClick={() => choose("granted")} style={{ border: "1px solid #333", borderRadius: 6, padding: "10px 18px", minHeight: 44, cursor: "pointer" }}>אישור מדידה</button>
        <button type="button" onClick={() => choose("denied")} style={{ border: "1px solid #333", borderRadius: 6, padding: "10px 18px", minHeight: 44, cursor: "pointer" }}>ללא מדידה</button>
      </div>
    </section>}
  </>;
}
