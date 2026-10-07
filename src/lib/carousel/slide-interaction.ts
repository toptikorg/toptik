/** Swiper transforms pages; they must never acquire a second native scroll offset.
 * Keep this synchronous with Swiper events, before React commits the next render.
 */
export function syncSlideInteraction(
  container: HTMLElement,
  activeIndex: number,
  moving: boolean,
) {
  const grids = container.querySelectorAll<HTMLElement>(".swiper-slide .catalog-grid");
  const focus = container.ownerDocument.activeElement;
  for (const grid of grids) {
    const slide = grid.closest<HTMLElement>(".swiper-slide");
    const index = Number(slide?.getAttribute("data-swiper-slide-index"));
    const blocked = moving || index !== activeIndex;
    // Move focus before hiding its old page, without scrolling either axis.
    if (blocked && focus && grid.contains(focus)) {
      const navigation = container.closest(".catalog-carousel")
        ?.querySelector<HTMLElement>(".carousel-navrow-btn:not(:disabled)");
      navigation?.focus({ preventScroll: true });
    }
    grid.inert = blocked;
    if (blocked) grid.setAttribute("aria-hidden", "true");
    else grid.removeAttribute("aria-hidden");
  }
  container.scrollLeft = 0;
}
