import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl } from "./helpers/description-module.mjs";

let source = await readFile("src/lib/shopify/admin-api.ts", "utf8");
source = source.replace(/^import "server-only";\s*/m, "");
source = source.replace(/^import \{ createShopifyClientCredentialsProvider \} from "\.\/client-credentials";\s*/m, "");
source = source.replace('"./description-document"', JSON.stringify(descriptionModuleUrl));
const { galleryTextToShopifyHtml, shopifyHtmlToGalleryText, buildShopifyVisibleCopyInput, visibleCopyFromProduct } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);

test("plain Gallery paragraphs round-trip through safe Shopify HTML", () => {
  const original = "כותרת <בטוחה> & מוצר\nשורה שנייה\n\nפסקה נוספת";
  const html = galleryTextToShopifyHtml(original);
  assert.equal(html, "<p>כותרת &lt;בטוחה&gt; &amp; מוצר<br>שורה שנייה</p><p>פסקה נוספת</p>");
  assert.equal(shopifyHtmlToGalleryText(html), original);
});

test("Shopify markup becomes readable text and unsafe/non-content tags are removed", () => {
  assert.equal(
    shopifyHtmlToGalleryText("<p>אחד&nbsp;&amp; שתיים</p><ul><li>שלוש</li><li>ארבע</li></ul><script>secret()</script>"),
    "אחד & שתיים\n\nשלוש\nארבע",
  );
});

test("Shopify product update is limited to visible title, description and SEO copy", () => {
  const input = buildShopifyVisibleCopyInput("gid://shopify/Product/123", {
    title: "Title", description: "Description", seoTitle: "SEO", seoDescription: "Snippet",
  }, {
    id: "gid://shopify/Product/123", title: "Old title", descriptionHtml: "<p>Old description</p>",
    seoTitle: null, seoDescription: null,
  });
  assert.deepEqual(input, {
    id: "gid://shopify/Product/123", title: "Title", descriptionHtml: "<p>Description</p>",
    seo: { title: "SEO", description: "Snippet" },
  });
  for (const protectedField of ["price", "inventory", "status", "handle", "variants", "vendor", "images"]) {
    assert.equal(Object.hasOwn(input, protectedField), false);
  }
});

const richProduct = {
  id: "gid://shopify/Product/123", title: "Product",
  descriptionHtml: '<h2>Details</h2><p>Visit <a href="/collections/bags">bags</a>.</p><table><tr><td>55 cm</td></tr></table>',
  seoTitle: "SEO title", seoDescription: "SEO description",
};

test("title-only and SEO-only edits never rewrite Shopify rich HTML or untouched copy", () => {
  const copy = visibleCopyFromProduct(richProduct);
  assert.deepEqual(buildShopifyVisibleCopyInput(richProduct.id, { ...copy, title: "Updated" }, richProduct), {
    id: richProduct.id, title: "Updated",
  });
  assert.deepEqual(buildShopifyVisibleCopyInput(richProduct.id, { ...copy, seoTitle: "New SEO" }, richProduct), {
    id: richProduct.id, seo: { title: "New SEO" },
  });
  assert.deepEqual(buildShopifyVisibleCopyInput(richProduct.id, { ...copy, seoDescription: null }, richProduct), {
    id: richProduct.id, seo: { description: null },
  });
});

test("unchanged copy is a no-op, and description edits patch only descriptionHtml", () => {
  const copy = visibleCopyFromProduct(richProduct);
  assert.deepEqual(buildShopifyVisibleCopyInput(richProduct.id, copy, richProduct), { id: richProduct.id });
  assert.deepEqual(buildShopifyVisibleCopyInput(richProduct.id, { ...copy, description: "New <text>", descriptionHtml: "<p>New &lt;text&gt;</p>" }, richProduct), {
    id: richProduct.id, descriptionHtml: "<p>New &lt;text&gt;</p>",
  });
});

test("a snapshot for another product cannot authorize a copy patch", () => {
  assert.throws(() => buildShopifyVisibleCopyInput("gid://shopify/Product/999", visibleCopyFromProduct(richProduct), richProduct),
    /SYNC_SHOPIFY_PRODUCT_IDENTITY_CONFLICT/);
});

test("editing a rich description preserves links and tables in the Shopify patch", () => {
  const html = richProduct.descriptionHtml.replace("Visit", "Explore");
  const changed = { ...visibleCopyFromProduct(richProduct), description: shopifyHtmlToGalleryText(html), descriptionHtml: html };
  assert.deepEqual(buildShopifyVisibleCopyInput(richProduct.id, changed, richProduct), { id: richProduct.id, descriptionHtml: html });
  assert.match(html, /<table>/);
  assert.match(html, /href="\/collections\/bags"/);
});

test("format-only HTML changes are written, while mismatched text/HTML is refused", () => {
  const html = richProduct.descriptionHtml.replace('<h2>', '<h3>').replace('</h2>', '</h3>');
  const copy = { ...visibleCopyFromProduct(richProduct), descriptionHtml: html };
  assert.deepEqual(buildShopifyVisibleCopyInput(richProduct.id, copy, richProduct), { id: richProduct.id, descriptionHtml: html });
  assert.throws(() => buildShopifyVisibleCopyInput(richProduct.id, { ...copy, description: 'Wrong old text' }, richProduct), /SYNC_DESCRIPTION_PAIR_MISMATCH/);
});
