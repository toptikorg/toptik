import type { CarouselPayload } from "./types";

export const CAROUSEL_UNAVAILABLE_MESSAGE = "הגלריה אינה זמינה כרגע. אפשר לנסות שוב בעוד זמן קצר.";

export function isUnavailableCarouselPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null &&
    "unavailable" in payload && payload.unavailable === true;
}

// Missing data is not a substitute catalog. The marker survives JSON transport
// so clients distinguish a failed read from a genuinely empty successful read.
export const fallbackCarouselPayload: CarouselPayload & { unavailable: true } = {
  unavailable: true,
  items: [],
  settings: {
    autoplayMs: 3500,
    transitionMode: "shatter-particle",
  },
};
