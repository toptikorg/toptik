import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

// Owner decision 2026-09-29 (GAL-009 colour rule): a fixed colour table may
// stay, but only as a closed, documented allowlist that maps a FULL code or a
// FULL, exact value — no word splitting, no partial match, never on a title,
// sentence, description or other free text, no guessing, no external service;
// unknown colours keep the original value, flagged for review, and the
// original value is kept next to the Hebrew name.
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const dropImports = (source) => source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");

const NAMES_FILE = "src/lib/carousel/color-names.ts";
const namesSource = await read(NAMES_FILE);
const names = await moduleFrom(namesSource);

// colors.ts + its two runtime dependencies in one module, for behaviour tests.
const vendorDetect = dropImports(await read("src/lib/catalog-source/vendor-detect.ts"));
const colors = await moduleFrom(
  [dropImports(namesSource), vendorDetect, dropImports(await read("src/lib/carousel/colors.ts"))].join("\n"),
);

async function sourceFiles(dir) {
  const out = [];
  if (!existsSync(path.join(root, dir))) return out;
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await sourceFiles(rel));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const TABLES = {
  MANDARINA_COLOR_CODES: /^[0-9A-Z]{3}$/,
  BRICS_COLOR_BY_SKU: /^[A-Z]{2,4}\d{5}\.\d{3}$/,
  COLOR_VALUE_NAMES: /^[a-z]+(?: [a-z]+)*$/,
};

test("every colour mapping is an explicit allowlist entry with a documented source", () => {
  for (const [tableName, keyShape] of Object.entries(TABLES)) {
    const entries = Object.entries(names[tableName]);
    assert.ok(entries.length > 0, `${tableName} must not be empty`);
    for (const [key, entry] of entries) {
      assert.match(key, keyShape, `${tableName}["${key}"] must be a full code / full value key`);
      assert.match(entry.he, /^[֐-׿]+(?: [֐-׿]+)*$/, `${tableName}["${key}"] Hebrew name`);
      assert.ok(entry.hex === null || /^#[0-9a-f]{6}$/.test(entry.hex), `${tableName}["${key}"] hex`);
      assert.equal(typeof entry.source, "string");
      assert.ok(entry.source.length >= 40, `${tableName}["${key}"] needs a real source note`);
      assert.match(entry.source, /TopTik|bricstore\.com|huntleather\.com|mandarinaduck\.com/, `${tableName}["${key}"] source`);
    }
  }
});

test("a full code or a full, exact value is mapped — and the original is kept", () => {
  const cases = [
    [names.colorNameForMandarinaCode("465"), "פלדה", "465"],
    [names.colorNameForMandarinaCode(" 05j "), "צהוב", "05j"],
    [names.colorNameForBricsSku("BXL38124101"), "שחור", "BXL38124101"],
    [names.colorNameForBricsSku("bah08453.078"), "זית", "bah08453.078"],
    [names.colorNameForValue("Racing Yellow"), "צהוב רייסינג", "Racing Yellow"],
    [names.colorNameForValue("  Black "), "שחור", "Black"],
  ];
  for (const [result, hebrew, original] of cases) {
    assert.equal(result.name, hebrew);
    assert.equal(result.named, true);
    assert.equal(result.needsReview, false);
    assert.equal(result.sourceValue, original);
  }
});

test("no word splitting and no partial matching", () => {
  for (const value of ["Black Matte", "Matte Black", "Olive Green", "Navy Blue", "Blackish", "Blue Matte", "Shiny", "Racing", "Wool Caramel"]) {
    const result = names.colorNameForValue(value);
    assert.deepEqual(result, { name: value, hex: null, named: false, needsReview: true, sourceValue: value }, value);
  }
  for (const code of ["465X", "46", "A8", "P10JNV05465", "05J-TU"]) {
    assert.equal(names.colorNameForMandarinaCode(code).named, false, code);
    assert.equal(names.colorNameForMandarinaCode(code).name, code, code);
  }
  // A Bric's colour suffix alone, or on a collection it was not verified for,
  // is never enough: 001 is Black on Taormina but Black Matte on Porsche.
  for (const sku of ["001", "ORI05500.001", "BAH08452.022", "BXL58139.865", "BXL5814510"]) {
    assert.equal(names.colorNameForBricsSku(sku).named, false, sku);
    assert.equal(names.colorNameForBricsSku(sku).name, sku, sku);
  }
});

test("free text never passes through the colour table", () => {
  const freeText = [
    "Lightweight black polycarbonate shell with a blue lining.",
    "Expandable cabin trolley in olive",
    "טרולי Bric's Taormina מתרחב 55 ס״מ בצבע שחור",
    "<p>Black</p>",
    "Black, Olive",
    "black\nolive",
    "Bric's X-Travel Pilot Cabin Case - Black",
  ];
  for (const text of freeText) {
    for (const lookup of ["colorNameForValue", "colorNameForMandarinaCode", "colorNameForBricsSku"]) {
      const result = names[lookup](text);
      assert.equal(result.named, false, `${lookup}(${JSON.stringify(text)})`);
      assert.equal(result.name, text.trim(), `${lookup}(${JSON.stringify(text)}) keeps the original`);
      assert.equal(result.hex, null);
    }
  }
});

test("unknown colours keep the original value and are flagged for review", () => {
  assert.deepEqual(names.colorNameForMandarinaCode("24U"), { name: "24U", hex: null, named: false, needsReview: true, sourceValue: "24U" });
  for (const empty of [null, undefined, "", "   "]) {
    assert.deepEqual(names.colorNameForValue(empty), { name: "צבע", hex: null, named: false, needsReview: false, sourceValue: null });
  }
});

test("the colour table is local, closed and never split", () => {
  assert.doesNotMatch(namesSource, /^import\s/m, "no imports");
  assert.doesNotMatch(namesSource, /\bfetch\(|https?:\/\/|XMLHttpRequest/, "no network or external service");
  assert.doesNotMatch(namesSource, /\.split\(/, "never splits a value into words");
  assert.doesNotMatch(namesSource, /\.(includes|indexOf|startsWith|endsWith|search|match)\(/, "no partial matching");
});

test("callers never feed titles, descriptions or free text into the colour table", async () => {
  const offenders = [];
  for (const file of await sourceFiles("src")) {
    const source = await read(file);
    if (file !== NAMES_FILE && /\b(MANDARINA_COLOR_CODES|BRICS_COLOR_BY_SKU|COLOR_VALUE_NAMES|COLOR_HEBREW)\b/.test(source)) {
      offenders.push(`${file}: uses a colour table directly`);
    }
    for (const match of source.matchAll(/\b(colorNameFor\w+|resolveColorMetaForCatalog)\(([^)]*)\)/g)) {
      const [call, fnName, argument] = match;
      if (/^export function/.test(source.slice(source.lastIndexOf("\n", match.index) + 1, match.index + call.length))) continue;
      if (/title|description|body|text|label|sentence|extractColorWord/i.test(argument)) offenders.push(`${file}: ${call}`);
      if (fnName === "resolveColorMetaForCatalog" && argument.includes(",")) offenders.push(`${file}: ${call} (one argument only)`);
    }
  }
  assert.deepEqual(offenders, []);
  // Title colour detection (grouping only) carries no Hebrew and no name map.
  assert.doesNotMatch(await read("src/lib/carousel/color-groups.ts"), /[֐-׿]/);
});

test("gallery swatches are named from the catalog number, never from the title", () => {
  const item = (id, catalogNumber, title) => ({ id, catalogNumber, title, angles: [], coverImagePath: `/${id}.jpg` });
  const items = [
    item("b1", "BAH08453.001", "מזוודה Bric's Taormina בצבע שחור"),
    item("b2", "BAH08453.006", "מזוודה Bric's Taormina בצבע כחול"),
    item("b3", "BAH08453.078", "מזוודה Bric's Taormina בצבע זית"),
    item("p1", "ORI05500.909", "Porsche Design Roadster Shiny Black"),
    item("p2", "ORI05500.024", "Porsche Design Roadster Racing Yellow"),
    item("m1", "P10SZV24-05J-TU", "Logoduck+ Duck Yellow"),
    item("m2", "P10SZV24-A83-TU", "Logoduck+ Choco Ice"),
    item("u1", "P10ZJT06-24U-TU", "Active Lux Shopper Black"),
    item("u2", "P10ZJT06-465-TU", "Active Lux Shopper"),
  ];
  const swatches = colors.buildModelSiblingSwatches(items);
  const view = (id) => swatches.get(id).map((s) => [s.name, s.sourceValue, s.named]);
  assert.deepEqual(view("b1"), [["שחור", "BAH08453.001", true], ["כחול", "BAH08453.006", true], ["זית", "BAH08453.078", true]]);
  // The Mandarina table is never read for another brand (024 ≠ Mandarina "pirite").
  assert.deepEqual(view("p2"), [["שחור מבריק", "ORI05500.909", true], ["צהוב רייסינג", "ORI05500.024", true]]);
  assert.deepEqual(view("m1"), [["צהוב", "05J", true], ["שוקולד", "A83", true]]);
  // Unknown code: the original code is shown and flagged; "Black" in the title is ignored.
  assert.deepEqual(view("u1"), [["24U", "24U", false], ["פלדה", "465", true]]);
});

test("imports name colours by full value or code and keep the maker's value", () => {
  const variant = (colorWord, colorCode, catalogNumber, handle) => ({
    colorWord, colorCode, catalogNumber, handle, title: `t ${handle}`, sourceUrl: "u", coverImageUrl: "c", imageUrls: ["c"],
  });
  const gallery = new Map([["h1", ["/a.jpg"]], ["h2", ["/b.jpg"]], ["h3", ["/c.jpg"]]]);
  const brics = colors.toBricsCarouselColors(
    [variant("Racing Yellow", "024", "ORI05500.024", "h1"), variant("Anthracite Matte", "004", "ORI05500.004", "h2")],
    gallery,
  );
  assert.deepEqual(brics.map((c) => [c.name, c.sourceValue, c.hex]), [["צהוב רייסינג", "Racing Yellow", null], ["Anthracite Matte", "Anthracite Matte", null]]);
  // Mandarina: the colour word the scraper found in the page title is never the name.
  const mandarina = colors.toCarouselColors([variant("black", "24U", "P10ZJT06-24U-TU", "h3")], gallery);
  assert.deepEqual(mandarina.map((c) => [c.name, c.sourceValue]), [["24U", "24U"]]);
  // Shopify export / own colour: the title argument no longer exists.
  assert.equal(colors.resolveColorMetaForCatalog.length, 1);
  assert.equal(colors.resolveColorMetaForCatalog("KJ114001").named, false);
  // A non-Mandarina SKU whose suffix happens to be a Mandarina code is not named.
  assert.deepEqual(
    colors.resolveColorMetaForCatalog("ORI05500.465"),
    { name: "465", hex: null, named: false, needsReview: true, sourceValue: "465" },
  );
});
