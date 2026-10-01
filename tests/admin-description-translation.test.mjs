import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("src/app/admin/page.tsx");

// GAL-009 retired the server translator; its former client handlers are removed too.
test("editor no longer offers or calls the retired translation feature", () => {
  for (const token of ["onTranslateDescription", "translatingItemId", "/api/admin/translate"]) {
    assert.equal(source.includes(token), false);
  }
});

test("legacy translation endpoint stays authorized and retired, without writes or paid services", () => {
  const route = read("src/app/api/admin/translate/route.ts");
  assert.ok(route.includes("await requireGalleryAdmin(req)"));
  assert.ok(route.includes("status: 410"));
  for (const token of ["fetch(", ".update(", ".insert(", ".rpc("]) assert.equal(route.includes(token), false);
});

test("rich and plain descriptions remain editable through the structured editor", () => {
  assert.ok(source.includes("<ProductDescriptionEditor"));
  assert.ok(source.includes("html={item.descriptionHtml}"));
  assert.ok(source.includes("next.items.find(row => row.id === item.id)"));
  assert.ok(source.includes("changed.description = text; changed.descriptionHtml = html"));
});
