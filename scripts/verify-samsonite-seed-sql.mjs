/** Execute the real seed migration offline against PostgreSQL via PGlite. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
const [engine, manifestPath, galleryPath, mode] = process.argv.slice(2);
if (!engine || !manifestPath || !galleryPath) throw new Error("Usage: node scripts/verify-samsonite-seed-sql.mjs <PGlite package> <approved manifest> <gallery evidence> [--pins]");
const { PGlite } = await import(pathToFileURL(engine + "/dist/index.js").href);
const { pgcrypto } = await import(pathToFileURL(engine + "/dist/contrib/pgcrypto.js").href);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
const gallery = JSON.parse(await readFile(galleryPath, "utf8"));
const metadata = { catalog_number: "catalogNumber", source_url: "sourceUrl", cover_image_path: "coverImagePath",
  display_order: "displayOrder", is_active: "isActive", color: "color", dimensions: "dimensions", weight: "weight",
  sizes: "sizes", available_colors: "availableColors", tech_specs: "techSpecs", colors: "colors" };
const angles = item => item.angles.map(angle => ({ id: angle.id, item_id: item.id, angle_key: angle.angleKey,
  image_path: angle.imagePath, angle_order: angle.angleOrder })).sort((a,b) => a.id.localeCompare(b.id));
const protectedItems = gallery.adminItems.map(item => ({ id: item.id,
  ...Object.fromEntries(Object.entries(metadata).map(([stored, api]) => [stored, item[api] ?? null])), angles: angles(item),
})).sort((a,b) => a.id.localeCompare(b.id));
const protectedCatalog = { items: protectedItems, settings: [{ id: 1,
  autoplay_ms: gallery.adminSettings.autoplayMs, transition_mode: gallery.adminSettings.transitionMode }] };
const seedIds = manifest.rows.map(row => row.persistedItemId);
const db = new PGlite({ extensions: { pgcrypto } });
const hash = async value => (await db.query("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as hash", [JSON.stringify(value)])).rows[0].hash;
const manifestHash = await hash(manifest), catalogHash = await hash(protectedCatalog);
if (mode === "--pins") {
  console.log(JSON.stringify({ manifestHash, catalogHash, sourceHash: createHash("sha256").update(manifestBytes).digest("hex") }));
  await db.close();
  process.exit(0);
}
const migration = await readFile(root + "supabase/migrations/20260930_samsonite_gallery_baseline_seed.sql", "utf8");
assert.ok(migration.includes(manifestHash), "migration must pin the approved manifest's complete JSONB digest");
assert.ok(migration.includes(catalogHash), "migration must pin all existing noncopy metadata, angles and settings");
assert.ok(migration.includes(createHash("sha256").update(manifestBytes).digest("hex")), "raw artifact provenance must match");
await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema extensions; create extension pgcrypto with schema extensions;");
for (const name of ["20260423_carousel_schema.sql", "20260424_carousel_catalog_metadata.sql", "20260527_carousel_tech_specs_cache.sql",
  "20260620_carousel_item_colors.sql", "20260930_shopify_gallery_sync_inbox.sql", "20260930_shopify_gallery_sync_patch.sql"]) {
  await db.exec(await readFile(root + "supabase/migrations/" + name, "utf8"));
}
const originalRows = gallery.adminItems.map(item => ({ id: item.id,
  ...Object.fromEntries(Object.entries(metadata).map(([stored, api]) => [stored, item[api] ?? null])),
  title: item.title, description: item.description, description_html: item.descriptionHtml,
  seo_title: item.seoTitle, seo_description: item.seoDescription, copy_updated_at: item.copyUpdatedAt,
}));
for (const row of originalRows) {
  const core = Object.fromEntries(Object.entries(row).filter(([key]) => !["color", "dimensions", "weight", "sizes", "available_colors"].includes(key)));
  const keys = Object.keys(core);
  await db.query(`insert into carousel_items (${keys.join(",")}) select ${keys.join(",")} from jsonb_populate_record(null::carousel_items,$1)`, [JSON.stringify(core)]);
}
await db.query("insert into carousel_item_angles select * from jsonb_populate_recordset(null::carousel_item_angles,$1)", [JSON.stringify(gallery.adminItems.flatMap(angles))]);
await db.query("update carousel_settings set autoplay_ms=$1,transition_mode=$2 where id=1", [gallery.adminSettings.autoplayMs, gallery.adminSettings.transitionMode]);
await db.exec(migration);
await db.exec(migration); // Schema application is repeatable before and after seed.
const seed = value => db.query("select seed_samsonite_gallery_baselines($1::jsonb) as result", [JSON.stringify(value)]);
const counts = async () => (await db.query(`select
  (select count(*)::int from carousel_items) as items,
  (select count(*)::int from carousel_item_angles) as angles,
  (select count(*)::int from shopify_gallery_bindings) as bindings,
  (select count(*)::int from shopify_gallery_sync_state) as states,
  (select count(*)::int from shopify_gallery_public_links) as links,
  (select count(*)::int from shopify_gallery_content_outbox) as outbox,
  (select count(*)::int from shopify_webhook_events) as events,
  (select count(*)::int from shopify_gallery_seed_manifests) as manifests,
  (select count(*)::int from shopify_gallery_seed_receipts) as receipts`)).rows[0];
const originalCount = await counts();
const actualGuard = (await db.query("select samsonite_seed_protected_catalog($1::uuid[]) as guard", [seedIds])).rows[0].guard;
assert.deepEqual(actualGuard, protectedCatalog);

// Anonymous/authenticated users cannot invoke or inspect this private operation.
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  await assert.rejects(seed(manifest), /permission denied/);
  for (const table of ["shopify_gallery_seed_manifests", "shopify_gallery_seed_receipts"]) {
    await assert.rejects(db.query(`select * from ${table}`), /permission denied/);
    await assert.rejects(db.query(`delete from ${table}`), /permission denied/);
  }
  await assert.rejects(db.query("select samsonite_seed_protected_catalog($1::uuid[])", [seedIds]), /permission denied/);
  await db.exec("reset role");
}
for (const mutate of [
  draft => { draft.rows[0].sku = "UNREVIEWED_SKU"; },
  draft => { draft.rows[1] = draft.rows[0]; },
  draft => { draft.rows.pop(); },
  draft => { draft.rows[0].proposedItemInsert.title = "Unreviewed content"; },
  draft => { draft.rows[0].manufacturerEvidence.sourceUrls = ["https://unreviewed.invalid"]; },
]) {
  const altered = structuredClone(manifest); mutate(altered);
  await assert.rejects(seed(altered), /SYNC_SEED_MANIFEST_MISMATCH/);
  assert.deepEqual(await counts(), originalCount);
}

// Any protected state change fails before seeding. Roll back fixtures only.
for (const statement of [
  "update carousel_items set is_active=false where id='" + originalRows[0].id + "'",
  "update carousel_item_angles set image_path='changed' where id='" + angles(gallery.adminItems[0])[0].id + "'",
  "update carousel_settings set autoplay_ms=6000 where id=1",
]) {
  await db.exec("begin"); await db.exec(statement);
  await assert.rejects(seed(manifest), /SYNC_SEED_EXISTING_CATALOG_CHANGED/);
  await db.exec("rollback"); assert.deepEqual(await counts(), originalCount);
}
// A pre-existing inactive reviewed SKU is never reactivated or overwritten.
await db.exec("begin");
await db.query("insert into carousel_items(id,title,cover_image_path,catalog_number,is_active) values($1,'Existing hidden','old.webp',$2,false)",
  [seedIds[0], manifest.rows[0].sku]);
await assert.rejects(seed(manifest), /SYNC_SEED_EXISTING_IDENTITY_CONFLICT/);
await db.exec("rollback");

// Failure after earlier inserts must roll back rows, angles, bindings and evidence.
await db.exec("create function reject_seed_angle() returns trigger language plpgsql as $$ begin raise exception 'FORCED_SEED_FAILURE'; end; $$;");
await db.exec(`create trigger reject_seed_angle before insert on carousel_item_angles for each row when (new.item_id='${seedIds[1]}') execute function reject_seed_angle();`);
await assert.rejects(seed(manifest), /FORCED_SEED_FAILURE/);
assert.deepEqual(await counts(), originalCount);
await db.exec("drop trigger reject_seed_angle on carousel_item_angles;");

// Optional null flat metadata can be absent; a missing core field cannot.
await db.exec("begin; alter table carousel_items drop column description_html;");
await assert.rejects(seed(manifest), /SYNC_SEED_SCHEMA_MISSING_REQUIRED_FIELD/);
await db.exec("rollback");
assert.deepEqual(await counts(), originalCount);
// Detect even an unexpected database trigger that tries to enqueue seed copy.
await db.exec(`create function unexpected_seed_outbox() returns trigger language plpgsql as $$ begin
  insert into shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload)
    values(new.id,new.catalog_number,'unexpected-seed-trigger','{}'::jsonb); return new; end; $$;
  create trigger unexpected_seed_outbox after insert on carousel_items for each row when (new.id='${seedIds[1]}') execute function unexpected_seed_outbox();`);
await assert.rejects(seed(manifest), /SYNC_SEED_UNEXPECTED_OUTBOX_WRITE/);
assert.deepEqual(await counts(), originalCount);
await db.exec("drop trigger unexpected_seed_outbox on carousel_items;");
// Exercise both supported physical schema shapes. This first successful seed
// has no optional flat columns; roll it back, then exercise present columns.
await db.exec("begin");
assert.equal((await seed(manifest)).rows[0].result.inserted_items, 57);
await db.exec("rollback");
await db.exec("alter table carousel_items add column color text, add column dimensions text, add column weight text, add column sizes text[], add column available_colors text[];");

// A legitimate canary edit since the evidence snapshot is preserved completely.
const canary = originalRows.find(row => row.catalog_number === "BAH08453.001");
await db.query("update carousel_items set title='Newer live canary copy',seo_title='Newer live SEO',copy_updated_at=now() where id=$1", [canary.id]);
const originalsBefore = (await db.query("select to_jsonb(item) as item from carousel_items item order by id")).rows;
await db.exec("set role service_role");
const result = (await seed(manifest)).rows[0].result;
assert.deepEqual(result, { manifest_id: "samsonite-2026-09-30-v1", inserted_items: 57, inserted_angles: 355, already_applied: false });
await db.exec("reset role");
assert.deepEqual(await counts(), { ...originalCount, items: 82, angles: originalCount.angles + 355, bindings: 57, states: 57, links: 57, manifests: 1, receipts: 57 });
assert.deepEqual((await db.query("select to_jsonb(item) as item from carousel_items item where not(id=any($1::uuid[])) order by id", [seedIds])).rows, originalsBefore);
for (const row of manifest.rows) {
  const stored = (await db.query("select to_jsonb(item) as item from carousel_items item where id=$1", [row.persistedItemId])).rows[0].item;
  for (const [key, value] of Object.entries(row.proposedItemInsert)) {
    if (key === "copy_updated_at") assert.equal(Date.parse(stored[key]), Date.parse(value));
    else assert.deepEqual(stored[key] ?? null, value, `${row.sku}: ${key}`);
  }
  const state = (await db.query("select * from shopify_gallery_sync_state where catalog_key=$1", [row.catalogKey])).rows[0];
  assert.deepEqual(state.gallery_baseline_payload, row.proposedBaseline.gallery_baseline_payload);
  assert.deepEqual(state.shopify_baseline_payload, row.proposedBaseline.shopify_baseline_payload);
  const savedAngles = (await db.query("select to_jsonb(angle) as angle from carousel_item_angles angle where item_id=$1 order by angle_order", [row.persistedItemId])).rows.map(r => r.angle);
  assert.deepEqual(savedAngles, row.proposedAngleInserts);
}
const seededCounts = await counts();
await db.exec("set role service_role");
assert.deepEqual((await seed(manifest)).rows[0].result, { ...result, inserted_items: 0, inserted_angles: 0, already_applied: true });
await assert.rejects(db.query("delete from shopify_gallery_seed_receipts"), /permission denied/);
await db.exec("reset role");
assert.deepEqual(await counts(), seededCounts);
await assert.rejects(db.exec("update shopify_gallery_seed_manifests set applied_at=now()"), /SYNC_SEED_EVIDENCE_IMMUTABLE/);
for (const statement of [
  `update carousel_items set is_active=false where id='${seedIds[0]}'`,
  `update carousel_items set description='Later merchant edit' where id='${seedIds[0]}'`,
  `update shopify_gallery_sync_state set synced_at=synced_at+interval '1 second' where catalog_key='${manifest.rows[0].catalogKey}'`,
]) {
  await db.exec("begin"); await db.exec(statement);
  await assert.rejects(seed(manifest), /SYNC_SEED_ALREADY_APPLIED_STATE_CHANGED/);
  await db.exec("rollback");
}
await db.exec(migration);
assert.deepEqual((await seed(manifest)).rows[0].result, { ...result, inserted_items: 0, inserted_angles: 0, already_applied: true });
console.log("PASS: 57 reviewed items + 355 angles seed atomically; 25 existing rows and later canary copy preserved; metadata/settings/angle CAS; independent rich baselines; private immutable provenance; exact no-op reapply; edited/hidden rows rejected; unknown/duplicate/tampered manifests rejected; injected failure rollback; missing core schema rejected; optional-null columns present/absent supported; unexpected trigger outbox writes roll back; zero outbox/webhook writes; service-only RPC; repeated migration safe.");
await db.close();
