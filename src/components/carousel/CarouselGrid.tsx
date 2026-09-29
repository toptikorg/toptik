"use client";

import { useState, useMemo, useEffect } from "react";
import { A11y, Keyboard, Pagination } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import type { Swiper as SwiperType } from "swiper";
import { CarouselItem } from "@/lib/carousel/types";
import { buildModelSiblingSwatches, resolveItemSwatches, type ResolvedSwatch } from "@/lib/carousel/colors";
import { trimmedProductSrc, CARD_IMG_WIDTH, MODAL_IMG_WIDTH } from "@/lib/carousel/trim-src";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { descriptionWithoutCatalogNumber } from "@/lib/carousel/description";
import { productImageIdentity } from "@/lib/carousel/product-image";
import { ReliableProductImage, type ProductImageState } from "./ReliableProductImage";

import "swiper/css";
import "swiper/css/navigation";
import "swiper/css/pagination";

type CarouselGridProps = {
  items: CarouselItem[];
  /** Deprecated and ignored: the gallery no longer moves by itself. Kept so callers still compile. */
  autoplayMs?: number;
  /** Preview-only choice of control placement: "side" (arrows on the card sides) or "bar" (bottom control bar). */
  navVariant?: "side" | "bar";
  onOpenItem: (item: CarouselItem) => void;
  onOpenTechSpecs: (item: CarouselItem) => void;
  onNavigateToItem: (itemId: string) => void;
};

// Warm a card's first few angle images when the user signals open-intent
// (hover/touch). These are loaded at the MODAL width tier — the EXACT trim URL
// the product modal will request — so opening it paints from cache. The modal
// itself then warms the remaining angles and every other colour. Capped to keep
// the on-hover cost bounded (esp. on mobile touch).
function preloadAngleImages(item: CarouselItem) {
  if (typeof window === "undefined") return;
  const paths = (item.angles.length > 0
    ? item.angles.map((a) => a.imagePath)
    : [item.coverImagePath]
  )
    .filter((p): p is string => Boolean(p))
    .slice(0, 4);
  for (const path of paths) {
    const image = new window.Image();
    image.decoding = "async";
    image.src = trimmedProductSrc(path, MODAL_IMG_WIDTH);
  }
}

// Warm a single colour image at the CARD width — the EXACT URL the card renders
// when that swatch is clicked. Browser-cached (immutable), so repeat warms are
// free; a subsequent swatch click paints from cache.
function warmCardImage(path: string | null | undefined) {
  if (typeof window === "undefined" || !path) return;
  const image = new window.Image();
  image.decoding = "async";
  image.src = trimmedProductSrc(path, CARD_IMG_WIDTH);
}

// Warm EVERY swatch colour of a card at card width, so picking a colour IN THE
// GRID (before the modal is ever opened) is instant — the same preload-on-intent
// methodology used inside the modal. Triggered on card hover/touch/focus.
function preloadCardSwatches(swatches: ResolvedSwatch[]) {
  for (const swatch of swatches) warmCardImage(swatch.imagePath);
}

function extractCatalogNumber(item: CarouselItem) {
  const explicit = item.catalogNumber?.trim();
  if (explicit) return explicit;
  const titleToken = item.title.match(/[A-Z0-9]{2,}(?:[-_/][A-Z0-9]{2,})+/i)?.[0];
  return titleToken ?? "";
}

function chunkItems(items: CarouselItem[], size: number) {
  const chunks: CarouselItem[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Every card and every automatic image fallback belong to one exact item.
function CatalogCard({
  item,
  swatches,
  onOpenItem,
  onOpenTechSpecs,
  onNavigate,
  onImageUnavailable,
  onImageReady,
}: {
  item: CarouselItem;
  swatches: ResolvedSwatch[];
  onOpenItem: (item: CarouselItem) => void;
  onOpenTechSpecs: (item: CarouselItem) => void;
  onNavigate: (itemId: string) => void;
  onImageUnavailable: (identity: string) => void;
  onImageReady: () => void;
}) {
  const displayed = item.coverImagePath;
  const [imageState, setImageState] = useState<ProductImageState>("loading");
  const imageReady = imageState === "ready";
  const catalog = extractCatalogNumber(item);
  const purchaseUrl = purchaseUrlFor(item.catalogNumber);
  const description = descriptionWithoutCatalogNumber(item.description, catalog);

  return (
    <article
      className="catalog-card"
      style={{ visibility: imageReady ? undefined : "hidden" }}
      aria-hidden={!imageReady || undefined}
      aria-busy={!imageReady}
    >
      <div className="catalog-card-body swiper-no-swiping">
        {catalog && <div className="catalog-card-catalog">מספר קטלוגי: {catalog}</div>}
        <div className="catalog-card-main">
          <div className="catalog-card-title">{item.title}</div>
          {description && <div className="catalog-card-description">{description}</div>}
        </div>
        <div className="catalog-card-actions">
          {purchaseUrl && (
            <a
              className="catalog-card-buy-btn"
              href={purchaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label={`להמשך רכישה בחנות TopTik: ${item.title}`}
            >
              <span>להמשך רכישה בחנות TopTik</span>
            </a>
          )}
          {(item.sourceUrl || (item.techSpecs?.specs?.length ?? 0) > 0) && (
            <button
              className="catalog-card-tech-btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpenTechSpecs(item);
              }}
              aria-label={`נתונים טכניים עבור ${item.title}`}
            >
              <span>לנתונים טכנים</span>
            </button>
          )}
        </div>
      </div>
      <div className="catalog-card-visual">
        <div
          className="catalog-card-image-wrap"
          onMouseEnter={() => { preloadAngleImages(item); preloadCardSwatches(swatches); }}
          onFocus={() => { preloadAngleImages(item); preloadCardSwatches(swatches); }}
          onTouchStart={() => { preloadAngleImages(item); preloadCardSwatches(swatches); }}
          onClick={() => onOpenItem(item)}
          role="button"
          tabIndex={0}
          aria-label={`פתח זוויות מוצר ${item.title}`}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onOpenItem(item);
          }}
        >
          <ReliableProductImage
            item={item}
            preferredSrc={displayed}
            width={CARD_IMG_WIDTH}
            className="catalog-card-image"
            onStateChange={(state) => {
              setImageState(state);
              if (state === "unavailable") onImageUnavailable(productImageIdentity(item));
              if (state === "ready") onImageReady();
            }}
          />

          {/* top: view angles */}
          <button
            className="catalog-card-cta catalog-card-cta--icon"
            onMouseEnter={(e) => {
              e.stopPropagation();
              preloadAngleImages(item);
            }}
            onFocus={() => preloadAngleImages(item)}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenItem(item);
            }}
            aria-label={`הגדלה וזוויות נוספות עבור ${item.title}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/magnifier.png" alt="" aria-hidden="true" className="catalog-card-cta-icon" />
          </button>

          {/* bottom: colour swatches */}
          {swatches.length > 0 && (
            <div className="catalog-card-colors" dir="rtl">
              <span className="catalog-card-colors-label">צבעים</span>
              <div className="catalog-card-colors-dots">
                {swatches.map((swatch) => {
                  const actionable = Boolean(swatch.imagePath);
                  return (
                    <button
                      key={swatch.key}
                      type="button"
                      className={`catalog-card-color-dot${swatch.isCurrent ? " is-current" : ""}${actionable ? " is-actionable" : ""}`}
                      style={swatch.hex ? { background: swatch.hex } : undefined}
                      title={swatch.name}
                      aria-label={swatch.name}
                      aria-current={swatch.isCurrent || undefined}
                      onMouseEnter={() => warmCardImage(swatch.imagePath)}
                      onFocus={() => warmCardImage(swatch.imagePath)}
                      onTouchStart={() => warmCardImage(swatch.imagePath)}
                      onClick={(e) => {
                        e.stopPropagation();
                        // Each swatch IS its own product — navigate to it (unless
                        // it's the colour already shown on this card).
                        if (!swatch.isCurrent && swatch.itemId) onNavigate(swatch.itemId);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function CarouselGrid({ items, navVariant = "side", onOpenItem, onOpenTechSpecs, onNavigateToItem }: CarouselGridProps) {
  // Desktop shows 4 cards per slide (2×2); mobile shows 2 (stacked). Default to
  // the desktop count for SSR, then adjust on mount + on viewport changes.
  const [perPage, setPerPage] = useState(4);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setPerPage(mq.matches ? 2 : 4);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const [unavailableImages, setUnavailableImages] = useState<Set<string>>(() => new Set());
  // Presentation-only filter. Keep the supplied catalog and persisted rows intact.
  const visibleItems = useMemo(
    () => items.filter((item) => !unavailableImages.has(productImageIdentity(item))),
    [items, unavailableImages],
  );
  const pages = useMemo(() => chunkItems(visibleItems, perPage), [visibleItems, perPage]);
  const swiperKey = useMemo(() => `${perPage}:${visibleItems.map((item) => item.id).join("|")}`, [visibleItems, perPage]);
  const modelSiblings = useMemo(() => buildModelSiblingSwatches(visibleItems), [visibleItems]);
  const [swiperInstance, setSwiperInstance] = useState<SwiperType | null>(null);
  const [isBeginning, setIsBeginning] = useState(true);
  const [isEnd, setIsEnd] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const total = visibleItems.length;
  const first = Math.min(total, activeIndex * perPage + 1);
  const last = Math.min(total, (activeIndex + 1) * perPage);
  const positionText = total === 0 ? "" : first === last ? `מוצר ${first} מתוך ${total}` : `מוצרים ${first}–${last} מתוך ${total}`;
  const edgeText = pages.length <= 1 ? "" : isBeginning ? "תחילת הרשימה" : isEnd ? "סוף הרשימה" : "";
  const prevDisabled = isBeginning;
  const nextDisabled = isEnd;

  return (
    <section
      className="catalog-carousel"
      aria-label="קטלוג מוצרים"
      data-nav-variant={navVariant}
    >
      {visibleItems.length < items.length && (
        <p role="status">חלק מתמונות המוצרים אינן זמינות כרגע. הפריטים האלה הוסתרו זמנית מהגלריה.</p>
      )}
      {pages.length > 0 && <>
      {navVariant === "side" && (
        <p className="carousel-position carousel-position--top" role="status" aria-live="polite" data-testid="carousel-position">
          {positionText}{edgeText ? ` · ${edgeText}` : ""}
        </p>
      )}
      {navVariant === "side" && <>
      <button
        type="button"
        dir="ltr"
        className={`carousel-nav carousel-nav-prev${prevDisabled ? " swiper-button-disabled" : ""}`}
        aria-label="מוצרים קודמים"
        aria-disabled={prevDisabled}
        onClick={() => swiperInstance?.slidePrev()}
      >
        <span className="carousel-nav-glyph">&#x2039;</span>
      </button>
      <button
        type="button"
        dir="ltr"
        className={`carousel-nav carousel-nav-next${nextDisabled ? " swiper-button-disabled" : ""}`}
        aria-label="מוצרים הבאים"
        aria-disabled={nextDisabled}
        onClick={() => swiperInstance?.slideNext()}
      >
        <span className="carousel-nav-glyph">&#x203A;</span>
      </button>
      </>}
      <Swiper
        key={swiperKey}
        // Text selection and links keep native pointer behavior; images still swipe.
        noSwiping={true}
        noSwipingClass="swiper-no-swiping"
        modules={[Pagination, Keyboard, A11y]}
        slidesPerView={1}
        autoHeight={true}
        initialSlide={0}
        speed={450}
        navigation={false}
        pagination={{ clickable: true }}
        keyboard={{ enabled: true, onlyInViewport: true }}
        a11y={{
          enabled: true,
          prevSlideMessage: "מוצרים קודמים",
          nextSlideMessage: "מוצרים הבאים",
        }}
        onSwiper={(s) => { setSwiperInstance(s); setIsBeginning(s.isBeginning); setIsEnd(s.isEnd); setActiveIndex(s.activeIndex); }}
        onSlideChange={(s) => { setIsBeginning(s.isBeginning); setIsEnd(s.isEnd); setActiveIndex(s.activeIndex); }}
      >
        {pages.map((page, pageIndex) => (
          <SwiperSlide key={`page-${pageIndex}`}>
            <div className="catalog-grid">
              {page.map((item) => (
                <CatalogCard
                  key={productImageIdentity(item)}
                  item={item}
                  swatches={resolveItemSwatches(modelSiblings.get(item.id))}
                  onOpenItem={onOpenItem}
                  onOpenTechSpecs={onOpenTechSpecs}
                  onNavigate={onNavigateToItem}
                  onImageUnavailable={(identity) => setUnavailableImages((previous) => {
                    if (previous.has(identity)) return previous;
                    return new Set([...previous, identity]);
                  })}
                  onImageReady={() => requestAnimationFrame(() => {
                    if (swiperInstance && !swiperInstance.destroyed) swiperInstance.updateAutoHeight();
                  })}
                />
              ))}
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
      {navVariant === "bar" && (
        <div className="carousel-controls" role="group" aria-label="ניווט בין מוצרים">
          <button type="button" className="carousel-controls-btn" aria-label="מוצרים קודמים" aria-disabled={prevDisabled}
            disabled={prevDisabled} onClick={() => swiperInstance?.slidePrev()}><span aria-hidden="true">&#x203A;</span></button>
          <p className="carousel-position carousel-position--bar" role="status" aria-live="polite" data-testid="carousel-position">
            <span>{positionText}</span>{edgeText && <span className="carousel-position-edge">{edgeText}</span>}
          </p>
          <button type="button" className="carousel-controls-btn" aria-label="מוצרים הבאים" aria-disabled={nextDisabled}
            disabled={nextDisabled} onClick={() => swiperInstance?.slideNext()}><span aria-hidden="true">&#x2039;</span></button>
        </div>
      )}
      </>}
    </section>
  );
}
