"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CarouselGrid } from "@/components/carousel/CarouselGrid";
import BrandPicker from "@/components/carousel/BrandPicker";
import { CategoryNav } from "@/components/carousel/CategoryNav";
import { ProductModal } from "@/components/carousel/ProductModal";
import { TechSpecsModal } from "@/components/carousel/TechSpecsModal";
import { AccessibilityWidget } from "@/components/AccessibilityWidget";
import { CarouselItem, CarouselPayload } from "@/lib/carousel/types";
import {
  CAROUSEL_UNAVAILABLE_MESSAGE,
  fallbackCarouselPayload,
  isUnavailableCarouselPayload,
} from "@/lib/carousel/fallback-data";
import { buildModelSiblingSwatches, resolveItemSwatches } from "@/lib/carousel/colors";
import {
  availableBrands,
  filterByBrand,
  parseBrandParam,
  publicCollectionItems,
  urlWithBrand,
} from "@/lib/carousel/brands";
import {
  CategoryKey,
  DEFAULT_CATEGORY,
  filterByCategory,
  parseCategoryParam,
} from "@/lib/carousel/categories";

export default function CarouselPageClient() {
  const [payload, setPayload] = useState<CarouselPayload>(fallbackCarouselPayload);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<CarouselItem | null>(null);
  const [techSpecsItem, setTechSpecsItem] = useState<CarouselItem | null>(null);
  const [requestedBrand, setRequestedBrand] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URL(window.location.href).searchParams.get("brand");
  });
  const [activeCategory, setActiveCategory] = useState<CategoryKey>(() => {
    if (typeof window === "undefined") return DEFAULT_CATEGORY;
    const param = new URL(window.location.href).searchParams.get("category");
    return parseCategoryParam(param);
  });

  const onChangeCategory = useCallback((key: CategoryKey) => {
    setActiveCategory(key);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (key === "all") url.searchParams.delete("category");
    else url.searchParams.set("category", key);
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  const onChangeBrand = useCallback((key: string) => {
    setRequestedBrand(key);
    setSelectedItem(null);
    setTechSpecsItem(null);
    window.history.replaceState(window.history.state, "", urlWithBrand(window.location.href, key));
  }, []);

  // GAL-027: the purchase button navigates to the store in the same tab. The
  // brand and category already live in the URL; this keeps the scroll position
  // too, so one Back drops the visitor exactly where they left the gallery.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `carousel-scroll:${window.location.search}`;
    const save = () => {
      try { sessionStorage.setItem(key, String(window.scrollY)); } catch { /* private mode */ }
    };
    window.addEventListener("pagehide", save);
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === "back_forward") {
      try {
        const saved = Number(sessionStorage.getItem(key));
        if (Number.isFinite(saved) && saved > 0) {
          requestAnimationFrame(() => window.scrollTo(0, saved));
        }
      } catch { /* private mode */ }
    }
    return () => window.removeEventListener("pagehide", save);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const params = new URL(window.location.href).searchParams;
      setRequestedBrand(params.get("brand"));
      setActiveCategory(parseCategoryParam(params.get("category")));
      setSelectedItem(null);
      setTechSpecsItem(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/carousel", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch carousel payload");
        return res.json();
      })
      .then((data: CarouselPayload) => {
        if (!data || !Array.isArray(data.items) || !data.settings) {
          throw new Error("Invalid carousel payload");
        }
        setPayload(data);

      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.warn("Carousel unavailable", error);
        setPayload(fallbackCarouselPayload);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, []);

  const modelSiblings = useMemo(() => buildModelSiblingSwatches(payload.items.filter(i => i.isActive)), [payload.items]);

  const activeItems = useMemo(() => {
    const deduped = new Map<string, CarouselItem>();
    payload.items
      .filter((item) => item.isActive)
      .sort(
        (a, b) =>
          a.displayOrder - b.displayOrder ||
          (a.catalogNumber ?? "").localeCompare(b.catalogNumber ?? "") ||
          a.title.localeCompare(b.title),
      )
      .forEach((item) => {
        const catalogKey = item.catalogNumber?.trim().toLowerCase();
        const signature =
          catalogKey && catalogKey.length > 0
            ? `catalog:${catalogKey}`
            : `${item.title.trim().toLowerCase()}|${item.coverImagePath.trim().toLowerCase()}`;
        const current = deduped.get(signature);
        if (!current) {
          deduped.set(signature, item);
          return;
        }

        // Prefer the richer record so imported multi-angle products win over stale single-angle duplicates.
        const currentAngleCount = current.angles.length;
        const nextAngleCount = item.angles.length;
        if (nextAngleCount > currentAngleCount) {
          deduped.set(signature, item);
        }
      });
    return publicCollectionItems([...deduped.values()]);
  }, [payload.items]);

  const brands = useMemo(() => availableBrands(activeItems), [activeItems]);
  const galleryUnavailable = isUnavailableCarouselPayload(payload);
  const activeBrand = parseBrandParam(requestedBrand, brands);
  const brandLabel = brands.find(brand => brand.key === activeBrand)?.label ?? "כל המותגים";

  const onOpenItem = useCallback((item: CarouselItem) => {
    const orderedAngles = [...item.angles].sort((a, b) => a.angleOrder - b.angleOrder);
    setSelectedItem({ ...item, angles: orderedAngles });
  }, []);

  // Clicking a colour swatch navigates to THAT colour's product (each colour is
  // its own catalog item). Opens/replaces the product modal with the target.
  const onNavigateToItem = useCallback(
    (id: string) => {
      const target = payload.items.find((i) => i.id === id);
      if (!target) return;
      const orderedAngles = [...target.angles].sort((a, b) => a.angleOrder - b.angleOrder);
      setSelectedItem({ ...target, angles: orderedAngles });
    },
    [payload.items],
  );

  const onCloseModal = useCallback(() => setSelectedItem(null), []);
  const onOpenTechSpecs = useCallback((item: CarouselItem) => setTechSpecsItem(item), []);
  const onCloseTechSpecs = useCallback(() => setTechSpecsItem(null), []);

  const visibleItems = useMemo(
    () => filterByCategory(filterByBrand(activeItems, activeBrand), activeCategory),
    [activeItems, activeBrand, activeCategory],
  );

  return (
    <main className="carousel-page" id="main-content">
      {/* Black-leather background — texture generated entirely by SVG filters
          (no image asset), with 5 stacked lighting/texture layers above a
          #070605 base. Sits behind all content. */}
      <svg width="0" height="0" className="leather-defs" aria-hidden="true">
        <filter id="leatherGrain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.5 0.5" numOctaves="3" seed="14" stitchTiles="stitch" result="noise" />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.1" result="alpha" />
          <feSpecularLighting in="noise" surfaceScale="4.2" specularConstant="0.9" specularExponent="14" lightingColor="#8a7d6c" result="spec">
            <feDistantLight azimuth="245" elevation="42" />
          </feSpecularLighting>
          <feDiffuseLighting in="noise" surfaceScale="4.0" diffuseConstant="1.15" lightingColor="#6a5e52" result="diff">
            <feDistantLight azimuth="245" elevation="42" />
          </feDiffuseLighting>
          <feComposite in="spec" in2="diff" operator="over" result="emboss" />
          <feComposite in="emboss" in2="alpha" operator="in" result="grain" />
        </filter>
        <filter id="leatherPores" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.5 1.5" numOctaves="1" seed="9" stitchTiles="stitch" result="n" />
          <feDiffuseLighting in="n" surfaceScale="2.0" diffuseConstant="1.1" lightingColor="#4a423a" result="e">
            <feDistantLight azimuth="245" elevation="55" />
          </feDiffuseLighting>
        </filter>
      </svg>
      <div className="carousel-leather-bg" aria-hidden="true">
        <div className="leather-layer leather-grain" />
        <div className="leather-layer leather-pores" />
        <div className="leather-layer leather-glow" />
        <div className="leather-layer leather-rake" />
        <div className="leather-layer leather-vignette" />
      </div>

      <Link
        href="/admin"
        className="carousel-admin-secret-zone"
        aria-label="כניסת אדמין"
      />
      <header className="carousel-header">
        <div className="carousel-title-block" id="brand-selection" tabIndex={-1}>
          <BrandPicker
            brands={brands}
            value={activeBrand}
            onChange={onChangeBrand}
            disabled={isLoading || galleryUnavailable}
          />
          <h1 className="collection-title">קולקציה <span>נבחרת</span></h1>
        </div>
        <div className="carousel-header-actions">
          <Link className="carousel-back-link" href="https://www.toptik.co.il/">
            חזרה לחנות
          </Link>
        </div>
      </header>

      <p className="carousel-showroom-note" dir="rtl">
        הגלריה של TopTik מאפשרת להכיר כל דגם, להשוות תמונות, זוויות ומידות, ולבחור בביטחון.
        <br />
        <span id="carousel-brand-help">לבחירת מותג, לחצו על שם המותג מעל הקולקציה</span>
      </p>

      {isLoading ? (
        <div className="carousel-loading" role="status" aria-live="polite"><h2>טוענים את המוצרים…</h2><p>אפשר להמתין כאן. הגלריה תופיע כשהטעינה תסתיים.</p></div>
      ) : galleryUnavailable ? (
        <div id="carousel-brand-results" className="carousel-loading carousel-brand-empty" role="status" dir="rtl">
          <p>{CAROUSEL_UNAVAILABLE_MESSAGE}</p>
          <button type="button" onClick={() => window.location.reload()}>ניסיון נוסף</button>
        </div>
      ) : (
        <div className="carousel-page-body" dir="rtl">
          <CategoryNav items={filterByBrand(activeItems, activeBrand)} active={activeCategory} onChange={onChangeCategory} />
          <div id="carousel-brand-results" className="carousel-brand-results">
            <p className="carousel-brand-status" role="status">
              {brandLabel}: {visibleItems.length} מוצרים בקטלוג בסינון הנבחר
            </p>
            {visibleItems.length > 0 ? (
              <CarouselGrid
                items={visibleItems}
                brandLabel={brandLabel}
                category={activeCategory}
                onOpenItem={onOpenItem}
                onOpenTechSpecs={onOpenTechSpecs}
                onNavigateToItem={onNavigateToItem}
              />
            ) : (
              <div className="carousel-brand-empty" role="status">
                <p>{activeItems.length === 0
                  ? "אין כרגע מוצרים להצגה בגלריה."
                  : `לא נמצאו מוצרים של ${brandLabel} בקטגוריה זו.`}</p>
                {activeCategory !== "all" && (
                  <button type="button" onClick={() => onChangeCategory("all")}>
                    הצגת כל המוצרים של {brandLabel}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <ProductModal
        key={selectedItem?.id ?? "none"}
        item={selectedItem}
        colors={selectedItem ? resolveItemSwatches(modelSiblings.get(selectedItem.id)) : []}
        onClose={onCloseModal}
        onOpenTechSpecs={onOpenTechSpecs}
        onNavigateToItem={onNavigateToItem}
      />

      <TechSpecsModal item={techSpecsItem} onClose={onCloseTechSpecs} />

      <AccessibilityWidget />
    </main>
  );
}
