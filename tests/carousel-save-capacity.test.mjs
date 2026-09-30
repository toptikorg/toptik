import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = (await readFile("src/lib/validation/carousel.ts", "utf8"))
  .replace('from "zod"', `from ${JSON.stringify(import.meta.resolve("zod"))}`);
const { adminCarouselPayloadSchema, MAX_CAROUSEL_ITEMS } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`,
);
const payload = (count) => ({
  settings: { autoplayMs: 6000, transitionMode: "curtain-fade" },
  items: Array.from({ length: count }, (_, index) => ({
    title: `Product ${index + 1}`, catalogNumber: `TEST-${index + 1}`,
    description: "Verified product description", displayOrder: index + 1,
    isActive: true, coverImagePath: `product-${index + 1}.webp`, angles: [],
  })),
});

test("full-catalog save accepts all 82 existing rows without truncating products or copy", () => {
  const input = payload(82);
  const saved = adminCarouselPayloadSchema.parse(input);
  assert.equal(saved.items.length, 82);
  assert.deepEqual(saved, input);
});

test("catalog growth is bounded independently of the 80-item import batch", async () => {
  assert.equal(MAX_CAROUSEL_ITEMS, 5000);
  assert.equal(adminCarouselPayloadSchema.parse(payload(MAX_CAROUSEL_ITEMS)).items.length, MAX_CAROUSEL_ITEMS);
  assert.equal(adminCarouselPayloadSchema.safeParse(payload(MAX_CAROUSEL_ITEMS + 1)).success, false);
  assert.equal(adminCarouselPayloadSchema.safeParse(payload(0)).success, false);
  const admin = await readFile("src/app/admin/page.tsx", "utf8");
  assert.match(admin, /const MAX_BATCH_ROWS = 80;/);
  const migration = await readFile("supabase/migrations/20260930_shopify_gallery_sync_inbox.sql", "utf8");
  assert.match(migration, /jsonb_array_length\(p_items\) > 5000/);
});
