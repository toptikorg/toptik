import { variantPolicySource } from "./helpers/variant-source-module.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { descriptionHelpers } from "./helpers/description-module.mjs";

// Incident 2026-10-07: "save all" renumbered every product to 1..N and sent the
// whole catalog, so one pre-existing display-order gap rewrote 183 untouched
// rows and their gallery CAS revisions, rejecting in-flight media syncs. These
// tests drive the real editor persist code, the real PUT route, the real
// creation bridge and the real repository saver against an emulation of
// save_gallery_catalog_atomic, and prove only edited rows are ever written.

const read = name => readFileSync(name, "utf8");
const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const withoutImports = source => source.replace(/^import[^\n]*;\r?\n/gm, "").replace(/^export /gm, "");

const planner = await moduleFrom(read("src/lib/carousel/editor-changes.ts"));
const { planChangedOnlySave, NO_CHANGES_MESSAGE, PRODUCT_REMOVAL_UNSUPPORTED_MESSAGE, DisplayOrderConflictError } = planner;
const { adminCarouselPayloadSchema } = await moduleFrom(read("src/lib/validation/carousel.ts")
  .replace('from "zod"', `from ${JSON.stringify(import.meta.resolve("zod"))}`));

const saver = read("src/lib/carousel/repository-admin.ts");
const { createSaver } = await moduleFrom(`export function createSaver(deps) {
  ${variantPolicySource}
  const { createSupabaseServiceRoleClient, adminCarouselPayloadSchema,
    plainDescriptionToHtml, descriptionTextFromHtml, assertSafeDescriptionHtml } = deps;
  const isUnavailableCarouselPayload = () => false;
  ${saver.slice(saver.indexOf("export async function saveCarouselPayload")).replace(/^export /gm, "")}
  return saveCarouselPayload;
}`);
const bridge = read("src/lib/shopify/creation-catalog-bridge.ts");
const { createBridge } = await moduleFrom(`export function createBridge(deps) {
  const { adminCarouselPayloadSchema, createSupabaseServiceRoleClient } = deps;
  const galleryDraftCreationMode = () => false;
  const finalizedCreationIds = async () => [];
  ${bridge.slice(bridge.indexOf("async function privateDraftIds")).replace(/^export /gm, "")}
  return { visibleAdminCatalog, prepareExistingCatalogSave };
}`);
const { createRoute } = await moduleFrom(`export function createRoute(deps) {
  const { NextResponse, getCarouselPayload, saveCarouselPayload, prepareExistingCatalogSave, visibleAdminCatalog,
    assertReviewedCatalogSave } = deps;
  const console = { error() {} };
  const requireGalleryAdmin = async () => null;
  const authorizeGalleryAdmin = async () => ({ ok: true, authMethod: "token", actorId: "token" });
  const isUnavailableCarouselPayload = () => false;
  const CAROUSEL_UNAVAILABLE_MESSAGE = "unavailable";
  const mediaReviewMessage = () => null;
  const scheduleShopifySync = () => {}, scheduleMediaSyncWakeup = () => {};
  ${withoutImports(read("src/app/api/admin/carousel/route.ts"))}
  return { GET, PUT };
}`);
const admin = read("src/app/admin/page.tsx");
const persistSource = admin.slice(admin.indexOf("async function persistPayload"), admin.indexOf("const loadData = useCallback"));
// persistPayload refuses a pending edit on a Shopify-owned color: those are delivered by their own button.
const ownedClientSource = withoutImports(read("src/lib/shopify/owned-edit-client.ts"));
// persistPayload also refuses a new upload of an ordinary product that nobody confirmed yet (staged Gallery review).
const stagedReviewSource = withoutImports(read("src/lib/carousel/staged-upload-review.ts"));
const { makePersist } = await moduleFrom(`export function makePersist(deps) {
  const { fetch, savedSnapshotRef, planChangedOnlySave } = deps;
  const authReady = true, token = "test-token";
  const isUnavailableCarouselPayload = () => false;
  const CAROUSEL_UNAVAILABLE_MESSAGE = "unavailable";
  const pendingUploadsRef = { current: 0 }, catalogGenerationRef = { current: 0 };
  ${variantPolicySource}
  ${ownedClientSource}
  ${stagedReviewSource}
  ${persistSource}
  return persistPayload;
}`);

const uuid = index => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
const angleId = (item, n) => `33333333-3333-4333-8333-${String(item * 10 + n).padStart(12, "0")}`;
const stamp = "2026-10-01T08:00:00.000Z";
const UNTOUCHED = 184;
const ITEM_COLUMNS = ["id", "title", "description", "description_html", "seo_title", "seo_description", "copy_updated_at",
  "catalog_number", "source_url", "cover_image_path", "cover_image_alt", "display_order", "is_active", "color",
  "dimensions", "weight", "sizes", "available_colors", "colors", "tech_specs"];

/** 185 stored products whose display order has a pre-existing gap at 41. */
function store({ privateIds = [] } = {}) {
  const rows = Array.from({ length: UNTOUCHED + 1 }, (_, index) => {
    const html = descriptionHelpers.plainDescriptionToHtml(`Description ${index}`);
    return {
      id: uuid(index + 1), title: `Product ${index + 1}`, description: descriptionHelpers.descriptionTextFromHtml(html),
      description_html: html, seo_title: null, seo_description: null, copy_updated_at: stamp, editor_revision: 4,
      catalog_number: `SKU-${index + 1}`, source_url: null, cover_image_path: `https://example.com/${index}.webp`,
      cover_image_alt: null, display_order: index < 40 ? index + 1 : index + 2, is_active: true, color: null,
      dimensions: null, weight: null, sizes: null, available_colors: null, colors: null,
      tech_specs: { specs: [{ heading: "Specs", items: [{ label: "Volume", value: `${index} L` }] }], colors: [], category: "suitcase" },
    };
  });
  const angles = rows.flatMap((row, index) => [1, 2, 3].map(n => ({ id: angleId(index + 1, n), item_id: row.id,
    angle_key: `view-${n}`, image_path: `https://example.com/${index}-${n}.webp`, angle_order: n, image_alt: null })));
  const settings = { id: 1, editor_revision: 9, autoplay_ms: 4000, transition_mode: "curtain-fade" };
  const calls = { rpc: [], settingsUpdates: 0, puts: [], itemWrites: [] };
  const hooks = { beforeRpc: null };
  const fail = message => ({ data: null, error: { message } });

  const db = {
    from(table) {
      const filters = [];
      let update = null;
      const source = () => table === "carousel_items" ? rows : table === "carousel_item_angles" ? angles
        : table === "carousel_settings" ? [settings] : table === "shopify_gallery_creation_drafts" ? privateIds.map(id => ({ id })) : [];
      const run = () => {
        const matched = source().filter(row => filters.every(filter => filter(row)));
        if (!update) return { data: structuredClone(matched), error: null };
        assert.equal(table, "carousel_settings", "only the settings row may be updated directly");
        for (const row of matched) {
          const changed = Object.entries(update).some(([key, value]) => row[key] !== value);
          Object.assign(row, update);
          if (changed) row.editor_revision += 1;
          calls.settingsUpdates += 1;
        }
        return { data: matched.map(row => ({ id: row.id })), error: null };
      };
      const query = {
        select() { return query; }, order() { return query; }, range() { return query; },
        abortSignal() { return Promise.resolve(run()); },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        update(values) { update = values; return query; },
        upsert() { assert.fail(`unexpected upsert on ${table}`); },
        delete() { assert.fail(`unexpected delete on ${table}`); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return query;
    },
    // Emulates save_gallery_catalog_atomic + save_gallery_items_with_copy_cas:
    // every check runs before any write (one transaction).
    async rpc(name, input) {
      assert.equal(name, "save_gallery_catalog_atomic");
      hooks.beforeRpc?.();
      calls.rpc.push(structuredClone(input));
      if (!Array.isArray(input.p_items) || input.p_items.length < 1 || input.p_items.length > 5000) return fail("GALLERY_EDITOR_INPUT_INVALID");
      const ids = new Set(input.p_items.map(item => item.id));
      if (input.p_angles.some(angle => !ids.has(angle.item_id))) return fail("GALLERY_EDITOR_IDENTITIES_INVALID");
      if (settings.editor_revision !== input.p_expected_settings_revision) return fail("GALLERY_EDITOR_SETTINGS_STALE_RELOAD");
      for (const item of input.p_items) {
        if (!Object.hasOwn(input.p_expected_editor_revisions, item.id)) return fail("GALLERY_EDITOR_REVISION_REQUIRED");
        const row = rows.find(current => current.id === item.id), expected = input.p_expected_editor_revisions[item.id];
        if ((row && expected !== row.editor_revision) || (!row && expected !== null)) return fail("GALLERY_EDITOR_STALE_RELOAD");
      }
      if (Object.keys(input.p_expected_versions).some(id => !ids.has(id))) return fail("SYNC_GALLERY_DELETE_REQUIRES_ARCHIVE");
      for (const item of input.p_items) {
        if (!Object.hasOwn(input.p_expected_versions, item.id)) return fail("SYNC_COPY_VERSION_REQUIRED");
        const row = rows.find(current => current.id === item.id), expected = input.p_expected_versions[item.id];
        if ((row && (expected === null || Date.parse(expected) !== Date.parse(row.copy_updated_at))) || (!row && expected !== null)) {
          return fail("SYNC_COPY_STALE_EDIT_RELOAD");
        }
      }
      for (const item of input.p_items) {
        const values = Object.fromEntries(ITEM_COLUMNS.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
        const row = rows.find(current => current.id === item.id);
        calls.itemWrites.push(item.id);
        if (!row) { rows.push({ ...values, editor_revision: 1 }); continue; }
        const before = JSON.stringify(row);
        Object.assign(row, values);
        if (JSON.stringify(row) !== before) row.editor_revision += 1;
      }
      for (const angle of input.p_angles) {
        const existing = angles.find(current => current.id === angle.id);
        if (existing) Object.assign(existing, angle); else angles.push({ ...angle });
      }
      const submittedAngles = new Set(input.p_angles.map(angle => angle.id));
      for (let index = angles.length - 1; index >= 0; index--) {
        if (ids.has(angles[index].item_id) && !submittedAngles.has(angles[index].id)) angles.splice(index, 1);
      }
      const settingsChanged = settings.autoplay_ms !== input.p_settings.autoplay_ms || settings.transition_mode !== input.p_settings.transition_mode;
      Object.assign(settings, input.p_settings);
      if (settingsChanged) settings.editor_revision += 1;
      return { data: input.p_items.map(item => ({ id: item.id })), error: null };
    },
  };

  const editorPayload = () => ({
    settings: { editorRevision: settings.editor_revision, autoplayMs: settings.autoplay_ms, transitionMode: settings.transition_mode },
    items: [...rows].sort((a, b) => a.display_order - b.display_order).map(row => ({
      id: row.id, title: row.title, description: row.description, descriptionHtml: row.description_html,
      seoTitle: row.seo_title, seoDescription: row.seo_description, copyUpdatedAt: row.copy_updated_at,
      editorRevision: row.editor_revision, catalogNumber: row.catalog_number, sourceUrl: row.source_url,
      coverImagePath: row.cover_image_path, coverImageAlt: row.cover_image_alt, displayOrder: row.display_order,
      isActive: row.is_active, color: row.color, dimensions: row.dimensions, weight: row.weight, sizes: row.sizes,
      availableColors: row.available_colors, colors: row.colors, techSpecs: row.tech_specs,
      angles: angles.filter(angle => angle.item_id === row.id).sort((a, b) => a.angle_order - b.angle_order).map(angle => ({
        id: angle.id, itemId: angle.item_id, angleKey: angle.angle_key, angleOrder: angle.angle_order,
        imagePath: angle.image_path, imageAlt: angle.image_alt })),
    })),
  });

  const deps = { ...descriptionHelpers, adminCarouselPayloadSchema, createSupabaseServiceRoleClient: () => db };
  const save = createSaver(deps);
  const { prepareExistingCatalogSave, visibleAdminCatalog } = createBridge(deps);
  const reviewed = [];
  const route = createRoute({
    NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) },
    getCarouselPayload: async () => editorPayload(), saveCarouselPayload: save,
    prepareExistingCatalogSave, visibleAdminCatalog,
    assertReviewedCatalogSave: async candidate => { reviewed.push(structuredClone(candidate)); },
  });
  const fetch = async (_url, init = {}) => {
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      calls.puts.push(body);
      const response = await route.PUT({ json: async () => structuredClone(body) });
      return { ok: response.status === 200, status: response.status, json: async () => response.body };
    }
    const response = await route.GET({});
    return { ok: response.status === 200, status: response.status, json: async () => structuredClone(response.body) };
  };
  const savedSnapshotRef = { current: editorPayload() };
  const persist = makePersist({ fetch, savedSnapshotRef, planChangedOnlySave });
  const before = structuredClone({ rows, angles, settings });
  // What the media sync's gallery CAS revision hashes: the whole item row plus its angles.
  const galleryRaw = (state, id) => JSON.stringify({ item: state.rows.find(row => row.id === id),
    angles: state.angles.filter(angle => angle.item_id === id).sort((a, b) => a.angle_order - b.angle_order || a.id.localeCompare(b.id)) });
  return { rows, angles, settings, before, calls, hooks, save, prepareExistingCatalogSave, route, persist,
    savedSnapshotRef, editorPayload, reviewed, galleryRaw };
}

function assertUntouched(f, exceptIds) {
  const now = { rows: f.rows, angles: f.angles };
  let compared = 0;
  for (const row of f.before.rows) {
    if (exceptIds.includes(row.id)) continue;
    assert.equal(f.galleryRaw(now, row.id), f.galleryRaw(f.before, row.id), `untouched ${row.catalog_number} must keep its gallery CAS input`);
    compared++;
  }
  return compared;
}

test("(i) one edited product sends and writes exactly that row; 184 untouched rows keep their gallery CAS revision", async () => {
  const f = store();
  const edited = structuredClone(f.savedSnapshotRef.current);
  const target = edited.items[99];
  target.seoTitle = "Edited SEO title";
  const fresh = await f.persist(edited);

  assert.equal(f.calls.puts.length, 1);
  assert.equal(f.calls.puts[0].saveMode, "changed-only");
  assert.deepEqual(f.calls.puts[0].items.map(item => item.id), [target.id]);
  assert.equal(f.calls.rpc.length, 1);
  const rpc = f.calls.rpc[0];
  assert.deepEqual(rpc.p_items.map(item => item.id), [target.id]);
  assert.deepEqual(Object.keys(rpc.p_expected_versions), [target.id]);
  assert.deepEqual(Object.keys(rpc.p_expected_editor_revisions), [target.id]);
  assert.equal(rpc.p_expected_editor_revisions[target.id], 4);
  assert.equal(rpc.p_expected_settings_revision, 9);
  assert.ok(rpc.p_angles.length === 3 && rpc.p_angles.every(angle => angle.item_id === target.id));
  assert.deepEqual(f.calls.itemWrites, [target.id], "no UPDATE may reach an untouched row");
  assert.deepEqual(f.reviewed[0].items.map(item => item.id), [target.id], "media review runs on the submitted subset");

  const stored = f.rows.find(row => row.id === target.id);
  assert.equal(stored.seo_title, "Edited SEO title");
  assert.equal(stored.editor_revision, 5);
  assert.equal(assertUntouched(f, [target.id]), UNTOUCHED);
  assert.deepEqual(f.settings, f.before.settings);
  assert.equal(f.calls.settingsUpdates, 0);
  // The snapshot is refreshed from the server so the next save diffs against it.
  assert.deepEqual(f.savedSnapshotRef.current, fresh);
  assert.notEqual(f.savedSnapshotRef.current, fresh);
});

test("(ii) a pre-existing display-order gap is preserved: nothing is renumbered", async () => {
  const f = store();
  assert.ok(!f.rows.some(row => row.display_order === 41), "fixture gap");
  const edited = structuredClone(f.savedSnapshotRef.current);
  const target = edited.items[150];
  target.title = "Renamed";
  await f.persist(edited);
  assert.deepEqual(f.calls.puts[0].items.map(item => [item.id, item.displayOrder]), [[target.id, target.displayOrder]]);
  assert.deepEqual(f.rows.map(row => row.display_order), f.before.rows.map(row => row.display_order));
  assert.ok(!f.rows.some(row => row.display_order === 41), "gap must survive the save");
  assert.doesNotMatch(persistSource, /index \+ 1/, "no 1..N renumbering in the editor save");
});

test("(iii) an occupied or invalid order is refused with a clear message; nothing is sent or moved", async () => {
  const f = store();
  const edited = structuredClone(f.savedSnapshotRef.current);
  const target = edited.items[120];
  const holder = edited.items.find(item => item.displayOrder === 5);
  target.displayOrder = 5; // already held by an untouched product
  target.title = "also renamed";
  await assert.rejects(f.persist(edited), error => {
    assert.ok(error instanceof DisplayOrderConflictError);
    assert.match(error.message, /מיקום 5 של .* תפוס על ידי/);
    assert.ok(error.message.includes(holder.catalogNumber || holder.title || holder.id), "names the product holding the slot");
    assert.match(error.message, /לא נשמר דבר והמיקום השמור לא שונה/);
    assert.match(error.message, /למשל 41/, "suggests the nearest free slot without choosing it");
    return true;
  });
  assert.equal(f.calls.puts.length, 0, "no request");
  assert.deepEqual(f.calls.itemWrites, []);
  assert.equal(assertUntouched(f, []), UNTOUCHED + 1);

  const snapshot = store().savedSnapshotRef.current;
  for (const requested of [0, -3, 2.5, Number.NaN, 10000, 11 - 1]) {
    const next = structuredClone(snapshot);
    next.items[10].displayOrder = requested;
    assert.throws(() => planChangedOnlySave(snapshot, next), DisplayOrderConflictError, `requested ${requested}`);
  }
  for (const requested of [41, 500]) {
    const next = structuredClone(snapshot);
    next.items[10].displayOrder = requested; // free: kept exactly as typed
    assert.deepEqual(planChangedOnlySave(snapshot, next).items.map(item => [item.id, item.displayOrder]), [[next.items[10].id, requested]]);
  }
});

test("(iii) order checks never involve unedited products, even if they already share an order", () => {
  const item = (id, displayOrder) => ({ id, title: id, displayOrder, isActive: true, coverImagePath: `/${id}.jpg`, angles: [] });
  const settings = { editorRevision: 1, autoplayMs: 3000, transitionMode: "curtain-fade" };
  const snapshot = { settings, items: [item("a", 1), item("b", 2), item("c", 2), item("d", 3), item("e", 7)] };
  assert.equal(planChangedOnlySave(snapshot, structuredClone(snapshot)).hasChanges, false,
    "a pre-existing duplicate between unedited rows is not repaired by writing them");

  const titleOnly = structuredClone(snapshot);
  titleOnly.items[2].title = "c renamed"; // keeps its unchanged (duplicate) order
  assert.deepEqual(planChangedOnlySave(snapshot, titleOnly).items.map(i => [i.id, i.displayOrder]), [["c", 2]]);

  const collide = structuredClone(snapshot);
  collide.items[4].displayOrder = 1; // collides with unedited "a"
  collide.items.push(item("new-1", 3), item("new-2", 9), item("new-3", 9)); // "d"; and each other
  assert.throws(() => planChangedOnlySave(snapshot, collide), error => {
    assert.deepEqual(error.conflicts.map(c => [c.id, c.requested, c.heldBy]),
      [["e", 1, "a"], ["new-1", 3, "d"], ["new-2", 9, "new-3"], ["new-3", 9, "new-2"]]);
    assert.ok(error.conflicts.every(c => c.suggestion !== null && ![1, 2, 3, 7, 9].includes(c.suggestion)));
    assert.equal(new Set(error.conflicts.map(c => c.suggestion)).size, 4, "each refused product gets a distinct suggestion");
    return true;
  });
  assert.equal(collide.items[4].displayOrder, 1, "the editor state is left as typed, not moved");

  const free = structuredClone(snapshot);
  free.items[4].displayOrder = 6; // valid and unique: kept exactly as typed
  free.items.push(item("new-1", 8));
  assert.deepEqual(planChangedOnlySave(snapshot, free).items.map(i => [i.id, i.displayOrder]), [["e", 6], ["new-1", 8]]);
});

test("(iv) removing one angle sends only that product and its remaining angles", async () => {
  const f = store();
  const edited = structuredClone(f.savedSnapshotRef.current);
  const target = edited.items[60];
  const removed = target.angles[1].id;
  // Same transformation as the editor's removeAngle().
  target.angles = target.angles.filter(angle => angle.id !== removed).map((angle, index) => ({ ...angle, angleOrder: index + 1 }));
  await f.persist(edited);
  assert.deepEqual(f.calls.puts[0].items.map(item => item.id), [target.id]);
  const rpc = f.calls.rpc[0];
  assert.deepEqual(rpc.p_items.map(item => item.id), [target.id]);
  assert.deepEqual(rpc.p_angles.map(angle => [angle.id, angle.angle_order]), target.angles.map(angle => [angle.id, angle.angleOrder]));
  assert.ok(!f.angles.some(angle => angle.id === removed));
  assert.equal(f.angles.filter(angle => angle.item_id === target.id).length, 2);
  assert.equal(f.angles.length, f.before.angles.length - 1);
  assert.equal(assertUntouched(f, [target.id]), UNTOUCHED);
});

test("(v) a concurrent change to the submitted product is STALE (409) and nothing is written", async () => {
  const conflict = "המוצר עודכן במקום אחר";
  // A media sync advanced the row after the editor loaded it.
  {
    const f = store();
    const edited = structuredClone(f.savedSnapshotRef.current);
    edited.items[30].coverImageAlt = "new alt";
    f.rows.find(row => row.id === edited.items[30].id).editor_revision += 1;
    const after = structuredClone({ rows: f.rows, angles: f.angles, settings: f.settings });
    const snapshot = structuredClone(f.savedSnapshotRef.current);
    await assert.rejects(f.persist(edited), new RegExp(conflict));
    assert.equal(f.calls.rpc.length, 0);
    assert.deepEqual({ rows: f.rows, angles: f.angles, settings: f.settings }, after);
    assert.deepEqual(f.savedSnapshotRef.current, snapshot, "a rejected save does not advance the snapshot");
  }
  // The row changes between the server's read and the locked atomic RPC.
  {
    const f = store();
    const edited = structuredClone(f.savedSnapshotRef.current);
    const id = edited.items[31].id;
    edited.items[31].title = "Racing edit";
    f.hooks.beforeRpc = () => { f.rows.find(row => row.id === id).editor_revision += 1; };
    await assert.rejects(f.persist(edited), new RegExp(conflict));
    assert.equal(f.calls.itemWrites.length, 0);
    assert.equal(f.rows.find(row => row.id === id).title, f.before.rows.find(row => row.id === id).title);
    // The SQL-raised (plain object) conflict surfaces as its safe 409 code: the
    // submitted revision passes the JS pre-check, then changes under the lock.
    edited.items[31].editorRevision = f.rows.find(row => row.id === id).editor_revision;
    const rpcBefore = f.calls.rpc.length;
    const response = await f.route.PUT({ json: async () => ({ settings: edited.settings, items: [edited.items[31]], saveMode: "changed-only" }) });
    assert.deepEqual([response.status, response.body.error], [409, "GALLERY_EDITOR_STALE_RELOAD"]);
    assert.equal(f.calls.rpc.length, rpcBefore + 1, "conflict raised inside the atomic RPC");
    assert.equal(f.calls.itemWrites.length, 0);
  }
  // Copy changed concurrently while the editor changes copy.
  {
    const f = store();
    const edited = structuredClone(f.savedSnapshotRef.current);
    edited.items[32].seoDescription = "New search copy";
    f.rows.find(row => row.id === edited.items[32].id).copy_updated_at = "2026-10-07T09:00:00.000Z";
    const response = await f.route.PUT({ json: async () => ({ settings: edited.settings, items: [edited.items[32]], saveMode: "changed-only" }) });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /SYNC_COPY_STALE_EDIT_RELOAD/);
    assert.equal(f.calls.rpc.length, 0);
  }
  // A settings change by another tab rejects an item save through the settings CAS.
  {
    const f = store();
    const edited = structuredClone(f.savedSnapshotRef.current);
    edited.items[33].title = "Another edit";
    f.settings.editor_revision += 1;
    await assert.rejects(f.persist(edited), new RegExp(conflict));
    assert.equal(f.calls.itemWrites.length, 0);
  }
});

test("(vi) full mode is unchanged: every row is required and versioned; omission is still refused", async () => {
  const f = store();
  const full = f.editorPayload();
  full.items[0].title = "Full-mode edit";
  await f.save(full);
  const rpc = f.calls.rpc[0];
  assert.equal(rpc.p_items.length, f.before.rows.length);
  assert.deepEqual(Object.keys(rpc.p_expected_versions).sort(), f.before.rows.map(row => row.id).sort());
  assert.deepEqual(Object.keys(rpc.p_expected_editor_revisions).sort(), f.before.rows.map(row => row.id).sort());

  const omitted = store();
  const partial = omitted.editorPayload();
  partial.items = partial.items.slice(0, 1);
  await assert.rejects(omitted.save(partial), /SYNC_GALLERY_DELETE_REQUIRES_ARCHIVE/);
  assert.equal(omitted.calls.rpc.length, 0);
  await omitted.save({ ...partial, saveMode: "changed-only" });
  assert.equal(omitted.rows.length, omitted.before.rows.length, "changed-only never deletes by omission");

  assert.equal(adminCarouselPayloadSchema.safeParse({ settings: full.settings, items: [] }).success, false);
  assert.equal(adminCarouselPayloadSchema.safeParse({ settings: full.settings, items: [], saveMode: "full" }).success, false);
  assert.equal(adminCarouselPayloadSchema.safeParse({ settings: full.settings, items: [], saveMode: "changed-only" }).success, true);
  assert.equal(adminCarouselPayloadSchema.safeParse({ settings: full.settings, items: full.items.slice(0, 1), saveMode: "partial" }).success, false);
});

test("(vi) private creation reservations are appended in full mode only", async () => {
  const f = store({ privateIds: [uuid(185)] });
  const current = f.editorPayload();
  const reservation = current.items.find(item => item.id === uuid(185));
  reservation.isActive = false;
  const visible = { ...current, items: current.items.filter(item => item.id !== reservation.id) };
  const fullCandidate = await f.prepareExistingCatalogSave(visible, current);
  assert.equal(fullCandidate.items.at(-1), reservation);
  const changed = { settings: visible.settings, items: [visible.items[3]], saveMode: "changed-only" };
  const changedCandidate = await f.prepareExistingCatalogSave(changed, current);
  assert.deepEqual(changedCandidate.items.map(item => item.id), [visible.items[3].id]);
  await assert.rejects(f.prepareExistingCatalogSave({ ...changed, items: [reservation] }, current), /PRIVATE_ITEM_USE_INTENT/);
});

test("(vii) nothing changed sends no request; key order alone is not an edit", async () => {
  const f = store();
  const same = structuredClone(f.savedSnapshotRef.current);
  same.items[5] = Object.fromEntries(Object.entries(same.items[5]).reverse());
  const result = await f.persist(same);
  assert.equal(result, same, "persistPayload returns its own input when there is nothing to save");
  assert.equal(f.calls.puts.length, 0);
  assert.equal(f.calls.rpc.length, 0);
  assert.equal(NO_CHANGES_MESSAGE, "אין שינויים לשמירה");
  const onSave = admin.slice(admin.indexOf("async function onSave()"), admin.indexOf("  // Load catalog numbers"));
  assert.match(onSave, /if \(saved === payload\) \{[^}]*NO_CHANGES_MESSAGE/);
});

test("settings-only change uses the settings revision CAS without touching any product", async () => {
  const f = store();
  const edited = structuredClone(f.savedSnapshotRef.current);
  edited.settings.autoplayMs = 6000;
  await f.persist(edited);
  assert.deepEqual(f.calls.puts[0].items, []);
  assert.equal(f.calls.rpc.length, 0);
  assert.equal(f.settings.autoplay_ms, 6000);
  assert.equal(f.settings.editor_revision, 10);
  assert.deepEqual(f.rows, f.before.rows);
  assert.deepEqual(f.angles, f.before.angles);

  const stale = store();
  const late = structuredClone(stale.savedSnapshotRef.current);
  late.settings.transitionMode = "shatter-particle";
  stale.settings.editor_revision += 1; // another tab saved settings first
  await assert.rejects(stale.persist(late), /המוצר עודכן במקום אחר/);
  assert.equal(stale.settings.transition_mode, "curtain-fade");
});

test("a loaded product missing from the editor state is refused, never treated as a deletion", async () => {
  const f = store();
  const edited = structuredClone(f.savedSnapshotRef.current);
  edited.items.splice(7, 1);
  await assert.rejects(f.persist(edited), new RegExp(PRODUCT_REMOVAL_UNSUPPORTED_MESSAGE.slice(0, 20)));
  assert.equal(f.calls.puts.length, 0);
});

test("(viii) several selected products in one save write exactly those rows; a following no-op save sends nothing", async () => {
  const f = store();
  const edited = structuredClone(f.savedSnapshotRef.current);
  const picks = [3, 77, 150, 184];
  edited.items[3].title = "T3 edited";
  edited.items[77].isActive = false;
  edited.items[150].angles = edited.items[150].angles.slice(1);
  edited.items[184].coverImageAlt = "alt";
  const ids = picks.map(i => edited.items[i].id);
  const fresh = await f.persist(edited);
  assert.equal(f.calls.puts.length, 1);
  assert.deepEqual(f.calls.puts[0].items.map(i => i.id).sort(), [...ids].sort());
  assert.deepEqual(f.calls.itemWrites.sort(), [...ids].sort());
  assert.equal(assertUntouched(f, ids), UNTOUCHED + 1 - picks.length);
  // No-op save after a successful save: snapshot refreshed, nothing sent.
  const again = await f.persist(fresh);
  assert.equal(again, fresh);
  assert.equal(f.calls.puts.length, 1);
  // Edit one more after the save: only it is sent with its NEW revision.
  const next = structuredClone(fresh); next.items[3].title = "T3 edited twice";
  await f.persist(next);
  assert.deepEqual(f.calls.puts[1].items.map(i => i.id), [ids[0]]);
});

// Shopify-owned colors (FZT73, QMMM1) are delivered to the store by their own button. The catalog-wide
// save must neither drop nor half-save a pending edit there, and must keep saving everything else.
const ownedPolicy = await moduleFrom(read("src/lib/shopify/variant-source-policy.ts"));
function ownedCatalog() {
  const item = (id, order, extra = {}) => ({
    id, title: `Title ${order}`, description: "d", descriptionHtml: "<p>d</p>", seoTitle: null, seoDescription: null, copyUpdatedAt: stamp,
    editorRevision: 1, catalogNumber: `SKU-${order}`, coverImagePath: `https://example.com/${order}-1.jpg`, coverImageAlt: "alt", displayOrder: order,
    isActive: true, angles: [{ id: angleId(order, 1), itemId: id, angleKey: "1", angleOrder: 1, imagePath: `https://example.com/${order}-1.jpg`, imageAlt: "alt" }], ...extra,
  });
  const snapshot = { settings: { editorRevision: 1, autoplayMs: 4000, transitionMode: "curtain-fade" },
    items: [item(ownedPolicy.FZT73_VARIANTS[0].itemId, 1), item(uuid(1), 2)] };
  const calls = [];
  const fetch = async (_url, init = {}) => { calls.push(init.method ?? "GET"); return { ok: true, status: 200, json: async () => structuredClone(snapshot) }; };
  const persist = makePersist({ fetch, savedSnapshotRef: { current: structuredClone(snapshot) }, planChangedOnlySave });
  return { snapshot, calls, persist, edit: change => { const next = structuredClone(snapshot); change(next); return next; } };
}

test("a pending text, SEO or alt edit on an owned color is refused by the catalog-wide save and points to its own button", async () => {
  for (const change of [
    next => { next.items[0].title = "changed"; },
    next => { next.items[0].descriptionHtml = "<p>changed</p>"; next.items[0].description = "changed"; },
    next => { next.items[0].seoTitle = "changed"; },
    next => { next.items[0].coverImageAlt = "changed"; },
    next => { next.items[0].angles[0].imageAlt = "changed"; },
  ]) {
    const f = ownedCatalog();
    await assert.rejects(f.persist(f.edit(change)), /בכפתור "שמור בחנות"/);
    assert.deepEqual(f.calls, [], "nothing is sent when an owned color has an unsent edit");
  }
});

test("an image or visibility edit on an owned color is refused with the reason, and nothing is sent", async () => {
  for (const [change, reason] of [
    [next => { next.items[0].angles = []; }, /ניהול תמונות הצבע בחנות ובגלריה/],
    [next => { next.items[0].coverImagePath = "https://example.com/other.jpg"; }, /ניהול תמונות הצבע בחנות ובגלריה/],
    [next => { next.items[0].isActive = false; }, /הסתרה והצגה של צבע/],
    [next => { next.items[0].catalogNumber = "OTHER"; }, /מספר קטלוגי/],
  ]) {
    const f = ownedCatalog();
    await assert.rejects(f.persist(f.edit(change)), reason);
    assert.deepEqual(f.calls, []);
  }
});
test("everything else still saves: display order of an owned color and any edit to an ordinary product", async () => {
  const order = ownedCatalog();
  await order.persist(order.edit(next => { next.items[0].displayOrder = 7; }));
  assert.deepEqual(order.calls, ["PUT", "GET"]);
  const ordinary = ownedCatalog();
  await ordinary.persist(ordinary.edit(next => { next.items[1].title = "ordinary edit"; }));
  assert.deepEqual(ordinary.calls, ["PUT", "GET"]);
});

// Run the real asynchronous refresh handler with a delayed local GET, so input typed after submit
// is present before the server reply arrives. This is not a duplicate of the merge implementation.
const { makeOwnedMerge } = await moduleFrom(`export function makeOwnedMerge(deps) {
  const { canonicalJson } = deps;
  ${withoutImports(read("src/lib/carousel/owned-editor-refresh.ts"))}
  return mergeOwnedFamilyRefresh;
}`);
const mergeOwnedFamilyRefresh = makeOwnedMerge(planner);
const { makeOwnedChanges } = await moduleFrom(`export function makeOwnedChanges() {
  ${ownedClientSource}
  return ownedCardChanges;
}`);
const ownedCardChanges = makeOwnedChanges();
const ownedRefreshSource = admin.slice(admin.indexOf("async function refreshOwnedFamily"), admin.indexOf("async function saveOwnedCard"));
const { makeOwnedRefresh } = await moduleFrom(`export function makeOwnedRefresh(deps) {
  const { fetch, savedSnapshotRef, payloadRef, catalogGenerationRef, setPayload, mergeOwnedFamilyRefresh, ownedCardChanges,
    shopifyOwnedProductId, SHOPIFY_OWNED_VARIANTS } = deps;
  const token = "fixture-token", CAROUSEL_UNAVAILABLE_MESSAGE = "unavailable";
  const isUnavailableCarouselPayload = () => false;
  ${ownedRefreshSource}
  return refreshOwnedFamily;
}`);

function delayedOwnedRefresh() {
  const snapshot = structuredClone(ownedCatalog().snapshot);
  const sibling = structuredClone(snapshot.items[0]);
  sibling.id = ownedPolicy.FZT73_VARIANTS[1].itemId;
  sibling.title = "Sibling"; sibling.displayOrder = 3;
  snapshot.items.push(sibling);
  const savedSnapshotRef = { current: structuredClone(snapshot) };
  const payloadRef = { current: structuredClone(snapshot) }, catalogGenerationRef = { current: 7 };
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const fresh = structuredClone(snapshot);
  const refresh = makeOwnedRefresh({ ...ownedPolicy, mergeOwnedFamilyRefresh, ownedCardChanges, savedSnapshotRef, payloadRef, catalogGenerationRef,
    fetch: async () => { await pending; return { ok: true, json: async () => structuredClone(fresh) }; },
    setPayload: next => { payloadRef.current = typeof next === "function" ? next(payloadRef.current) : next; },
  });
  return { snapshot, fresh, savedSnapshotRef, payloadRef, catalogGenerationRef, resolve, refresh };
}

test("owned refresh preserves input typed after submit and a dirty sibling, with a fresh target baseline", async () => {
  const f = delayedOwnedRefresh(), target = f.payloadRef.current.items[0];
  target.title = "Submitted title";
  const submitted = structuredClone(target);
  f.fresh.items[0].title = "Submitted title";
  f.fresh.items[0].descriptionHtml = "<p>Server normalized</p>";
  f.fresh.items[0].description = "Server normalized";
  f.fresh.items[0].copyUpdatedAt = "2026-11-09T12:00:00.000Z";
  f.fresh.items[0].editorRevision = 8;
  f.fresh.items[2].title = "New shared title on sibling";
  const request = f.refresh(target.id, submitted, 7);
  target.title = "Typed while waiting";
  f.payloadRef.current.items[2].title = "Unsent sibling edit";
  f.resolve(); assert.equal(await request, true, "late edits remain visibly unsent");
  assert.equal(f.payloadRef.current.items[0].title, "Typed while waiting");
  assert.equal(f.payloadRef.current.items[0].descriptionHtml, "<p>Server normalized</p>", "unchanged fields follow the server");
  assert.equal(f.payloadRef.current.items[0].editorRevision, 8);
  assert.equal(f.payloadRef.current.items[0].copyUpdatedAt, f.fresh.items[0].copyUpdatedAt);
  assert.deepEqual(f.savedSnapshotRef.current.items[0], f.fresh.items[0]);
  assert.equal(f.payloadRef.current.items[2].title, "Unsent sibling edit");
  assert.deepEqual(f.savedSnapshotRef.current.items[2], f.snapshot.items[2], "dirty sibling retains its old CAS baseline");
  const calls = [];
  const persist = makePersist({ fetch: async () => { calls.push("unexpected"); }, savedSnapshotRef: f.savedSnapshotRef, planChangedOnlySave });
  await assert.rejects(persist(f.payloadRef.current), /בכפתור "שמור בחנות"/);
  assert.deepEqual(calls, []);
});

test("owned partial refresh preserves intended and later edits but adopts fresh version metadata", async () => {
  const f = delayedOwnedRefresh(), target = f.payloadRef.current.items[0];
  target.title = "Still unsent title";
  const submitted = structuredClone(target);
  f.fresh.items[0].coverImageAlt = "Delivered alt";
  f.fresh.items[0].copyUpdatedAt = "2026-11-09T12:10:00.000Z";
  f.fresh.items[0].editorRevision = 9;
  const request = f.refresh(target.id, submitted, 7, true);
  target.description = "Late description"; target.descriptionHtml = "<p>Late description</p>";
  f.resolve(); await request;
  assert.equal(f.payloadRef.current.items[0].title, "Still unsent title");
  assert.equal(f.payloadRef.current.items[0].description, "Late description");
  assert.equal(f.payloadRef.current.items[0].coverImageAlt, "Delivered alt");
  assert.equal(f.payloadRef.current.items[0].editorRevision, 9);
  assert.deepEqual(f.savedSnapshotRef.current.items[0], f.fresh.items[0]);
});

test("owned refresh with no later edit is clean for save all, including after a partial readback", async () => {
  for (const partial of [false, true]) {
    const f = delayedOwnedRefresh(), submitted = structuredClone(f.payloadRef.current.items[0]);
    f.fresh.items[0].editorRevision = 2;
    f.fresh.items[0].copyUpdatedAt = "2026-11-09T13:00:00.000Z";
    const request = f.refresh(submitted.id, submitted, 7, partial);
    f.resolve(); await request;
    assert.equal(planChangedOnlySave(f.savedSnapshotRef.current, f.payloadRef.current).hasChanges, false);
  }
});

test("late image-alt edits keep the current server angle ID after reconciliation", async () => {
  const f = delayedOwnedRefresh(), target = f.payloadRef.current.items[0], submitted = structuredClone(target);
  const nextId = angleId(50, 1);
  f.fresh.items[0].angles[0].id = nextId;
  const request = f.refresh(target.id, submitted, 7);
  target.angles[0].imageAlt = "Late image text";
  f.resolve(); await request;
  assert.equal(f.payloadRef.current.items[0].angles[0].imageAlt, "Late image text");
  assert.equal(f.payloadRef.current.items[0].angles[0].id, nextId);
  assert.equal(f.savedSnapshotRef.current.items[0].angles[0].imageAlt, "alt");
});

test("an owned reply cannot replace a catalog that was reloaded while its readback was pending", async () => {
  const f = delayedOwnedRefresh(), submitted = structuredClone(f.payloadRef.current.items[0]);
  const request = f.refresh(submitted.id, submitted, 7);
  f.catalogGenerationRef.current++;
  f.fresh.items[0].title = "Old response";
  f.resolve(); await assert.rejects(request, /הנתונים נטענו מחדש/);
  assert.deepEqual(f.savedSnapshotRef.current, f.snapshot);
  assert.deepEqual(f.payloadRef.current, f.snapshot);
});

// ---- Staged Gallery review: a new upload of an ordinary product must be confirmed before it is saved ----------------
// These drive the real persistPayload, the real PUT route, the real saver and the emulated atomic RPC with its
// per-card revision check. The receipt guard itself is covered in staged-media-*.test.mjs; here the point is that the
// confirmation never replaces the version check and never lets an unconfirmed upload reach a request.
const stagedEditor = await moduleFrom(read("src/lib/carousel/staged-upload-review.ts"));
const stagedBucket = "https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media";
function withFreshUpload(snapshot, index) {
  const edited = structuredClone(snapshot);
  const target = edited.items[index];
  const upload = `${stagedBucket}/items/${target.id}/angles/5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg`;
  target.angles.push({ id: angleId(900, index), itemId: target.id, angleKey: "view-4", angleOrder: 4, imagePath: upload });
  return { edited, target, upload };
}

test("(staged i) an unconfirmed upload stops the whole save before any request or write", async () => {
  const f = store();
  const { edited } = withFreshUpload(f.savedSnapshotRef.current, 10);
  edited.items[3].title = "an unrelated edit that would save on its own";
  await assert.rejects(f.persist(edited), { message: stagedEditor.PENDING_REVIEW_SAVE_MESSAGE });
  assert.equal(f.calls.puts.length, 0);
  assert.equal(f.calls.rpc.length, 0);
  assert.deepEqual(f.calls.itemWrites, []);
});

test("(staged ii) the confirmed copy saves as exactly that card and is checked against the version the editor loaded", async () => {
  const f = store();
  const { edited, target, upload } = withFreshUpload(f.savedSnapshotRef.current, 10);
  const copy = `${stagedBucket}/sync-staged/${target.id}/${"a".repeat(64)}.jpg`;
  edited.items[10] = stagedEditor.applyStagedUpload(edited.items[10], upload, copy);
  const fresh = await f.persist(edited);
  assert.deepEqual(f.calls.puts[0].items.map(item => item.id), [target.id]);
  assert.deepEqual(f.calls.itemWrites, [target.id]);
  assert.equal(f.calls.rpc[0].p_expected_editor_revisions[target.id], 4, "the card version the editor loaded is what the save checks");
  assert.ok(f.angles.some(angle => angle.item_id === target.id && angle.image_path === copy), "the confirmed copy is stored");
  assert.ok(!f.angles.some(angle => angle.image_path === upload), "the unconfirmed upload address is never stored");
  assert.equal(assertUntouched(f, [target.id]), UNTOUCHED);
  assert.equal(fresh.items[10].angles.at(-1).imagePath, copy);
});

test("(staged iii) a card saved elsewhere first is still refused by its own revision check, with or without a receipt", async () => {
  const f = store();
  const { edited, target, upload } = withFreshUpload(f.savedSnapshotRef.current, 10);
  edited.items[10] = stagedEditor.applyStagedUpload(edited.items[10], upload, `${stagedBucket}/sync-staged/${target.id}/${"b".repeat(64)}.png`);
  f.rows.find(row => row.id === target.id).editor_revision += 1; // another tab or the sync saved this card meanwhile
  await assert.rejects(f.persist(edited), /המוצר עודכן במקום אחר/);
  assert.deepEqual(f.calls.itemWrites, []);
  assert.ok(!f.angles.some(angle => angle.item_id === target.id && angle.image_path.includes("sync-staged")));
});

test("(staged iv) a shared multi-color card keeps its own refusal; the new check never replaces it", async () => {
  const f = ownedCatalog();
  const next = f.edit(snapshot => {
    const owned = snapshot.items[0];
    owned.angles.push({ id: angleId(901, 1), itemId: owned.id, angleKey: "2", angleOrder: 2, imagePath: `${stagedBucket}/items/${owned.id}/angles/5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg`, imageAlt: "alt" });
  });
  await assert.rejects(f.persist(next), error => /לא נשמר דבר/.test(error.message) && error.message !== stagedEditor.PENDING_REVIEW_SAVE_MESSAGE);
  assert.deepEqual(f.calls, []);
});
