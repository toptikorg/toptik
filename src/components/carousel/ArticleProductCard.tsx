"use client";

import { useEffect, useState } from "react";
import type { CarouselPayload } from "@/lib/carousel/types";
import { CatalogCard } from "./CarouselGrid";

// Embeds the gallery's EXISTING product card inside editorial content, next to
// the paragraph that discusses that product. The item is located by an exact
// catalog-number match in the live gallery payload — the same data, image
// pipeline and "להמשך רכישה בחנות TopTik" button as the catalogue itself, so
// the store button always leads to the exact mapped Shopify variant. When the
// SKU has no exact active match, nothing is rendered (no guessed copies).
// Deliberately NO dialogs or popups here (interactive={false}): only the card
// and its store link, so nothing can be caught by popup-blocking extensions.

let payloadPromise: Promise<CarouselPayload | null> | null = null;
function loadPayload(): Promise<CarouselPayload | null> {
  payloadPromise ??= fetch("/api/carousel")
    .then((res) => (res.ok ? (res.json() as Promise<CarouselPayload>) : null))
    .catch(() => null);
  return payloadPromise;
}

export function ArticleProductCard({ sku }: { sku: string }) {
  const [payload, setPayload] = useState<CarouselPayload | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadPayload().then((data) => {
      if (!cancelled) setPayload(data);
    });
    return () => { cancelled = true; };
  }, []);

  const item = payload?.items.find((candidate) => candidate.isActive && candidate.catalogNumber === sku) ?? null;
  if (!item || hidden) return null;

  return (
    <div className="gallery-info-card">
      <CatalogCard
        item={item}
        swatches={[]}
        onOpenItem={() => {}}
        onOpenTechSpecs={() => {}}
        onNavigate={() => {}}
        onImageUnavailable={() => setHidden(true)}
        onImageReady={() => {}}
        interactive={false}
      />
    </div>
  );
}
