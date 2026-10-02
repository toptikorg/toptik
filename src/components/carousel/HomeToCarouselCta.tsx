"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import catalogButton from "../../../images/cataloge_bottun.svg";
import { ShatterTransition } from "@/components/carousel/ShatterTransition";
import { TransitionMode } from "@/lib/carousel/types";

const catalogButtonUrl = typeof catalogButton === "string" ? catalogButton : catalogButton.src;

type HomeToCarouselCtaProps = {
  heroImageUrl: string;
};

export function HomeToCarouselCta({ heroImageUrl }: HomeToCarouselCtaProps) {
  const router = useRouter();
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionMode: TransitionMode = "shatter-particle";

  // Do not fetch every catalog image/spec on the home page: this competes
  // with mobile navigation. Product details load when requested.

  return (
    <>
      <button
        className="enter-catalog-btn"
        style={{ backgroundImage: `url(${catalogButtonUrl})` }}
        onClick={() => setIsTransitioning(true)}
        disabled={isTransitioning}
        aria-label="כניסה לגלריה"
      >
        <span className="catalog-svg-btn-text">כניסה לגלריה</span>
      </button>

      {isTransitioning && (
        <ShatterTransition
          imageUrl={heroImageUrl}
          mode={transitionMode}
          onComplete={() => {
            router.push("/carousel");
          }}
        />
      )}
    </>
  );
}
