import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const helper = stripTypeScriptTypes(readFileSync("src/lib/carousel/slide-interaction.ts", "utf8"));
const { syncSlideInteraction } = await import(`data:text/javascript;base64,${Buffer.from(helper).toString("base64")}`);
const gridSource = readFileSync("src/components/carousel/CarouselGrid.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");
const page = readFileSync("src/app/carousel/CarouselPageClient.tsx", "utf8");

function fixture(focusedPage = null) {
  const focus = {};
  const calls = [];
  const navigation = { focus: options => calls.push(options) };
  const grids = [6, 7, 8].map(index => ({
    inert: false,
    attributes: {},
    closest: () => ({ getAttribute: () => String(index) }),
    contains: element => element === focus && index === focusedPage,
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  }));
  const container = {
    ownerDocument: { activeElement: focus }, scrollLeft: -217,
    querySelectorAll: () => grids,
    closest: () => ({ querySelector: () => navigation }),
  };
  return { container, grids, calls };
}

test("only the settled active page can receive clicks or Tab focus", () => {
  const f = fixture();
  syncSlideInteraction(f.container, 7, false);
  assert.deepEqual(f.grids.map(g => g.inert), [true, false, true]);
  assert.deepEqual(f.grids.map(g => g.attributes["aria-hidden"]), ["true", undefined, "true"]);
  assert.equal(f.container.scrollLeft, 0);
});

test("every page is inert during motion and focus moves to external navigation without scroll", () => {
  const f = fixture(7);
  syncSlideInteraction(f.container, 8, true);
  assert.deepEqual(f.grids.map(g => g.inert), [true, true, true]);
  assert.deepEqual(f.calls, [{ preventScroll: true }]);
  syncSlideInteraction(f.container, 8, false);
  assert.deepEqual(f.grids.map(g => g.inert), [true, true, false]);
});

test("idle current-page focus stays intact, while a retired page loses focus before it is hidden", () => {
  const f = fixture(7);
  syncSlideInteraction(f.container, 7, false);
  assert.deepEqual(f.calls, []);
  syncSlideInteraction(f.container, 8, false);
  assert.deepEqual(f.calls, [{ preventScroll: true }]);
});

test("declarative and synchronous guards cover virtual pages, fast clicks, transitions and cancelled gestures", () => {
  assert.match(gridSource, /inert=\{pageIndex !== activeIndex \|\| isTransitioning\}/);
  assert.match(gridSource, /onClickCapture=/);
  assert.match(gridSource, /movingRef\.current \|\| swiperInstance\?\.animating/);
  assert.match(gridSource, /preventInteractionOnTransition=\{true\}/);
  assert.match(gridSource, /scrollOnFocus: false/);
  assert.match(gridSource, /onBeforeTransitionStart=/);
  assert.match(gridSource, /onTransitionEnd=/);
  assert.match(gridSource, /onSliderFirstMove=/);
  assert.match(gridSource, /onTouchEnd=/);
  assert.match(css, /\.catalog-carousel \.swiper \{[^}]*overflow: clip/s);
  assert.match(css, /\.catalog-carousel \.catalog-grid\[inert\] \{\s*pointer-events: none/);
});

test("closing a modal restores its connected active-page opener without native scrolling", () => {
  assert.match(page, /restoreOpener\(productOpener\.current\)/);
  assert.match(page, /restoreOpener\(specsOpener\.current\)/);
  assert.match(page, /if \(!selectedItem\) productOpener\.current/);
  assert.match(page, /opener\?\.isConnected && !opener\.closest\("\[inert\], \[aria-hidden='true'\]"\)/);
  assert.match(page, /opener\.focus\(\{ preventScroll: true \}\)/);
});
