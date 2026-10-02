"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Self-hosted accessibility widget (no third-party script) ──────────────
// A floating button + panel that applies real, reversible display
// adaptations and persists the user's choices in localStorage. The visual
// effects are applied as side-effects on <html> (classes + inline style),
// NOT as React markup, so there is no hydration mismatch. See the matching
// "פרטי נגישות" statement in src/content/legal-docs.tsx which mirrors these
// exact features.

type A11ySettings = {
  fontStep: number; // integer steps from base (each = +FONT_STEP_PCT%)
  contrast: boolean;
  grayscale: boolean;
  underlineLinks: boolean;
  stopMotion: boolean;
  readableFont: boolean;
  bigCursor: boolean;
};

const STORAGE_KEY = "toptik_a11y";
const FONT_STEP_PCT = 6;
const MIN_FONT_STEP = -2;
const MAX_FONT_STEP = 5;

const DEFAULT_SETTINGS: A11ySettings = {
  fontStep: 0,
  contrast: false,
  grayscale: false,
  underlineLinks: false,
  stopMotion: false,
  readableFont: false,
  bigCursor: false,
};

function readSettings(): A11ySettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<A11ySettings>) }
      : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function applySettings(s: A11ySettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // Text size — scales rem/em-based typography.
  root.style.fontSize =
    s.fontStep === 0 ? "" : `${100 + s.fontStep * FONT_STEP_PCT}%`;

  // Colour filters stacked on the root (safe for position:fixed descendants).
  const filters: string[] = [];
  if (s.grayscale) filters.push("grayscale(1)");
  if (s.contrast) filters.push("contrast(1.35)");
  root.style.filter = filters.length ? filters.join(" ") : "";

  root.classList.toggle("a11y-underline-links", s.underlineLinks);
  root.classList.toggle("a11y-stop-motion", s.stopMotion);
  root.classList.toggle("a11y-readable-font", s.readableFont);
  root.classList.toggle("a11y-big-cursor", s.bigCursor);
}

export function AccessibilityWidget() {
  const [open, setOpen] = useState(false);
  // Lazy initializer reads persisted prefs on the client (SSR-safe fallback to
  // defaults). Initial markup does not depend on settings, so no hydration gap.
  const [settings, setSettings] = useState<A11ySettings>(readSettings);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Keep the DOM + storage in sync whenever settings change.
  useEffect(() => {
    applySettings(settings);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage may be unavailable (private mode) — effects still applied */
    }
  }, [settings]);

  // Close on Escape and click-outside while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        !panelRef.current?.contains(t) &&
        !buttonRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const update = useCallback(
    (patch: Partial<A11ySettings>) =>
      setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );

  const changeFont = useCallback(
    (dir: 1 | -1) =>
      setSettings((prev) => ({
        ...prev,
        fontStep: Math.max(
          MIN_FONT_STEP,
          Math.min(MAX_FONT_STEP, prev.fontStep + dir),
        ),
      })),
    [],
  );

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const skipToContent = useCallback(() => {
    const target = document.querySelector<HTMLElement>(
      '#main-content, main, [role="main"]',
    );
    if (!target) return;
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: false });
    target.scrollIntoView({ block: "start" });
    setOpen(false);
  }, []);

  const isDefault =
    JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS);

  return (
    <div className="a11y-widget" dir="rtl">
      <button
        ref={buttonRef}
        type="button"
        className="a11y-fab"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="תפריט נגישות"
        title="תפריט נגישות"
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="12" cy="5.6" r="1.7" fill="currentColor" />
          <path
            d="M4.8 8.4c2.3.9 4.7 1.3 7.2 1.3s4.9-.4 7.2-1.3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M12 9.7v5m0 0-2.6 5m2.6-5 2.6 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          className="a11y-panel"
          role="dialog"
          aria-label="תפריט נגישות"
        >
          <div className="a11y-panel-head">
            <span className="a11y-panel-title">תפריט נגישות</span>
            <button
              type="button"
              className="a11y-panel-close"
              aria-label="סגור תפריט נגישות"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              ✕
            </button>
          </div>

          <div className="a11y-font-row">
            <span className="a11y-font-label">גודל טקסט</span>
            <div className="a11y-font-controls">
              <button
                type="button"
                className="a11y-step"
                aria-label="הקטנת טקסט"
                onClick={() => changeFont(-1)}
                disabled={settings.fontStep <= MIN_FONT_STEP}
              >
                −
              </button>
              <span className="a11y-font-value" aria-hidden="true">
                {100 + settings.fontStep * FONT_STEP_PCT}%
              </span>
              <button
                type="button"
                className="a11y-step"
                aria-label="הגדלת טקסט"
                onClick={() => changeFont(1)}
                disabled={settings.fontStep >= MAX_FONT_STEP}
              >
                +
              </button>
            </div>
          </div>

          <div className="a11y-options">
            <A11yToggle
              label="ניגודיות גבוהה"
              active={settings.contrast}
              onClick={() => update({ contrast: !settings.contrast })}
            />
            <A11yToggle
              label="גווני אפור"
              active={settings.grayscale}
              onClick={() => update({ grayscale: !settings.grayscale })}
            />
            <A11yToggle
              label="הדגשת קישורים"
              active={settings.underlineLinks}
              onClick={() =>
                update({ underlineLinks: !settings.underlineLinks })
              }
            />
            <A11yToggle
              label="עצירת אנימציות"
              active={settings.stopMotion}
              onClick={() => update({ stopMotion: !settings.stopMotion })}
            />
            <A11yToggle
              label="גופן קריא"
              active={settings.readableFont}
              onClick={() => update({ readableFont: !settings.readableFont })}
            />
            <A11yToggle
              label="סמן גדול"
              active={settings.bigCursor}
              onClick={() => update({ bigCursor: !settings.bigCursor })}
            />
          </div>

          <button
            type="button"
            className="a11y-skip"
            onClick={skipToContent}
          >
            דילוג לתוכן הראשי
          </button>

          <button
            type="button"
            className="a11y-reset"
            onClick={reset}
            disabled={isDefault}
          >
            איפוס הגדרות נגישות
          </button>

          <p className="a11y-panel-note">
            <a href="/accessibility">הצהרת נגישות ועזרה בגלישה</a><br />
            לפניות בנושא נגישות:{" "}
            <a href="mailto:talns33@gmail.com">talns33@gmail.com</a>
          </p>
        </div>
      )}
    </div>
  );
}

function A11yToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="a11y-toggle"
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="a11y-toggle-label">{label}</span>
      <span className="a11y-toggle-state" aria-hidden="true">
        {active ? "פעיל" : ""}
      </span>
    </button>
  );
}
