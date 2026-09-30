import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const engine = process.argv[2];
if (!engine) throw new Error("Provide the local PGlite package directory");
const { PGlite } = await import(pathToFileURL(engine + "/dist/index.js").href);
const { pgcrypto } = await import(pathToFileURL(engine + "/dist/contrib/pgcrypto.js").href);
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema extensions; create extension pgcrypto with schema extensions;");
for (const name of ["20260423_carousel_schema.sql", "20260424_carousel_catalog_metadata.sql", "20260527_carousel_tech_specs_cache.sql", "20260620_carousel_item_colors.sql", "20260930_shopify_gallery_sync_inbox.sql", "20260930_shopify_gallery_sync_patch.sql", "20260930_shopify_gallery_sync_patch.sql"]) {
  await db.exec(await readFile(new URL("../supabase/migrations/" + name, import.meta.url), "utf8"));
}
const id = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const product = "gid://shopify/Product/123", variant = "gid://shopify/ProductVariant/456";
const owner = "33333333-3333-4333-8333-333333333333", stamp = "2026-09-30T10:00:00Z";
const raw = '<p><a href="/one">Bag</a></p><table><tr><td>75 cm</td></tr></table>';
const item = { id, title: "Original", description: "Bag\n\n75 cm", description_html: raw, catalog_number: "BAH08453.001",
  cover_image_path: "real.webp", display_order: 1, is_active: true, copy_updated_at: stamp,
  seo_title: "Old", seo_description: null, tech_specs: { untouched: true }, color: "Black", weight: "3.6 kg" };
await db.query("select * from save_gallery_items_with_copy_cas($1::jsonb,$2::jsonb)", [JSON.stringify([item, { ...item, id: otherId, catalog_number: "OTHER", display_order: 2 }]), JSON.stringify({ [id]: null, [otherId]: null })]);
await db.query("select upsert_shopify_gallery_binding($1,$2,$3,$4,$5,$6,$7)", ["BAH08453001", id, product, variant, "real-product", true, stamp]);
const initial = (await db.query("select to_jsonb(item) as row from carousel_items item order by id")).rows.map(row => row.row);
const baselineQueue = (await db.query("select count(*)::int as n from shopify_gallery_content_outbox")).rows[0].n;
const copy = { title: item.title, description: item.description, descriptionHtml: raw, seoTitle: "Corrected", seoDescription: null };
const patch = (value = copy, version = stamp, fields = {}) => db.query("select patch_shopify_canary_copy($1,$2,$3,$4,$5,$6,$7::jsonb) as result",
  [fields.id ?? id, fields.key ?? "BAH08453001", fields.sku ?? "BAH08453.001", fields.product ?? product, fields.variant ?? variant, version, JSON.stringify(value)]);
await db.exec("set role service_role");
const first = (await patch()).rows[0].result;
assert.equal(first.changed, true);
const after = (await db.query("select to_jsonb(item) as row from carousel_items item order by id")).rows.map(row => row.row);
assert.deepEqual(after[1], initial[1], "unrelated row survives unchanged");
assert.deepEqual({ ...after[0], seo_title: initial[0].seo_title, copy_updated_at: initial[0].copy_updated_at }, initial[0], "only intended copy columns change");
assert.equal((await patch(copy, first.copyUpdatedAt)).rows[0].result.changed, false);
assert.equal((await db.query("select count(*)::int as n from shopify_gallery_content_outbox")).rows[0].n, baselineQueue + 1);
await assert.rejects(patch({ ...copy, title: "Stale" }), /SYNC_COPY_STALE_EDIT_RELOAD/);
await assert.rejects(patch(copy, first.copyUpdatedAt, { sku: "BAH08453.006" }), /SYNC_BINDING_MISSING_OR_CONFLICTED/);
await assert.rejects(patch(copy, first.copyUpdatedAt, { variant: "gid://shopify/ProductVariant/999" }), /SYNC_BINDING_MISSING_OR_CONFLICTED/);
await assert.rejects(patch({ ...copy, price: "1" }, first.copyUpdatedAt), /SYNC_COPY_PATCH_INVALID/);
await db.query("select acquire_shopify_reconciliation_lease($1,$2)", [product, owner]);
await assert.rejects(patch({ ...copy, title: "Busy" }, first.copyUpdatedAt), /SYNC_COPY_BUSY_RETRY/);
await db.query("select release_shopify_reconciliation_lease($1,$2)", [product, owner]);
const rich = { ...copy, descriptionHtml: raw.replace('/one', '/two') };
const second = (await patch(rich, first.copyUpdatedAt)).rows[0].result;
assert.equal((await db.query("select description_html from carousel_items where id=$1", [id])).rows[0].description_html, rich.descriptionHtml);
await db.exec("reset role");
await db.exec("create function deny_patch_outbox() returns trigger language plpgsql as $$ begin raise exception 'FORCED_OUTBOX_FAILURE'; end; $$; create trigger deny_patch_outbox before insert on shopify_gallery_content_outbox for each row execute function deny_patch_outbox();");
await assert.rejects(patch({ ...rich, title: "Must roll back" }, second.copyUpdatedAt), /FORCED_OUTBOX_FAILURE/);
assert.equal((await db.query("select title from carousel_items where id=$1", [id])).rows[0].title, "Original");
await db.exec("drop trigger deny_patch_outbox on shopify_gallery_content_outbox;");
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  await assert.rejects(patch(rich, second.copyUpdatedAt), /permission denied/);
  await db.exec("reset role");
}
await db.close();
console.log("PASS: additive/idempotent copy-only RPC; service-role access; stale/identity/lease rejection; raw HTML; no-op; atomic outbox rollback; anonymous/authenticated denial.");
