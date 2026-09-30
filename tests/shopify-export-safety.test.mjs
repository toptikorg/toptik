import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const adminPage = await readFile(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");

test("unsafe legacy Shopify export is not available from the gallery admin", () => {
  assert.doesNotMatch(adminPage, /@\/lib\/carousel\/shopify-export/);
  assert.doesNotMatch(adminPage, /onExportExcel|buildShopifyExportRows|toptik-shopify-import\.xlsx/);
  assert.doesNotMatch(adminPage, /הורד אקסל/);
  assert.match(adminPage, /יצוא מוצרים ל-Shopify מושבת/);
  assert.match(adminPage, /onExcelUpload/);
});
