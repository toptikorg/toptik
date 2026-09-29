import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// GAL-028: the gallery's search and share metadata (title, description,
// canonical, Open Graph, Twitter card) uses the owner-approved copy, a real
// TopTik share image, and keeps the noindex, follow hold.
const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

async function metadataOf(file) {
  const source = await read(file);
  const block = source.match(/export const metadata: Metadata = \{[\s\S]*?\n\};/)?.[0];
  assert.ok(block, `${file} must export metadata`);
  return (await moduleFrom(block)).metadata;
}

const APPROVED = {
  seoTitle: "אולם התצוגה של TopTik | מזוודות, טרולי ותיקי נסיעות",
  metaDescription:
    "ברוכים הבאים לאולם התצוגה של TopTik. הגדילו תמונות, עברו בין זוויות והכירו מזוודות, טרולי ותיקי נסיעות לפני שתמשיכו לרכישה באתר TopTik.",
  shareTitle: "ברוכים הבאים לאולם התצוגה של TopTik",
  shareDescription:
    "הגדילו תמונות, עברו בין זוויות והכירו מזוודות, טרולי ותיקי נסיעות לפני שתמשיכו לרכישה באתר TopTik.",
};
const OLD_TITLE = /Move in Style|Travel with Purpose|TopTik Collection/;
const WRONG_PHRASE = "דף נחיתה רשמי";
const SHARE_IMAGE = "/og/toptik-showroom-1200x630.jpg";

test("/carousel has its own metadata with the approved copy", async () => {
  const meta = await metadataOf("src/app/carousel/page.tsx");
  assert.deepEqual(meta.title, { absolute: APPROVED.seoTitle });
  assert.equal(meta.description, APPROVED.metaDescription);
  assert.equal(meta.openGraph.title, APPROVED.shareTitle);
  assert.equal(meta.openGraph.description, APPROVED.shareDescription);
  assert.equal(meta.twitter.title, APPROVED.shareTitle);
  assert.equal(meta.twitter.description, APPROVED.shareDescription);
});

test("Open Graph and Twitter Card are complete and point at the canonical gallery", async () => {
  const meta = await metadataOf("src/app/carousel/page.tsx");
  const rootMeta = await metadataOf("src/app/layout.tsx");
  const base = rootMeta.metadataBase;
  assert.equal(base.href, "https://landing.toptik.co.il/");
  assert.equal(new URL(meta.alternates.canonical, base).href, "https://landing.toptik.co.il/carousel");
  assert.equal(new URL(meta.openGraph.url, base).href, "https://landing.toptik.co.il/carousel");
  assert.doesNotMatch(JSON.stringify(meta), /toptik\.co\.il\/(?:products|cart|collections)|myshopify/);
  assert.equal(meta.openGraph.type, "website");
  assert.equal(meta.openGraph.locale, "he_IL");
  assert.equal(meta.openGraph.siteName, "TopTik");
  assert.equal(meta.openGraph.images.length, 1);
  const [image] = meta.openGraph.images;
  assert.equal(image.url, SHARE_IMAGE);
  assert.equal(new URL(image.url, base).href, "https://landing.toptik.co.il/og/toptik-showroom-1200x630.jpg");
  assert.equal(image.width, 1200);
  assert.equal(image.height, 630);
  assert.equal(image.type, "image/jpeg");
  assert.ok(image.alt && image.alt.includes("TopTik"));
  assert.equal(meta.twitter.card, "summary_large_image");
  assert.equal(meta.twitter.images[0].url, SHARE_IMAGE);
});

test("the noindex, follow hold stays on the gallery and the admin panel", async () => {
  assert.deepEqual((await metadataOf("src/app/carousel/page.tsx")).robots, { index: false, follow: true });
  assert.deepEqual((await metadataOf("src/app/layout.tsx")).robots, { index: false, follow: true });
  assert.deepEqual((await metadataOf("src/app/(panel)/layout.tsx")).robots, { index: false, follow: false });
});

test("the wrong phrase and the old English title are gone", async () => {
  const rootMeta = await metadataOf("src/app/layout.tsx");
  const carouselMeta = await metadataOf("src/app/carousel/page.tsx");
  for (const meta of [rootMeta, carouselMeta]) {
    const text = JSON.stringify(meta);
    assert.ok(!text.includes(WRONG_PHRASE), "no 'דף נחיתה רשמי'");
    assert.doesNotMatch(text, OLD_TITLE);
  }
  for (const file of ["src/app/carousel/page.tsx", "src/app/carousel/CarouselPageClient.tsx"]) {
    const source = await read(file);
    assert.ok(!source.includes(WRONG_PHRASE), file);
    assert.doesNotMatch(source, OLD_TITLE, file);
  }
});

test("'לאולם' appears at most once in each title and description", async () => {
  const meta = await metadataOf("src/app/carousel/page.tsx");
  for (const value of [
    meta.title.absolute, meta.description, meta.openGraph.title, meta.openGraph.description,
    meta.twitter.title, meta.twitter.description,
  ]) {
    assert.ok((value.match(/לאולם/g) ?? []).length <= 1, value);
  }
});

function jpegSize(buffer) {
  assert.equal(buffer.readUInt16BE(0), 0xffd8, "JPEG signature");
  let offset = 2;
  while (offset < buffer.length) {
    const marker = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xffc0, 0xffc1, 0xffc2].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("no JPEG frame header");
}

test("the share image is a real 1200x630 JPEG small enough for chat previews", async () => {
  const path = new URL(`public${SHARE_IMAGE}`, root);
  const buffer = await readFile(path);
  assert.deepEqual(jpegSize(buffer), { width: 1200, height: 630 });
  assert.ok((await stat(path)).size < 300 * 1024, "keep under 300 KB for WhatsApp previews");
  const provenance = await read("docs/OG-SHARE-IMAGE.md");
  for (const sku of ["BAH08453.001", "P10GXV24A32", "KO701007", "P10JNV05465", "KJ114001"]) {
    assert.ok(provenance.includes(sku), `provenance lists ${sku}`);
  }
});
