"use client";

import { useState } from "react";
import type { CarouselItem } from "@/lib/carousel/types";
import { purchaseUrlFor } from "@/lib/carousel/purchase-links";
import { CatalogCard } from "./CarouselGrid";

// Presentation only. The matching active item is selected by the server, so
// the image and exact Shopify link are present in the initial article HTML.
export function ArticleProductCard({ item }: { item: CarouselItem }) {
  const [hidden, setHidden] = useState(false);
  const purchaseUrl = purchaseUrlFor(item.catalogNumber, item.shopifyLink);
  if (!purchaseUrl) return null;
  // The server has already verified this exact active product. An image
  // failure must not erase its otherwise valid editorial purchase link.
  if (hidden) return <a className="journal-product-text-link" data-product-name={item.title} href={purchaseUrl}>לפרטי {item.title} בחנות TopTik</a>;

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
