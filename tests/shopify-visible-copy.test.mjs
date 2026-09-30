import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

let source = await readFile("src/lib/shopify/admin-api.ts", "utf8");
source = source.replace(/^import "server-only";\s*/m, "");
const { galleryTextToShopifyHtml, shopifyHtmlToGalleryText, buildShopifyVisibleCopyInput } = await import(
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
  });
  assert.deepEqual(input, {
    id: "gid://shopify/Product/123", title: "Title", descriptionHtml: "<p>Description</p>",
    seo: { title: "SEO", description: "Snippet" },
  });
  for (const protectedField of ["price", "inventory", "status", "handle", "variants", "vendor", "images"]) {
    assert.equal(Object.hasOwn(input, protectedField), false);
  }
});
