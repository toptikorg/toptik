"use client";

import { useEffect, useRef, useState } from "react";
import { CarouselItem } from "@/lib/carousel/types";
import type { ResolvedSwatch } from "@/lib/carousel/colors";
import { trimmedProductSrc, MODAL_IMG_WIDTH } from "@/lib/carousel/trim-src";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { descriptionWithoutCatalogNumber } from "@/lib/carousel/description";
import { ReliableProductImage, type ProductImageState } from "./ReliableProductImage";

type ProductModalProps = {
  item: CarouselItem | null;
  colors?: ResolvedSwatch[];
  onClose: () => void;
  onOpenTechSpecs: (item: CarouselItem) => void;
  onNavigateToItem: (itemId: string) => void;
};

// The angle paths a swatch rotates through: its own scraped angles, else its
// single cover, else nothing.
function anglesOf(swatch: ResolvedSwatch): string[] {
  if (swatch.angles.length > 0) return swatch.angles;
  return swatch.imagePath ? [swatch.imagePath] : [];
}

// Map raw storage paths to the EXACT display-ready trim URLs the <img> requests
// (same width tier), so a <link rel=preload> for each resolves to a cache hit
// rather than a wasted parallel fetch.
function galleryUrls(paths: string[]): string[] {
  return paths.map((p) => trimmedProductSrc(p, MODAL_IMG_WIDTH)).filter(Boolean);
}

// Order a gallery so the active angle and its immediate neighbours warm first.
function orderNearest(paths: string[], activeIndex: number): string[] {
  const count = paths.length;
  if (count === 0) return [];
  return [...paths.keys()]
    .sort((a, b) => {
      const da = Math.min((a - activeIndex + count) % count, (activeIndex - a + count) % count);
      const db = Math.min((b - activeIndex + count) % count, (activeIndex - b + count) % count);
      return da - db;
    })
    .map((i) => trimmedProductSrc(paths[i], MODAL_IMG_WIDTH));
}

const scheduleIdle: (cb: () => void) => void =
  typeof window !== "undefined" &&
  (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
    ? (cb) =>
        (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(cb)
    : (cb) => {
        if (typeof window !== "undefined") window.setTimeout(cb, 200);
      };

// Warm each url not already warmed via a <link rel=preload as=image>. Because the
// trim route now returns the final display-ready WebP (single pipeline — no
// next/image AVIF re-encode), these preloads load the SAME bytes the <img> shows,
// so a colour/angle switch paints from cache instead of a 1-3s cold compute.
function warmImages(urls: string[], eager: boolean, warmed: Set<string>) {
  if (typeof window === "undefined") return;
  for (const url of urls) {
    if (!url || warmed.has(url) || url.startsWith("data:")) continue;
    warmed.add(url);
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = url;
    link.setAttribute("fetchpriority", eager ? "high" : "low");
    document.head.appendChild(link);
    window.setTimeout(() => link.remove(), 60000);
  }
}

export function ProductModal({ item, colors = [], onClose, onOpenTechSpecs, onNavigateToItem }: ProductModalProps) {
  const touchStartX = useRef<number | null>(null);
  // Tracks every URL already preloaded for THIS modal open. The modal is remounted
  // per item (keyed by id in the parent), so this resets on each open.
  const warmedRef = useRef<Set<string>>(new Set());
  // The modal is remounted per item, so the selected colour is fixed to the
  // item's own colour for this open. Swatches navigate to another product rather
  // than swapping the gallery in place, so this never changes after mount.
  const [selectedColorKey] = useState<string | null>(
    () => colors.find((c) => c.isCurrent)?.key ?? null,
  );
  const [angleIdx, setAngleIdx] = useState(0);
  const [imageState, setImageState] = useState<ProductImageState>("loading");
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);

  // Rotation is strictly this item's gallery. A colour swatch explicitly
  // navigates to a different item; it is never an automatic image fallback.
  const gallery: string[] =
    item && item.angles.length > 0
        ? item.angles.map((a) => a.imagePath)
        : item?.coverImagePath
          ? [item.coverImagePath]
          : [];
  const count = gallery.length;
  const safeIdx = count > 0 ? Math.min(angleIdx, count - 1) : 0;

  // Preload strategy (the fix for slow angle/colour switching):
  //  (a) the gallery we're showing — highest priority, nearest angle first
  //  (b) one cover per OTHER colour — so the first frame after a swatch click is instant
  //  (c) idle: every colour's full set of angles — so deep rotation is instant too
  useEffect(() => {
    if (!item) return;
    const warmed = warmedRef.current;

    warmImages(orderNearest(gallery, safeIdx), true, warmed);

    const otherCovers = colors
      .filter((c) => c.key !== selectedColorKey)
      .map((c) => trimmedProductSrc(anglesOf(c)[0] ?? "", MODAL_IMG_WIDTH));
    warmImages(otherCovers, true, warmed);

    scheduleIdle(() => {
      for (const c of colors) warmImages(galleryUrls(anglesOf(c)), false, warmed);
      if (item.angles.length > 0) {
        warmImages(galleryUrls(item.angles.map((a) => a.imagePath)), false, warmed);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, selectedColorKey]);

  useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight" || event.key === " ") setAngleIdx((i) => (count ? (i + 1) % count : 0));
      if (event.key === "ArrowLeft") setAngleIdx((i) => (count ? (i - 1 + count) % count : 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose, count]);

  if (!item) return null;

  const displayed = gallery[safeIdx] ?? item.coverImagePath;
  const resolvedAngle = resolvedPath ? gallery.indexOf(resolvedPath) : -1;
  const catalogLabel = item.catalogNumber ? `דגם ${item.catalogNumber}` : "דגם";
  const purchaseUrl = purchaseUrlFor(item.catalogNumber);
  const description = descriptionWithoutCatalogNumber(item.description, item.catalogNumber);

  const next = () => setAngleIdx((i) => (count ? (i + 1) % count : 0));
  const prev = () => setAngleIdx((i) => (count ? (i - 1 + count) % count : 0));
  // Hovering/touching a swatch warms that colour's full gallery at high priority,
  // so navigating to that product paints from cache.
  const warmColor = (swatch: ResolvedSwatch) =>
    warmImages(galleryUrls(anglesOf(swatch)), true, warmedRef.current);

  function onTouchEnd(clientX: number) {
    if (touchStartX.current === null) return;
    const delta = clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) < 36) return;
    if (delta < 0) next();
    else prev();
  }

  return (
    <div
      className="product-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`תצוגת מוצר ${item.title}`}
      onClick={onClose}
    >
      <div className="product-modal" onClick={(e) => e.stopPropagation()}>
        <div className="product-modal-content">
          <div className="product-modal-gallery">

            <div className="product-modal-gallery-center">
              {/* image */}
              <div
                className="product-modal-image-wrap"
                onClick={next}
                onTouchStart={(event) => {
                  touchStartX.current = event.touches[0]?.clientX ?? null;
                }}
                onTouchEnd={(event) => onTouchEnd(event.changedTouches[0]?.clientX ?? 0)}
                role="button"
                tabIndex={0}
                aria-label="דפדף לזווית הבאה"
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") next();
                }}
              >
                <ReliableProductImage
                  item={item}
                  preferredSrc={displayed}
                  width={MODAL_IMG_WIDTH}
                  className="product-modal-image"
                  onStateChange={setImageState}
                  onResolved={setResolvedPath}
                />
                {imageState === "unavailable" && <p role="status">תמונות המוצר אינן זמינות כרגע.</p>}
                <div className="product-modal-cycle-btn product-modal-cycle-btn--icon" aria-label="לזוויות נוספות דפדפו">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/360.png" alt="" aria-hidden="true" className="product-modal-cycle-icon" />
                </div>

                {/* side arrows — inside image frame, pointing outward */}
                <button
                  className="product-modal-side-arrow product-modal-side-arrow--prev"
                  onClick={(e) => { e.stopPropagation(); prev(); }}
                  aria-label="זווית קודמת"
                >
                  ‹
                </button>
                <button
                  className="product-modal-side-arrow product-modal-side-arrow--next"
                  onClick={(e) => { e.stopPropagation(); next(); }}
                  aria-label="זווית הבאה"
                >
                  ›
                </button>
              </div>

              {/* dots */}
              <div className="product-modal-slider" aria-label="דפדוף זוויות מוצר">
                <div className="product-modal-slider-dots">
                  {gallery.map((path, index) => (
                    <button
                      key={`${path}-${index}`}
                      className={`product-modal-slider-dot${index === resolvedAngle ? " is-active" : ""}`}
                      onClick={() => setAngleIdx(index)}
                      aria-label={`עבור לזווית ${index + 1}`}
                      aria-current={index === resolvedAngle ? "true" : undefined}
                    />
                  ))}
                </div>
              </div>

              {/* color swatches */}
              {colors.length > 0 && (
                <div className="product-modal-colors" dir="rtl">
                  <span className="product-modal-colors-label">צבעים</span>
                  <div className="product-modal-colors-swatches">
                    {colors.map((c) => {
                      const selected = c.key === selectedColorKey;
                      return (
                        <button
                          key={c.key}
                          type="button"
                          className={`product-modal-color-dot${selected ? " is-current" : ""} is-actionable`}
                          title={c.name}
                          style={c.hex ? { background: c.hex } : undefined}
                          aria-label={c.name}
                          aria-current={selected || undefined}
                          onMouseEnter={() => warmColor(c)}
                          onFocus={() => warmColor(c)}
                          onTouchStart={() => warmColor(c)}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Each swatch IS its own product — navigate to it.
                            if (!c.isCurrent && c.itemId) onNavigateToItem(c.itemId);
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="product-modal-meta">
            <div className="product-modal-catalog">{catalogLabel}</div>
            <div className="product-modal-title">{item.title}</div>
            {description && <div className="product-modal-description">{description}</div>}
            <div className="product-modal-angle">
              {resolvedAngle >= 0 ? `${resolvedAngle + 1} / ${count}` : imageState === "ready" ? "תמונת מוצר" : ""}
            </div>
            <div className="product-modal-actions">
              {/* GAL-027: same tab, so one Back returns to the gallery URL (brand + category). */}
              {purchaseUrl && (
                <a
                  className="product-modal-buy-btn"
                  href={purchaseUrl}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`להמשך רכישה בחנות TopTik: ${item.title}`}
                >
                  להמשך רכישה בחנות TopTik
                </a>
              )}
              {(item.sourceUrl || (item.techSpecs?.specs?.length ?? 0) > 0) && (
                <button
                  className="product-modal-tech-btn"
                  onClick={(e) => { e.stopPropagation(); onOpenTechSpecs(item); }}
                  aria-label="פרטים טכניים"
                >
                  לנתונים טכנים
                </button>
              )}
            </div>
          </div>
        </div>
        <button type="button" className="product-modal-close" onClick={onClose} aria-label="סגור">
          ✕
        </button>
      </div>
    </div>
  );
}
