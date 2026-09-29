import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const { descriptionWithoutCatalogNumber: clean } = await import(`data:text/javascript;base64,${Buffer.from(
  stripTypeScriptTypes(await read("src/lib/carousel/description.ts")),
).toString("base64")}`);

test("removes the reported repeated SKU clause, not the remaining manufacturer caveat", () => {
  const tail = "התמונות מאפשרות להתרשם מצורת הדגם. המפרט עדיין דורש אימות מול היצרן.";
  assert.equal(clean(`טרולי Smile & Go בגוון פלדה, מק״ט P10JNV05465. ${tail}`, "P10JNV05465"),
    `טרולי Smile & Go בגוון פלדה. ${tail}`);
});

test("recognizes case, catalog punctuation and the exact Mandarina TU size suffix", () => {
  assert.equal(clean("ביוטי קייס (מק״ט p10-oun01.a89-tu) עם רצועה.", "P10OUN01-A89-TU"), "ביוטי קייס עם רצועה.");
  assert.equal(clean("ביוטי קייס (P10OUN01A89) עם רצועה.", "P10OUN01-A89-TU"), "ביוטי קייס עם רצועה.");
  assert.equal(clean("ביוטי קייס (P10OUN01-A89-TU) עם רצועה.", "P10OUN01A89"), "ביוטי קייס עם רצועה.");
  assert.equal(clean("מספר קטלוגי: BXL58145.050. מזוודה בגובה 77 ס״מ.", "BXL58145050"), "מזוודה בגובה 77 ס״מ.");
  assert.equal(clean("SKU: KL974005. Intuo עם תא קדמי.", "KL974005"), "Intuo עם תא קדמי.");
});

test("does not remove other colours, longer identifiers, model names or dimensions", () => {
  const prose = "דגם MD20 M, במשקל 2.6 ק״ג ובמידות 55 × 40 × 23 ס״מ. דגמים P10OUN01-A92-TU, XP10OUN01A89, P10OUN01A89-99.";
  assert.equal(clean(prose, "P10OUN01-A89-TU"), prose);
  assert.equal(clean(prose, "MD20"), prose);
  assert.equal(clean("BXL58145.0509 לצד BXL58145.051", "BXL58145.050"), "BXL58145.0509 לצד BXL58145.051");
});

test("does not change descriptions without a separate usable catalog number", () => {
  const prose = "מק״ט P10JNV05465.  תיאור עם פיסוק קיים.";
  assert.equal(clean(prose, null), prose);
  assert.equal(clean(prose, ""), prose);
  assert.equal(clean(null, "P10JNV05465"), "");
});

test("every reviewed description is already free of its own catalog identifier", async () => {
  const entries = JSON.parse(await read("src/lib/carousel/reviewed-copy.json"));
  assert.equal(Object.keys(entries).length, 25);
  for (const [sku, entry] of Object.entries(entries)) {
    assert.equal(clean(entry.description, sku), entry.description, sku);
    assert.equal(clean(clean(entry.description, sku), sku), entry.description, `${sku} idempotent`);
  }
});
