import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";

// GAL-027: the purchase buttons must open the TopTik store in the SAME tab, so
// one browser Back returns to the gallery with its brand and category intact.
// The purchase URL, the Shopify variant IDs and the add-to-cart action stay
// exactly as they were.
const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

const BUTTONS = [
  { file: "src/components/carousel/CarouselGrid.tsx", className: "catalog-card-buy-btn" },
  { file: "src/components/carousel/ProductModal.tsx", className: "product-modal-buy-btn" },
];

// The opening <a ...> tag of a purchase button: from "<a" to the line that
// holds only its closing ">" (attribute values such as "=>" contain ">").
function openingTag(source, className) {
  const at = source.indexOf(`className="${className}"`);
  assert.ok(at > 0, `${className} must exist`);
  const start = source.lastIndexOf("<a", at);
  const close = /\n[ \t]*>\r?\n/.exec(source.slice(at));
  assert.ok(start >= 0 && close, `${className}: opening tag not found`);
  return source.slice(start, at + close.index + close[0].length);
}

async function purchaseLinksModule() {
  const source = await read("src/lib/carousel/purchase-links.ts");
  const json = await read("src/lib/carousel/samsonite-variants.json");
  const previewPackage = await read("src/lib/carousel/american-tourister-preview.json");
  const handles = await read("src/lib/carousel/shopify-product-handles.json");
  const vendorDetect = await read("src/lib/catalog-source/vendor-detect.ts");
  // Use the real normaliser, lifted out of its module unchanged.
  const normaliser = vendorDetect.match(/export function normalizeCatalogKey\([\s\S]*?\n\}/)?.[0];
  assert.ok(normaliser);
  const patched = source
    .replace(/import \{ normalizeCatalogKey \} from "@\/lib\/catalog-source\/vendor-detect";/, normaliser.replace(/^export /, ""))
    .replace(/import samsoniteVariantIds from "\.\/samsonite-variants\.json";/, `const samsoniteVariantIds = ${json};`)
    .replace(/import previewPackage from "\.\/american-tourister-preview\.json";/, `const previewPackage = ${previewPackage};`)
    .replace(/import productHandles from "\.\/shopify-product-handles\.json";/, `const productHandles = ${handles};`)
    .replace(/^const VARIANT_IDS/m, "export const VARIANT_IDS");
  assert.notEqual(patched, source);
  return moduleFrom(patched);
}

test("neither purchase button opens a new tab", async () => {
  for (const { file, className } of BUTTONS) {
    const tag = openingTag(await read(file), className);
    assert.match(tag, /href=\{purchaseUrl\}/, file);
    assert.doesNotMatch(tag, /target=/, `${file}: no target attribute (no new tab)`);
    assert.doesNotMatch(tag, /rel=/, `${file}: rel is not needed for a same-tab link`);
    // The click only stops the card/modal from reacting; it never navigates itself.
    assert.match(tag, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/, file);
    assert.doesNotMatch(tag, /preventDefault|window\.open|location/, file);
  }
});

test("the gallery never opens windows or popups for purchase", async () => {
  const files = ["src/app/carousel/CarouselPageClient.tsx"];
  for (const entry of await readdir(new URL("src/components/carousel/", root))) {
    if (/\.tsx?$/.test(entry)) files.push(`src/components/carousel/${entry}`);
  }
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /window\.open\(|target="_blank"|target=\{/, file);
  }
});

test("both buttons use the same purchaseUrlFor for the item's catalog number", async () => {
  for (const { file } of BUTTONS) {
    const source = await read(file);
    assert.match(source, /import \{ purchaseUrlFor \} from "@\/lib\/carousel\/purchase-links";/, file);
    assert.match(source, /const purchaseUrl = purchaseUrlFor\(item\.catalogNumber\);/, file);
  }
});

test("the purchase URL is the exact product page with the variant, never a cart permalink", async () => {
  const { purchaseUrlFor, VARIANT_IDS } = await purchaseLinksModule();
  const handles = JSON.parse(await read("src/lib/carousel/shopify-product-handles.json")).variants;
  const entries = Object.entries(VARIANT_IDS).sort(([a], [b]) => a.localeCompare(b));
  assert.equal(entries.length, 80);
  // Fingerprint of every catalog-key -> Shopify variant ID pair at a4e8002 (unchanged).
  assert.equal(
    createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    "11dd62344ae3420f6caeef07772c16c70f0cc7d5d562b94ed007f1af929ee191",
  );
  assert.equal(purchaseUrlFor("BAH08453.001"), "https://www.toptik.co.il/products/bah08453-001?variant=50083958980858");
  assert.equal(purchaseUrlFor("P10SZV24-A83-TU"), "https://www.toptik.co.il/products/p10szv24-a83-tu?variant=50083960389882");
  assert.equal(purchaseUrlFor("KJ114001"), "https://www.toptik.co.il/products/samsonite-upscape-55-climbing-ivy-kj114001?variant=50223212790010");
  assert.equal(purchaseUrlFor("KO701006"), "https://www.toptik.co.il/products/samsonite-urbify-68-navy-blue-ko701006?variant=50148829266170");
  assert.equal(purchaseUrlFor("UNKNOWN-SKU"), null);
  assert.equal(purchaseUrlFor(null), null);
  // Non-ASCII storefront handles are percent-encoded, never transliterated.
  assert.match(purchaseUrlFor("P10JNV05465"), /^https:\/\/www\.toptik\.co\.il\/products\/%[0-9A-F]{2}[^?]*\?variant=42624928415994$/);
  // Preview-only package: exact variant from the package, never a guess.
  assert.equal(
    purchaseUrlFor("4815-77TEAL LIME"),
    "https://www.toptik.co.il/products/american-tourister-deep-dive-teal-lime-4815-77teal-lime?variant=50148796629242",
  );
  assert.equal(purchaseUrlFor("MJ7014903"), null, "not in the Preview package (unverified maker spec)");
  for (const [key, variantId] of entries) {
    const url = purchaseUrlFor(key);
    assert.ok(url, `${key} must have a verified product page`);
    assert.equal(url, `https://www.toptik.co.il/products/${encodeURIComponent(handles[variantId].handle)}?variant=${variantId}`, key);
    assert.ok(url.endsWith(`?variant=${variantId}`), `${key}: exact variant id`);
    assert.doesNotMatch(url, /\/cart\/|:1$|checkout/, `${key}: no cart permalink`);
    assert.ok(url.startsWith("https://www.toptik.co.il/products/"), key);
  }
});

test("a variant without a verified handle gets no purchase link", async () => {
  const source = await read("src/lib/carousel/purchase-links.ts");
  assert.match(source, /!Object\.prototype\.hasOwnProperty\.call\(HANDLES, variantId\)\) return null;/);
  assert.doesNotMatch(source, /toptik\.co\.il\/cart\//, "no cart permalink anywhere in the module");
});

test("no source file builds a cart permalink or a checkout link", async () => {
  const found = [];
  const walk = async (dir) => {
    for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${e.name}`;
      if (e.isDirectory()) await walk(`${rel}/`);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
        const text = await read(rel);
        if (/toptik\.co\.il\/cart\/|\/cart\/\$\{|\/checkout\?/.test(text)) found.push(rel);
      }
    }
  };
  await walk("src/");
  assert.deepEqual(found, [], "no /cart/<variant>:<qty> or /checkout links in src");
});

test("the 1 NIS payment-test product is not in the gallery data or the purchase map", async () => {
  const handles = await read("src/lib/carousel/shopify-product-handles.json");
  assert.doesNotMatch(handles, /50214269616378|סליקה/);
  const { VARIANT_IDS } = await purchaseLinksModule();
  assert.ok(!Object.values(VARIANT_IDS).includes("50214269616378"));
});

test("brand and category are written to the gallery URL before leaving", async () => {
  const client = await read("src/app/carousel/CarouselPageClient.tsx");
  // Category: replaceState keeps the current history entry, now with ?category=.
  assert.match(client, /url\.searchParams\.set\("category", key\);\s*\n\s*window\.history\.replaceState\(window\.history\.state, "", url\.toString\(\)\);/);
  // Brand: replaceState with the brand parameter.
  assert.match(client, /window\.history\.replaceState\(window\.history\.state, "", urlWithBrand\(window\.location\.href, key\)\);/);
  // On return (fresh load or history navigation) both are read back from the URL.
  assert.match(client, /searchParams\.get\("brand"\)/);
  assert.match(client, /parseCategoryParam\(param\)/);
  assert.match(client, /addEventListener\("popstate", onPopState\)/);
  // Nothing in the gallery hijacks scroll restoration.
  assert.doesNotMatch(client, /scrollRestoration/);

  const brands = await read("src/lib/carousel/brands.ts");
  const urlWithBrand = brands.match(/export function urlWithBrand\([\s\S]*?\n\}/)?.[0];
  assert.ok(urlWithBrand);
  const { urlWithBrand: withBrand } = await moduleFrom(urlWithBrand);
  assert.equal(
    withBrand("https://landing.toptik.co.il/carousel?category=travel", "brics"),
    "https://landing.toptik.co.il/carousel?category=travel&brand=brics",
  );
  const categories = await read("src/lib/carousel/categories.ts");
  assert.match(categories, /export function parseCategoryParam/);
});
