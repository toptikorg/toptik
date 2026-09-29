import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

// GAL-009: product text must never be machine-translated automatically —
// not on import, spec warm-up, save or sync. Manufacturer text is the fact
// source; reviewed professional Hebrew is the content layer.
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test("the import translation hook returns the source text unchanged", async () => {
  const { translateToHebrew } = await moduleFrom(await read("src/lib/catalog-source/translate.ts"));
  for (const input of ["Lightweight polycarbonate shell", "", null]) {
    assert.equal(await translateToHebrew(input), input);
  }
});

test("fetchProductDetails (import, warm-up, admin) never calls machine translation", async () => {
  const source = await read("src/lib/catalog-source/product-details.ts");
  const start = source.indexOf("export async function fetchProductDetails");
  assert.ok(start > 0);
  const body = source.slice(start);
  assert.doesNotMatch(body, /batchTranslateSpecs\(|translateOne\(|translate\.googleapis/);
});

test("no module calls the retained Google Translate helpers", async () => {
  const offenders = [];
  for (const file of await sourceFiles("src")) {
    const source = await read(file);
    for (const line of source.split("\n")) {
      const call = /\b(batchTranslateSpecs|translateOne)\(/.test(line);
      const definition = /^\s*async function (batchTranslateSpecs|translateOne)\(/.test(line);
      const internal = file.endsWith("product-details.ts") && /translateOne\(s\)/.test(line); // helper-to-helper only
      if (call && !definition && !internal) offenders.push(`${file}: ${line.trim()}`);
    }
    if (/translate\.googleapis/.test(source) && !file.endsWith("src/lib/catalog-source/product-details.ts")) {
      offenders.push(`${file}: Google Translate endpoint`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the admin translate endpoint stays retired", async () => {
  const route = await read("src/app/api/admin/translate/route.ts");
  assert.match(route, /status: 410/);
  assert.doesNotMatch(route, /\bfetch\(|translateToHebrew|translate\.googleapis/);
});
