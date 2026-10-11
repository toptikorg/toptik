import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("src/lib/carousel/round-price.ts", root), "utf8");
const { roundUpToWholeShekel } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

test("fractional prices round up to the next whole shekel", () => {
  assert.equal(roundUpToWholeShekel(947.52), 948);
  assert.equal(roundUpToWholeShekel(1209.6), 1210);
  assert.equal(roundUpToWholeShekel(1391.04), 1392);
  assert.equal(roundUpToWholeShekel(100.01), 101);
  assert.equal(roundUpToWholeShekel(100.99), 101);
});

test("already-whole prices are unchanged, including float noise", () => {
  assert.equal(roundUpToWholeShekel(1690), 1690);
  assert.equal(roundUpToWholeShekel(1690.0000000001), 1690);
  assert.equal(roundUpToWholeShekel(0), 0);
});

test("shopify export applies the rounding to the supplier price column", async () => {
  const exportSource = await readFile(new URL("src/lib/carousel/shopify-export.ts", root), "utf8");
  assert.match(exportSource, /Price: supplier \? roundUpToWholeShekel\(supplier\.price\)/);
  assert.match(exportSource, /from "\.\/round-price"/);
});
