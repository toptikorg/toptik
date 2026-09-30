"use client";

import { useEffect, useState } from "react";
import { CarouselItem } from "@/lib/carousel/types";
import type { ProductDetails, SpecSection } from "@/lib/catalog-source/product-details";
import { mergeTypedSpecPresentation } from "@/lib/carousel/merge-typed-specs";

type TechSpecsModalProps = {
  item: CarouselItem | null;
  onClose: () => void;
};

type FetchState = "idle" | "loading" | "done" | "error";

// Module-level cache so repeated opens within the same session are instant.
const sessionCache = new Map<string, ProductDetails>();

export function TechSpecsModal({ item, onClose }: TechSpecsModalProps) {
  const [fetchedDetails, setFetchedDetails] = useState<ProductDetails | null>(null);
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);

  const url = item?.sourceUrl ?? null;
  // Synchronous sources (no setState needed): the item may carry pre-cached
  // tech specs from the carousel payload, or we may have the URL in the
  // session cache from a prior open.
  const cachedTechSpecs = (item?.techSpecs ?? null) as ProductDetails | null;
  const sessionHit = url ? sessionCache.get(url) ?? null : null;
  const synchronousDetails = cachedTechSpecs ?? sessionHit;

  useEffect(() => {
    if (!url || synchronousDetails) return;

    const controller = new AbortController();
    fetch(`/api/product-details?url=${encodeURIComponent(url)}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: ProductDetails) => {
        sessionCache.set(url, data);
        setFetchedDetails(data);
        setFetchFailed(false);
        setFetchedUrl(url);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setFetchFailed(true);
          setFetchedUrl(url);
        }
      });

    return () => controller.abort();
  }, [url, synchronousDetails]);

  const legacyDetails = synchronousDetails ?? (fetchedUrl === url ? fetchedDetails : null);
  const details = legacyDetails ? mergeTypedSpecPresentation(legacyDetails, item?.typedSpecsOverlay) : null;

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  let displayState: FetchState;
  let displayDetails: ProductDetails | null = null;
  if (details) {
    displayState = "done";
    displayDetails = details;
  } else if (!url) {
    displayState = "done";
    displayDetails = mergeTypedSpecPresentation({ specs: [], colors: [] }, item.typedSpecsOverlay);
  } else if (fetchFailed && fetchedUrl === url) {
    displayState = "error";
  } else {
    displayState = "loading";
  }

  return (
    <div
      className="tech-specs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`פרטים טכניים — ${item.title}`}
      onClick={onClose}
    >
      <div className="tech-specs-modal" onClick={(e) => e.stopPropagation()}>
        <button className="tech-specs-close" onClick={onClose} aria-label="סגור">✕</button>

        <h2 className="tech-specs-title">פרטים טכניים</h2>
        {item.catalogNumber && (
          <div className="tech-specs-catalog">דגם {item.catalogNumber}</div>
        )}

        {displayState === "loading" && (
          <div className="tech-specs-loading">טוען נתונים...</div>
        )}

        {displayState === "error" && (
          <div className="tech-specs-error">לא ניתן לטעון פרטים כרגע</div>
        )}

        {displayState === "done" && displayDetails && (
          <>
            {displayDetails.specs.length === 0 && (
              <div className="tech-specs-empty">לא נמצאו פרטים טכניים למוצר זה</div>
            )}
            {displayDetails.specs.map((section: SpecSection, i: number) => (
              <div key={i} className="tech-specs-section">
                <div className="tech-specs-section-heading">{section.heading}</div>
                <ul className="tech-specs-list">
                  {section.items.map((specItem, j) => (
                    <li key={j} className="tech-specs-item">
                      {specItem.value ? (
                        <>
                          <span className="tech-specs-item-label">{specItem.label}</span>
                          <span className="tech-specs-item-value">{specItem.value}</span>
                        </>
                      ) : (
                        <span className="tech-specs-item-full">{specItem.label}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
