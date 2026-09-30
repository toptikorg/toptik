import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl, descriptionHelpers } from "./helpers/description-module.mjs";

const source = readFileSync("src/lib/shopify/sync-policy.ts", "utf8").replace('"./description-document"', JSON.stringify(descriptionModuleUrl));
const { mergeVisibleProductCopy, isSyncReviewCode, visibleCopiesEquivalent } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);

const richCopy = html => ({ ...base, description: descriptionHelpers.descriptionTextFromHtml(html), descriptionHtml: html });

test("initial legacy text adopts Shopify rich structure without rewriting Shopify", () => {
  const shopify = richCopy('<p>Bag <a href="/products/bag">details</a></p><table><tr><td>55 cm</td></tr></table>');
  const gallery = { ...shopify, descriptionHtml: null };
  const merged = mergeVisibleProductCopy(gallery, shopify, null, "2026-09-30T10:00:00Z", "2026-09-30T10:00:00Z");
  assert.equal(merged.galleryCopy.descriptionHtml, shopify.descriptionHtml);
  assert.equal(merged.galleryChanged, true);
  assert.equal(merged.shopifyChanged, false);
});

test("a link target-only change syncs together with its unchanged visible text", () => {
  const baseline = richCopy('<p><a href="/old">Bag</a></p>');
  const changed = richCopy('<p><a href="/new">Bag</a></p>');
  assert.equal(changed.description, baseline.description);
  const fromGallery = mergeVisibleProductCopy(changed, baseline, baseline, "2026-09-30T10:01:00Z", "2026-09-30T10:00:00Z");
  assert.deepEqual(fromGallery.shopifyCopy, changed);
  const fromShopify = mergeVisibleProductCopy(baseline, changed, baseline, "2026-09-30T10:00:00Z", "2026-09-30T10:01:00Z");
  assert.deepEqual(fromShopify.galleryCopy, changed);
});

test("conflicting descriptions select one complete rich pair and never mix sources", () => {
  const baseline = richCopy('<p>Original</p>');
  const gallery = richCopy('<p>Gallery <a href="/gallery">link</a></p>');
  const shopify = richCopy('<table><tr><td>Shopify</td></tr></table>');
  const merged = mergeVisibleProductCopy(gallery, shopify, baseline, "2026-09-30T10:02:00Z", "2026-09-30T10:01:00Z");
  assert.deepEqual(merged.galleryCopy, gallery);
  assert.deepEqual(merged.shopifyCopy, gallery);
  assert.deepEqual(merged.conflicts, [{ field: "description", winner: "gallery" }]);
});

test("legacy baselines hydrate raw HTML without treating absent data as clearing", () => {
  const original = richCopy('<p><a href="/bag">Bag</a></p>');
  const oldBaseline = { ...original };
  delete oldBaseline.descriptionHtml;
  const merged = mergeVisibleProductCopy({ ...oldBaseline }, original, oldBaseline, "2026-09-30T10:00:00Z", "2026-09-30T10:00:00Z");
  assert.equal(merged.galleryCopy.descriptionHtml, original.descriptionHtml);
  assert.equal(merged.shopifyChanged, false);
  assert.deepEqual(merged.conflicts, []);
});

test("equivalent HTML serialization creates no echo and explicit empty HTML clears", () => {
  const original = richCopy('<p><a title="Info" href="/bag">Bag</a></p>');
  const normalized = richCopy('<p><a href="/bag" title="Info">Bag</a></p>');
  assert.equal(visibleCopiesEquivalent(original, normalized), true);
  const noop = mergeVisibleProductCopy(original, normalized, original, "2026-09-30T10:00:00Z", "2026-09-30T10:01:00Z");
  assert.equal(noop.shopifyChanged, false);
  assert.equal(noop.galleryChanged, false);
  const cleared = richCopy('');
  const merged = mergeVisibleProductCopy(cleared, original, original, "2026-09-30T10:02:00Z", "2026-09-30T10:00:00Z");
  assert.equal(merged.shopifyCopy.description, '');
  assert.equal(merged.shopifyCopy.descriptionHtml, '');
});

const base = { title: "Title 1", description: "Description 1", seoTitle: "SEO 1", seoDescription: "Snippet 1" };

test("one-sided changes sync field by field in either direction", () => {
  const gallery = { ...base, title: "Gallery title" };
  const shopify = { ...base, seoTitle: "Shopify SEO" };
  const merged = mergeVisibleProductCopy(gallery, shopify, base, "2026-09-30T10:02:00Z", "2026-09-30T10:01:00Z");
  assert.deepEqual(merged.copy, { ...base, title: "Gallery title", seoTitle: "Shopify SEO" });
  assert.equal(merged.shopifyChanged, true);
  assert.equal(merged.galleryChanged, true);
  assert.deepEqual(merged.conflicts, []);
});

test("disjoint changes on Gallery and Shopify merge without replacing either field", () => {
  const gallery = { ...base, description: "Gallery description" };
  const shopify = { ...base, seoDescription: "Shopify snippet" };
  const merged = mergeVisibleProductCopy(gallery, shopify, base, "2026-09-30T10:01:00Z", "2026-09-30T10:02:00Z");
  assert.deepEqual(merged.copy, { ...base, description: "Gallery description", seoDescription: "Shopify snippet" });
  assert.deepEqual(merged.conflicts, []);
});

test("simultaneous edits to one field use newest timestamp and preserve an audit conflict", () => {
  const gallery = { ...base, title: "New Gallery title" };
  const shopify = { ...base, title: "New Shopify title" };
  const galleryWins = mergeVisibleProductCopy(gallery, shopify, base, "2026-09-30T10:03:00Z", "2026-09-30T10:02:00Z");
  assert.equal(galleryWins.copy.title, gallery.title);
  assert.deepEqual(galleryWins.conflicts, [{ field: "title", winner: "gallery" }]);
  const tie = mergeVisibleProductCopy(gallery, shopify, base, "2026-09-30T10:03:00Z", "2026-09-30T10:03:00Z");
  assert.equal(tie.copy.title, shopify.title, "Shopify wins exact timestamp ties");
});

test("first binding fills blanks but preserves different existing values on each side", () => {
  const gallery = { title: "Gallery title", description: "Gallery desc", seoTitle: "Gallery SEO", seoDescription: "Gallery snippet" };
  const shopify = { title: "Shop title", description: "Shop desc", seoTitle: null, seoDescription: "" };
  const merged = mergeVisibleProductCopy(gallery, shopify, null, "2026-09-30T10:00:00Z", "2026-09-30T10:00:00Z");
  assert.deepEqual(merged.copy, { ...shopify, seoTitle: "Gallery SEO", seoDescription: "Gallery snippet" });
  assert.deepEqual(merged.shopifyCopy, { ...shopify, seoTitle: "Gallery SEO", seoDescription: "Gallery snippet" });
  assert.deepEqual(merged.galleryCopy, gallery);
  assert.equal(merged.shopifyChanged, true);
  assert.equal(merged.galleryChanged, false);
  assert.deepEqual(merged.conflicts, []);
});

test("a later Gallery edit propagates without replacing untouched historical Shopify differences", () => {
  const galleryBaseline = { ...base, title: "Gallery original" };
  const shopifyBaseline = { ...base, title: "Shopify original" };
  const gallery = { ...galleryBaseline, description: "New Gallery description" };
  const shopify = { ...shopifyBaseline };
  const merged = mergeVisibleProductCopy(
    gallery, shopify, null, "2026-09-30T10:02:00Z", "2026-09-30T10:01:00Z", galleryBaseline, shopifyBaseline,
  );
  assert.equal(merged.galleryCopy.title, "Gallery original");
  assert.equal(merged.shopifyCopy.title, "Shopify original");
  assert.equal(merged.galleryCopy.description, "New Gallery description");
  assert.equal(merged.shopifyCopy.description, "New Gallery description");
  assert.deepEqual(merged.conflicts, []);
});

test("a later Shopify edit propagates without replacing untouched historical Gallery differences", () => {
  const galleryBaseline = { ...base, title: "Gallery original" };
  const shopifyBaseline = { ...base, title: "Shopify original" };
  const gallery = { ...galleryBaseline };
  const shopify = { ...shopifyBaseline, seoDescription: "New Shopify snippet" };
  const merged = mergeVisibleProductCopy(
    gallery, shopify, null, "2026-09-30T10:01:00Z", "2026-09-30T10:02:00Z", galleryBaseline, shopifyBaseline,
  );
  assert.equal(merged.galleryCopy.title, "Gallery original");
  assert.equal(merged.shopifyCopy.title, "Shopify original");
  assert.equal(merged.galleryCopy.seoDescription, "New Shopify snippet");
  assert.equal(merged.shopifyCopy.seoDescription, "New Shopify snippet");
  assert.deepEqual(merged.conflicts, []);
});

test("first binding never picks a winner for different existing SEO values", () => {
  const gallery = { ...base, seoTitle: "Gallery SEO" };
  const shopify = { ...base, seoTitle: "Shopify SEO" };
  const merged = mergeVisibleProductCopy(gallery, shopify, null, "2026-09-30T10:00:00Z", "2026-09-30T10:01:00Z");
  assert.equal(merged.copy.seoTitle, shopify.seoTitle);
  assert.equal(merged.galleryCopy.seoTitle, gallery.seoTitle);
  assert.equal(merged.shopifyCopy.seoTitle, shopify.seoTitle);
  assert.deepEqual(merged.conflicts, []);
});

test("invalid concurrent timestamps use Shopify deterministically", () => {
  const gallery = { ...base, title: "Gallery title" };
  const shopify = { ...base, title: "Shopify title" };
  const merged = mergeVisibleProductCopy(gallery, shopify, base, "bad timestamp", "also bad");
  assert.equal(merged.copy.title, shopify.title);
  assert.deepEqual(merged.conflicts, [{ field: "title", winner: "shopify" }]);
});

test("ambiguous identity and concurrent update codes are reviewable; transient API errors can retry", () => {
  assert.equal(isSyncReviewCode("SYNC_CANARY_DELETE_DISABLED"), true);
  assert.equal(isSyncReviewCode("SYNC_CANARY_NOT_CONFIGURED"), true);
  assert.equal(isSyncReviewCode("SYNC_CANARY_VARIANT_AMBIGUOUS"), true);
  assert.equal(isSyncReviewCode("SYNC_SKU_OUTSIDE_CANARY"), true);
  assert.equal(isSyncReviewCode("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT"), true);
  assert.equal(isSyncReviewCode("SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS"), true);
  assert.equal(isSyncReviewCode("SYNC_COPY_CONCURRENT_UPDATE"), true);
  assert.equal(isSyncReviewCode("SHOPIFY_API_HTTP_429"), false);
});
