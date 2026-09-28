"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CarouselGrid } from "@/components/carousel/CarouselGrid";
import { CategoryNav } from "@/components/carousel/CategoryNav";
import { ProductModal } from "@/components/carousel/ProductModal";
import { TechSpecsModal } from "@/components/carousel/TechSpecsModal";
import { AccessibilityWidget } from "@/components/AccessibilityWidget";
import { CarouselItem, CarouselPayload } from "@/lib/carousel/types";
import { fallbackCarouselPayload } from "@/lib/carousel/fallback-data";
import { buildModelSiblingSwatches, resolveItemSwatches } from "@/lib/carousel/colors";
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
    window.history.replaceState({}, "", url.toString());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/carousel", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch carousel payload");
        return res.json();
      })
      .then((data: CarouselPayload) => {
        setPayload(data);
        // Fallback warming: most visitors arrive via the landing page which
        // already pre-warms. This catches deep-link visits to /carousel.
        const cold = data.items
          .filter((it) => it.isActive && it.sourceUrl && !it.techSpecs)
          .map((it) => it.sourceUrl!);
        if (cold.length > 0) {
          void Promise.all(
            cold.map((url) =>
              fetch(`/api/product-details?url=${encodeURIComponent(url)}`, {
                signal: controller.signal,
              }).catch(() => {}),
            ),
          );
        }
      })
      .catch((error) => {
        console.warn("Using fallback carousel payload", error);
      })
      .finally(() => setIsLoading(false));

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
    return [...deduped.values()];
  }, [payload.items]);

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
    () => filterByCategory(activeItems, activeCategory),
    [activeItems, activeCategory],
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
        <div className="carousel-title-block">
          <div className="brand-wordmark">MANDARINA DUCK</div>
          <h1 className="collection-title">קולקציה <span>נבחרת</span></h1>
        </div>
        <div className="carousel-header-actions">
          <Link className="carousel-back-link" href="/">
            חזרה לדף הבית
          </Link>
        </div>
      </header>

      <p className="carousel-showroom-note" dir="rtl">
        גלריית המוצרים של TopTik. לצפייה במחיר ולהשלמת הרכישה, עוברים לחנות.
      </p>

      {isLoading ? (
        <div className="carousel-loading">טוען מוצרים...</div>
      ) : (
        <div className="carousel-page-body" dir="rtl">
          <CategoryNav active={activeCategory} onChange={onChangeCategory} />
          <CarouselGrid
            items={visibleItems}
            autoplayMs={payload.settings.autoplayMs}
            onOpenItem={onOpenItem}
            onOpenTechSpecs={onOpenTechSpecs}
            onNavigateToItem={onNavigateToItem}
          />
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
