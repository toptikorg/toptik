"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { CarouselItem } from "@/lib/carousel/types";
import {
  decodeProductImage,
  firstDecodedProductImage,
  productImageCandidates,
  productImageIdentity,
  type ProductImageCandidate,
} from "@/lib/carousel/product-image";

export type ProductImageState = "loading" | "ready" | "unavailable";

type Props = {
  item: CarouselItem;
  preferredSrc?: string;
  width: number;
  className: string;
  onStateChange?: (state: ProductImageState) => void;
  onResolved?: (originalSrc: string) => void;
};

type Frame = ProductImageCandidate & { owner: string };

export function ReliableProductImage({
  item, preferredSrc, width, className, onStateChange, onResolved,
}: Props) {
  const owner = productImageIdentity(item);
  const [frame, setFrame] = useState<Frame | null>(null);
  const lastDecoded = useRef<Frame | null>(null);
  const [failed, setFailed] = useState<{ owner: string; urls: string[] } | null>(null);
  const callbacks = useRef({ onStateChange, onResolved });
  useEffect(() => { callbacks.current = { onStateChange, onResolved }; }, [onStateChange, onResolved]);

  const candidates = productImageCandidates(item, preferredSrc, width)
    .filter(({ src }) => failed?.owner !== owner || !failed.urls.includes(src));
  const requestKey = JSON.stringify({ owner, candidates });

  useEffect(() => {
    const request = JSON.parse(requestKey) as { owner: string; candidates: ProductImageCandidate[] };
    const controller = new AbortController();
    // Angle changes retain only this exact item's last decoded frame. A new SKU
    // or changed media list cannot flash the previous item's picture.
    if (lastDecoded.current?.owner !== request.owner) callbacks.current.onStateChange?.("loading");
    void firstDecodedProductImage(request.candidates, decodeProductImage, controller.signal)
      .then((candidate) => {
        if (controller.signal.aborted) return;
        if (candidate) {
          const nextFrame = { ...candidate, owner: request.owner };
          lastDecoded.current = nextFrame;
          setFrame(nextFrame);
          callbacks.current.onResolved?.(candidate.originalSrc);
          callbacks.current.onStateChange?.("ready");
        } else {
          callbacks.current.onStateChange?.(
            lastDecoded.current?.owner === request.owner ? "ready" : "unavailable",
          );
        }
      })
      .catch(() => { /* Effect cleanup cancels stale loads; it is not an image failure. */ });
    return () => controller.abort();
  }, [requestKey]);

  const visibleFrame = frame?.owner === owner ? frame : null;
  const src = visibleFrame?.src ?? candidates[0]?.src;
  if (!src) return null;
  return (
    <Image
      src={src}
      alt={visibleFrame ? item.title : ""}
      width={width}
      height={width}
      unoptimized
      loading="eager"
      className={className}
      style={{ visibility: visibleFrame ? undefined : "hidden" }}
      aria-hidden={!visibleFrame || undefined}
      onError={() => {
        // Defend against a second display request failing after a successful
        // probe. Do not retry that URL or leave a broken image visible.
        if (!visibleFrame) return;
        lastDecoded.current = null;
        setFrame(null);
        setFailed((previous) => ({
          owner,
          urls: [...(previous?.owner === owner ? previous.urls : []), visibleFrame.src],
        }));
        callbacks.current.onStateChange?.("loading");
      }}
    />
  );
}
