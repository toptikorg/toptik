import { variantPolicySource } from "./helpers/variant-source-module.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { descriptionHelpers } from "./helpers/description-module.mjs";

const source = readFileSync("src/lib/carousel/repository-admin.ts", "utf8");
const saveBody = source.slice(source.indexOf("export async function saveCarouselPayload")).replace(/^export /gm, "");
const wrapped = `export function createSaver(deps) {
  ${variantPolicySource}
  const { createSupabaseServiceRoleClient, plainDescriptionToHtml, descriptionTextFromHtml, assertSafeDescriptionHtml } = deps;
  const adminCarouselPayloadSchema = { parse: value => structuredClone(value) };
  const applyReviewedCopy = value => value;
  const isUnavailableCarouselPayload = () => false;
  ${saveBody}
  return saveCarouselPayload;
}`;
const { createSaver } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(wrapped)).toString("base64")}`);
const raw = '<p>Bag <a href="/bags">details</a></p><table><tr><td>55 cm</td></tr></table>';
const stamp = "2026-09-30T10:00:00Z";
const prior = { id: "11111111-1111-4111-8111-111111111111", title: "Bag", description: descriptionHelpers.descriptionTextFromHtml(raw),
  description_html: raw, catalog_number: "SKU1", seo_title: null, seo_description: null, copy_updated_at: stamp };

function fixture(previous = prior) {
  const writes = [];
  const db = {
    from(table) {
      return {
        async select(columns) { if (columns === "id,editor_revision") return { data: null, error: { code: "42703", message: "editor_revision absent in legacy fixture" } }; return { data: table === "carousel_items" && previous ? [previous] : [], error: null }; },
        async upsert() { assert.equal(table, "carousel_settings"); return { error: null }; },
      };
    },
    async rpc(name, input) {
      assert.equal(name, "save_gallery_items_with_copy_cas");
      writes.push(input.p_items);
      return { data: input.p_items.map(item => ({ id: item.id })), error: null };
    },
  };
  const save = createSaver({ ...descriptionHelpers, createSupabaseServiceRoleClient: () => db });
  const item = { id: prior.id, title: "Bag", description: previous?.description ?? "New description", catalogNumber: "SKU1",
    copyUpdatedAt: stamp, coverImagePath: "real.webp", isActive: true, displayOrder: 1, angles: [] };
  return { writes, item, save: edits => save({ items: [{ ...item, ...edits }], settings: { autoplayMs: 3000, transitionMode: "curtain-fade" } }) };
}

test("legacy clients editing another field preserve the stored rich description bytes", async () => {
  const f = fixture();
  await f.save({ title: "New title" });
  assert.equal(f.writes[0][0].description_html, raw);
  assert.equal(f.writes[0][0].description, prior.description);
});

test("plain-only legacy description edits cannot silently erase a known rich document", async () => {
  const f = fixture();
  await assert.rejects(f.save({ description: "Replacement plain text" }), /SYNC_DESCRIPTION_RICH_EDITOR_REQUIRED/);
  assert.equal(f.writes.length, 0);
});

test("explicit rich edits derive display text and save both representations together", async () => {
  const f = fixture();
  const html = raw.replace('Bag', 'Updated bag');
  await f.save({ description: 'old client display text', descriptionHtml: html });
  assert.equal(f.writes[0][0].description_html, html);
  assert.equal(f.writes[0][0].description, descriptionHelpers.descriptionTextFromHtml(html));
  assert.notEqual(f.writes[0][0].copy_updated_at, stamp);
});

test("explicit empty HTML clears both representations and unsafe edited HTML is rejected", async () => {
  const f = fixture();
  await f.save({ descriptionHtml: '' });
  assert.equal(f.writes[0][0].description_html, '');
  assert.equal(f.writes[0][0].description, null);
  const unsafe = fixture();
  await assert.rejects(unsafe.save({ descriptionHtml: '<p onclick="alert(1)">Bag</p>' }), /SYNC_DESCRIPTION_HTML_UNSAFE/);
  assert.equal(unsafe.writes.length, 0);
});

test("existing uninitialized documents stay unknown until a deliberate edit", async () => {
  const f = fixture({ ...prior, description_html: null });
  await f.save({ title: 'New title' });
  assert.equal(f.writes[0][0].description_html, null);
  const edited = fixture({ ...prior, description_html: null });
  await edited.save({ description: 'Edited description' });
  assert.equal(edited.writes[0][0].description_html, '<p>Edited description</p>');
});
