"use client";

import { useState } from "react";
import type { CarouselItem } from "@/lib/carousel/types";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { CatalogCard } from "./CarouselGrid";

// Presentation only. The matching active item is selected by the server, so
// the image and exact Shopify link are present in the initial article HTML.
export function ArticleProductCard({ item }: { item: CarouselItem }) {
  const [hidden, setHidden] = useState(false);
  const purchaseUrl = purchaseUrlFor(item.catalogNumber);
  if (!purchaseUrl || hidden) return null;

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
