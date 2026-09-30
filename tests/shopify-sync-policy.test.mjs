import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync("src/lib/shopify/sync-policy.ts", "utf8");
const { mergeVisibleProductCopy, isSyncReviewCode } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);

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

test("first binding copies a sole non-empty value but holds different existing values for review", () => {
  const gallery = { title: "Gallery title", description: "Gallery desc", seoTitle: "Gallery SEO", seoDescription: "Gallery snippet" };
  const shopify = { title: "Shop title", description: "Shop desc", seoTitle: null, seoDescription: "" };
  const merged = mergeVisibleProductCopy(gallery, shopify, null, "2026-09-30T10:00:00Z", "2026-09-30T10:00:00Z");
  assert.deepEqual(merged.copy, { ...shopify, seoTitle: "Gallery SEO", seoDescription: "Gallery snippet" });
  assert.deepEqual(merged.conflicts, [
    { field: "title", winner: "review" },
    { field: "description", winner: "review" },
  ]);
});

test("first binding never picks a winner when both sides have different existing SEO values", () => {
  const gallery = { ...base, seoTitle: "Gallery SEO" };
  const shopify = { ...base, seoTitle: "Shopify SEO" };
  const merged = mergeVisibleProductCopy(gallery, shopify, null, "2026-09-30T10:00:00Z", "2026-09-30T10:01:00Z");
  assert.equal(merged.copy.seoTitle, shopify.seoTitle);
  assert.deepEqual(merged.conflicts, [{ field: "seoTitle", winner: "review" }]);
});

test("invalid concurrent timestamps use Shopify deterministically", () => {
  const gallery = { ...base, title: "Gallery title" };
  const shopify = { ...base, title: "Shopify title" };
  const merged = mergeVisibleProductCopy(gallery, shopify, base, "bad timestamp", "also bad");
  assert.equal(merged.copy.title, shopify.title);
  assert.deepEqual(merged.conflicts, [{ field: "title", winner: "shopify" }]);
});

test("ambiguous identity and concurrent update codes are reviewable; transient API errors can retry", () => {
  assert.equal(isSyncReviewCode("SYNC_COPY_INITIAL_CONFLICT"), true);
  assert.equal(isSyncReviewCode("SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT"), true);
  assert.equal(isSyncReviewCode("SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS"), true);
  assert.equal(isSyncReviewCode("SYNC_COPY_CONCURRENT_UPDATE"), true);
  assert.equal(isSyncReviewCode("SHOPIFY_API_HTTP_429"), false);
});
