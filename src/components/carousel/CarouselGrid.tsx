"use client";

import { useState, useMemo, useEffect } from "react";
import Image from "next/image";
import { A11y, Autoplay, Keyboard, Pagination } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import type { Swiper as SwiperType } from "swiper";
import { CarouselItem } from "@/lib/carousel/types";
import { buildModelSiblingSwatches, resolveItemSwatches, type ResolvedSwatch } from "@/lib/carousel/colors";
import { trimmedProductSrc, CARD_IMG_WIDTH, MODAL_IMG_WIDTH } from "@/lib/carousel/trim-src";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";

import "swiper/css";
import "swiper/css/navigation";
import "swiper/css/pagination";

type CarouselGridProps = {
  items: CarouselItem[];
  autoplayMs: number;
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

// One catalog card. Holds the locally-selected colour so clicking a swatch swaps
// the displayed image to that colour's re-hosted cover (scraped colours only).
function CatalogCard({
  item,
  swatches,
  onOpenItem,
  onOpenTechSpecs,
  onNavigate,
}: {
  item: CarouselItem;
  swatches: ResolvedSwatch[];
  onOpenItem: (item: CarouselItem) => void;
  onOpenTechSpecs: (item: CarouselItem) => void;
  onNavigate: (itemId: string) => void;
}) {
  const displayed = item.coverImagePath;
  const catalog = extractCatalogNumber(item);
  const purchaseUrl = purchaseUrlFor(item.catalogNumber);

  return (
    <article className="catalog-card">
      <div className="catalog-card-body swiper-no-swiping">
        {catalog && <div className="catalog-card-catalog">מספר קטלוגי: {catalog}</div>}
        <div className="catalog-card-main">
          <div className="catalog-card-title">{item.title}</div>
          {item.description && <div className="catalog-card-description">{item.description}</div>}
        </div>
        <div className="catalog-card-actions">
          {purchaseUrl && (
            <a
              className="catalog-card-buy-btn"
              href={purchaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label={`רכישת ${item.title}`}
            >
              <span>לרכישה</span>
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
          {displayed ? (
            <Image
              src={trimmedProductSrc(displayed, CARD_IMG_WIDTH)}
              alt={item.title}
              width={CARD_IMG_WIDTH}
              height={CARD_IMG_WIDTH}
              unoptimized
              className="catalog-card-image"
            />
          ) : (
            <div className="catalog-card-image-placeholder" aria-hidden="true" />
          )}

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

export function CarouselGrid({ items, autoplayMs, onOpenItem, onOpenTechSpecs, onNavigateToItem }: CarouselGridProps) {
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
  const pages = useMemo(() => chunkItems(items, perPage), [items, perPage]);
  const swiperKey = useMemo(() => `${perPage}:${items.map((item) => item.id).join("|")}`, [items, perPage]);
  const modelSiblings = useMemo(() => buildModelSiblingSwatches(items), [items]);
  const [swiperInstance, setSwiperInstance] = useState<SwiperType | null>(null);
  const [isBeginning, setIsBeginning] = useState(true);
  const [isEnd, setIsEnd] = useState(false);

  return (
    <section
      className="catalog-carousel"
      aria-label="קטלוג מוצרים"
      // Pause autoplay while the pointer is anywhere inside the carousel, resume
      // on leave. Swiper's built-in pauseOnMouseEnter is unreliable with
      // disableOnInteraction:false, so drive it explicitly to guarantee it.
      onMouseEnter={() => swiperInstance?.autoplay?.pause()}
      onMouseLeave={() => swiperInstance?.autoplay?.resume()}
    >
      <button
        type="button"
        dir="ltr"
        className={`carousel-nav carousel-nav-prev${isBeginning && pages.length <= 1 ? " swiper-button-disabled" : ""}`}
        aria-label="עמוד קודם"
        onClick={() => swiperInstance?.slidePrev()}
      >
        <span className="carousel-nav-glyph">&#x2039;</span>
      </button>
      <button
        type="button"
        dir="ltr"
        className={`carousel-nav carousel-nav-next${isEnd && pages.length <= 1 ? " swiper-button-disabled" : ""}`}
        aria-label="עמוד הבא"
        onClick={() => swiperInstance?.slideNext()}
      >
        <span className="carousel-nav-glyph">&#x203A;</span>
      </button>
      <Swiper
        key={swiperKey}
        // Text selection and links keep native pointer behavior; images still swipe.
        noSwiping={true}
        noSwipingClass="swiper-no-swiping"
        modules={[Pagination, Keyboard, A11y, Autoplay]}
        slidesPerView={1}
        initialSlide={0}
        speed={450}
        navigation={false}
        pagination={{ clickable: true }}
        keyboard={{ enabled: true, onlyInViewport: true }}
        a11y={{
          enabled: true,
          prevSlideMessage: "עמוד קודם",
          nextSlideMessage: "עמוד הבא",
        }}
        autoplay={{
          delay: autoplayMs,
          disableOnInteraction: false,
          pauseOnMouseEnter: true,
        }}
        onSwiper={(s) => { setSwiperInstance(s); setIsBeginning(s.isBeginning); setIsEnd(s.isEnd); }}
        onSlideChange={(s) => { setIsBeginning(s.isBeginning); setIsEnd(s.isEnd); }}
      >
        {pages.map((page, pageIndex) => (
          <SwiperSlide key={`page-${pageIndex}`}>
            <div className="catalog-grid">
              {page.map((item) => (
                <CatalogCard
                  key={item.id}
                  item={item}
                  swatches={resolveItemSwatches(modelSiblings.get(item.id))}
                  onOpenItem={onOpenItem}
                  onOpenTechSpecs={onOpenTechSpecs}
                  onNavigate={onNavigateToItem}
                />
              ))}
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
    </section>
  );
}
