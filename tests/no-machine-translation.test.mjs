import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

// GAL-009: product text must never be machine-translated — not Google Translate
// and not any other machine-translation service, not on import, sync, spec
// warm-up, product creation or admin save, and not even as a draft that is
// edited later. Manufacturer text is the fact source; reviewed professional
// Hebrew is the content layer.
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

async function sourceFiles(dir) {
  const out = [];
  if (!existsSync(path.join(root, dir))) return out;
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await sourceFiles(rel));
    else if (/\.(ts|tsx|js|mjs|cjs|sh|ps1|sql)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// The only file allowed to still contain the historical Google endpoint.
const DISABLED_HELPER_FILE = "src/lib/catalog-source/product-details.ts";
const MT_ENDPOINTS = /translate\.googleapis|translation\.googleapis|translate\.google\.|api(?:-free)?\.deepl\.com|api\.cognitive\.microsofttranslator|translate\.yandex|libretranslate|mymemory\.translated/i;
const MT_CALLS = /\b(batchTranslateSpecs|translateOne|translateToHebrew|translateText|autoTranslate)\s*\(/;
const MT_DEFINITION = /^\s*(export\s+)?async function (batchTranslateSpecs|translateOne|translateToHebrew)\(/;

test("the retired import hook returns the source text unchanged", async () => {
  const { translateToHebrew } = await moduleFrom(await read("src/lib/catalog-source/translate.ts"));
  for (const input of ["Lightweight polycarbonate shell", "", null]) {
    assert.equal(await translateToHebrew(input), input);
  }
});

test("disabled translation code is clearly marked as disabled", async () => {
  const hook = await read("src/lib/catalog-source/translate.ts");
  assert.match(hook, /DISABLED — GAL-009/);
  assert.doesNotMatch(hook, /\bfetch\(|googleapis/);
  const helpers = await read(DISABLED_HELPER_FILE);
  assert.match(helpers, /DISABLED: former Google Translate fallback \(GAL-009\)/);
  assert.match(helpers, /^const MACHINE_TRANSLATION_ENABLED = false;$/m);
  // The kill switch runs before the network call inside the helper.
  const body = helpers.slice(helpers.indexOf("async function translateOne("));
  const guardAt = body.indexOf("if (!MACHINE_TRANSLATION_ENABLED) return text;");
  const fetchAt = body.indexOf("await fetch(");
  assert.ok(guardAt > 0 && fetchAt > guardAt, "kill switch must precede the request");
});

test("fetchProductDetails (import, warm-up, admin) never calls machine translation", async () => {
  const source = await read(DISABLED_HELPER_FILE);
  const start = source.indexOf("export async function fetchProductDetails");
  assert.ok(start > 0);
  const end = source.indexOf("DISABLED: former Google Translate fallback");
  const body = end > start ? source.slice(start, end) : source.slice(start);
  assert.doesNotMatch(body, /batchTranslateSpecs\(|translateOne\(|translate\.googleapis/);
});

test("no source file calls a machine-translation helper or service", async () => {
  const files = [
    ...await sourceFiles("src"),
    ...await sourceFiles("scripts"),
    ...await sourceFiles("supabase"),
  ];
  assert.ok(files.length > 50, "expected the repository sources to be scanned");
  const offenders = [];
  for (const file of files) {
    const source = await read(file);
    source.split("\n").forEach((line, index) => {
      if (!MT_CALLS.test(line) || MT_DEFINITION.test(line)) return;
      // Only helper-to-helper use inside the disabled block is tolerated.
      if (file === DISABLED_HELPER_FILE && /translateOne\(s\)/.test(line)) return;
      offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
    if (MT_ENDPOINTS.test(source) && file !== DISABLED_HELPER_FILE) {
      offenders.push(`${file}: machine-translation endpoint`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("nothing imports the retired translation hook", async () => {
  const offenders = [];
  for (const file of await sourceFiles("src")) {
    const source = await read(file);
    if (/from\s+["'][^"']*catalog-source\/translate["']|import\(\s*["'][^"']*catalog-source\/translate["']/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test("import, sync, warm-up, product creation and admin save stay disconnected", async () => {
  const paths = [
    "src/lib/import/import-handler.ts",
    "src/lib/carousel/repository-admin.ts",
    "src/app/api/admin/carousel/route.ts",
    "src/app/api/admin/upload/route.ts",
    "src/app/api/admin/warm-colors/route.ts",
    "src/app/api/admin/warm-tech-specs/route.ts",
    "src/app/api/product-details/route.ts",
  ];
  for (const file of await sourceFiles("src/app/api/admin/import")) paths.push(file);
  for (const file of paths) {
    const source = await read(file);
    assert.doesNotMatch(source, /catalog-source\/translate|translateToHebrew|batchTranslateSpecs|translateOne|googleapis/, file);
  }
  const importer = await read("src/lib/import/import-handler.ts");
  assert.match(importer, /reviewedCopy\?\.description \|\|\s*\r?\n\s*sourceProduct\.description \|\|/);
});

test("the admin translate endpoint stays retired", async () => {
  const route = await read("src/app/api/admin/translate/route.ts");
  assert.match(route, /status: 410/);
  assert.doesNotMatch(route, /\bfetch\(|translateToHebrew|translate\.googleapis/);
  // The legacy editor button can only reach the retired endpoint.
  const editor = await read("src/app/admin/page.tsx");
  assert.doesNotMatch(editor, /googleapis|deepl/i);
  for (const match of editor.matchAll(/fetch\(\s*["'`]([^"'`]*translate[^"'`]*)["'`]/g)) {
    assert.equal(match[1], "/api/admin/translate");
  }
});
