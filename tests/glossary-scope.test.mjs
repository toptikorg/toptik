import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// GAL-009, owner decision 2026-09-29: a closed glossary may render predefined
// FIELD NAMES in Hebrew (Weight → משקל, Material → חומר, Volume → נפח,
// Dimensions → מידות). It must never convert descriptions, sentences, bullet
// lines, values, materials or colour names, never call an external service and
// never invent information.
const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

const FILE = "src/lib/catalog-source/product-details.ts";
const source = await read(FILE);

function block(pattern, label) {
  const found = source.match(pattern)?.[0];
  assert.ok(found, `${label} must exist in ${FILE}`);
  return found;
}
const fn = (name) => block(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`), name).trim();
const table = (name, close) => block(new RegExp(`\\nconst ${name}[^=]*= [\\[{][\\s\\S]*?\\n\\${close};`), name).trim();

test("only field names are glossary-mapped, from an explicit allowlist", async () => {
  const keys = table("KEY_TRANSLATIONS", "}");
  const { KEY_TRANSLATIONS } = await moduleFrom(keys.replace(/^const /, "export const "));
  const entries = Object.entries(KEY_TRANSLATIONS);
  assert.ok(entries.length > 0 && entries.length <= 40, "a short closed list");
  for (const [english, hebrew] of entries) {
    assert.match(english, /^[a-z]+(?: [a-z]+){0,2}$/, `"${english}" must be a field name, not a sentence`);
    assert.match(hebrew, /^[֐-׿׳"' ]+$/, `"${english}" → "${hebrew}" must be a Hebrew field label`);
  }
  for (const [english, hebrew] of [["weight", "משקל"], ["material", "חומר"], ["volume", "נפח"], ["dimensions", "מידות"]]) {
    assert.equal(KEY_TRANSLATIONS[english], hebrew);
  }
  // Unknown field names stay exactly as the maker wrote them.
  const { translateKey } = await moduleFrom(`${keys}\nexport ${fn("translateKey")}`);
  assert.equal(translateKey("Weight"), "משקל");
  assert.equal(translateKey("Wheel system"), "Wheel system");
});

test("the field-name glossary is applied only to field names", () => {
  const calls = [...source.matchAll(/translateKey\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length > 0);
  for (const argument of calls) {
    assert.ok(argument === "key" || argument === "label: string", `translateKey(${argument}) must receive the field key`);
  }
});

test("value and free-text maps are disabled", () => {
  assert.match(source, /^const VALUE_AND_FREE_TEXT_GLOSSARY_ENABLED = false;$/m);
  for (const name of ["translateValue", "translateLineItem", "translateColorName"]) {
    const body = fn(name);
    const firstStatement = body.split("\n")[1].trim();
    assert.match(firstStatement, /^if \(!VALUE_AND_FREE_TEXT_GLOSSARY_ENABLED\) return \w+\.trim\(\);$/, `${name} must stop first`);
  }
  assert.match(fn("extractMaterialWord"), /VALUE_AND_FREE_TEXT_GLOSSARY_ENABLED \? hebrew : match\[0\]/);
  assert.match(source, /VALUE_AND_FREE_TEXT_GLOSSARY_ENABLED \? LINE_TRANSLATIONS\[lower\] : LINE_TRANSLATIONS\[lower\] && raw\.trim\(\)/);
});

test("descriptions, sentences, values, materials and colours keep the maker's wording", async () => {
  const program = [
    "const VALUE_AND_FREE_TEXT_GLOSSARY_ENABLED = false;",
    table("LINE_TRANSLATIONS", "}"),
    table("NOUN_TRANSLATIONS", "]"),
    table("VALUE_PHRASE_TRANSLATIONS", "]"),
    table("MATERIAL_WORDS", "]"),
    table("COLOR_NAME_MAP", "}"),
    fn("translateValue"), fn("translateNouns"), fn("translateLineItem"),
    fn("translateColorName"), fn("extractMaterialWord"),
    "export { translateValue, translateLineItem, translateColorName, extractMaterialWord };",
  ].join("\n");
  const glossary = await moduleFrom(program);
  for (const text of [
    "Adjustable with sliding ring, 100% polyester",
    "Expandable hard-shell cabin trolley with 4 wheels",
    "Lightweight and durable, perfect for weekend trips.",
  ]) {
    assert.equal(glossary.translateValue(text), text);
  }
  for (const line of ["2 external front pockets with zippers", "Double compartment", "1 zip pocket"]) {
    assert.equal(glossary.translateLineItem(line), line);
  }
  assert.equal(glossary.translateColorName("Black"), "Black");
  assert.equal(glossary.translateColorName("Fire Red"), "Fire Red");
  assert.equal(glossary.extractMaterialWord("Shell in recycled polycarbonate"), "polycarbonate");
  assert.equal(glossary.extractMaterialWord("no material here"), null);
});

test("the glossary never calls an external service", () => {
  for (const name of ["translateKey", "translateValue", "translateLineItem", "translateNouns", "translateColorName", "extractMaterialWord"]) {
    assert.doesNotMatch(fn(name), /\bfetch\(|https?:\/\//, name);
  }
});
