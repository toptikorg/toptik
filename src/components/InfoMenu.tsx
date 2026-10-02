"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DOCS, MENU, type DocId } from "@/content/legal-docs";

type Variant = "desktop" | "mobile";

type Props = {
  variant: Variant;
  ids?: DocId[];
  // Mobile burger menu wants to close itself when an item is tapped.
  onItemSelect?: () => void;
};

export function InfoMenu({ variant, ids, onItemSelect }: Props) {
  const [openId, setOpenId] = useState<DocId | null>(null);
  // The "פרטיות / נגישות והצהרות" parent: dropdown open state (desktop) /
  // collapsible section state (mobile).
  const [groupOpen, setGroupOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpenId(null), []);

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [openId, close]);

  // Desktop dropdown: close on outside click / Escape.
  useEffect(() => {
    if (!groupOpen || variant !== "desktop") return;
    const onDown = (e: PointerEvent) => {
      if (groupRef.current && !groupRef.current.contains(e.target as Node)) {
        setGroupOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGroupOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [groupOpen, variant]);

  const openDoc = (id: DocId) => {
    setOpenId(id);
    setGroupOpen(false);
    onItemSelect?.();
  };

  const linkClass =
    variant === "mobile" ? "m-menu-info-link" : "navbar-info-link";

  // Portal the modal to <body> so it escapes any ancestor with
  // transform / backdrop-filter / overflow:hidden — those would otherwise
  // re-root position:fixed and clip the modal mid-content.
  const modal =
    openId && typeof document !== "undefined"
      ? createPortal(
          <div
            className="info-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={DOCS[openId].title}
            onClick={close}
          >
            <div
              className="info-modal"
              dir="rtl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="info-modal-close"
                onClick={close}
                aria-label="סגור"
              >
                ✕
              </button>
              <h1 className="info-modal-title">{DOCS[openId].title}</h1>
              <div className="info-modal-body">{DOCS[openId].body}</div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {(ids ? ids.map((id) => ({ kind: "doc" as const, id })) : MENU).map((entry) => {
        if (entry.kind === "doc") {
          if (entry.id === "webAccessibility") return <a key={entry.id} className={linkClass} href="/accessibility" onClick={onItemSelect}>הצהרת נגישות</a>;
          return (
            <button
              key={entry.id}
              type="button"
              className={linkClass}
              onClick={() => openDoc(entry.id)}
            >
              {DOCS[entry.id].title}
            </button>
          );
        }
        const subButtons = entry.ids.map((id) => (
          <button
            key={id}
            type="button"
            className={
              variant === "mobile" ? "m-menu-info-link" : "navbar-info-sublink"
            }
            onClick={() => openDoc(id)}
          >
            {DOCS[id].title}
          </button>
        ));
        if (variant === "mobile") {
          return (
            <div key={entry.title} className="m-menu-info-group">
              <button
                type="button"
                className="m-menu-info-link"
                aria-expanded={groupOpen}
                onClick={() => setGroupOpen((v) => !v)}
              >
                {entry.title}
                <span
                  className={`m-menu-info-caret${groupOpen ? " is-open" : ""}`}
                  aria-hidden
                >
                  ▾
                </span>
              </button>
              {groupOpen && (
                <div className="m-menu-info-sub">{subButtons}</div>
              )}
            </div>
          );
        }
        return (
          <div
            key={entry.title}
            ref={groupRef}
            className="navbar-info-group"
            data-open={groupOpen || undefined}
          >
            <button
              type="button"
              className="navbar-info-link"
              aria-expanded={groupOpen}
              aria-haspopup="menu"
              onClick={() => setGroupOpen((v) => !v)}
            >
              {entry.title}
              <span className="navbar-info-caret" aria-hidden>
                ▾
              </span>
            </button>
            {groupOpen && (
              <div className="navbar-info-dropdown" role="menu" dir="rtl">
                {subButtons}
              </div>
            )}
          </div>
        );
      })}
      {modal}
    </>
  );
}
