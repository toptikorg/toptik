import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleOf = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const withoutImports = source => source.replace(/^import[^\n]*;\r?\n/gm, "").replace(/^export /gm, "");
const policy = await moduleOf(read("src/lib/admin/gallery-session-policy.ts"));
const gateFactory = await moduleOf(`export function createGate(deps) {
  const { NextResponse, requireAdminToken, requireAdminUser, allowsGallerySessionRequest } = deps;
  ${withoutImports(read("src/lib/admin/gallery-access.ts"))}
  return { authorizeGalleryAdmin, requireGalleryAdmin };
}`);
const routeFactory = await moduleOf(`export function createRoute(deps) {
  const { NextResponse, getCarouselPayload, saveCarouselPayload, requireGalleryAdmin, authorizeGalleryAdmin,
    isUnavailableCarouselPayload, prepareExistingCatalogSave, visibleAdminCatalog, scheduleShopifySync, scheduleMediaSyncWakeup } = deps;
  const CAROUSEL_UNAVAILABLE_MESSAGE = "unavailable";
  ${withoutImports(read("src/app/api/admin/carousel/route.ts"))}
  return { GET, PUT };
}`);
const automationActor = "f4a10335-5d41-4b70-9e16-93bb74a52eba";
const sessionActor = "c63f74e3-4b30-483b-8277-d2c6b3191e35";
const origin = "https://admin.toptik.co.il";
function fixture(method, saveError) {
  const calls = [], NextResponse = { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) };
  const gate = gateFactory.createGate({ NextResponse,
    requireAdminToken: () => method === "token" ? null : { status: 401 },
    requireAdminUser: async () => ({ ok: true, user: { id: sessionActor }, role: "admin" }),
    allowsGallerySessionRequest: policy.allowsGallerySessionRequest });
  const payload = { settings: { editorRevision: 3 }, items: [{ id: "fixed-item", editorRevision: 7 }] };
  const route = routeFactory.createRoute({ NextResponse, ...gate,
    getCarouselPayload: async options => { calls.push(["read", options]); return payload; },
    saveCarouselPayload: async (candidate, actor) => { calls.push(["save", candidate, actor]); if (saveError) throw saveError; },
    isUnavailableCarouselPayload: () => false,
    prepareExistingCatalogSave: async body => body, visibleAdminCatalog: async data => data,
    scheduleShopifySync: () => calls.push(["copy"]), scheduleMediaSyncWakeup: () => calls.push(["media"]),
  });
  const request = (headers = method === "session" ? { origin } : {}) => ({ method: "PUT", nextUrl: { origin },
    headers: new Headers(headers), json: async () => ({ ...payload, actorId: "client-forged", mediaActor: { actorType: "supabase_user", actorId: "client-forged" } }) });
  return { calls, gate, route, request };
}
test("actual token PUT maps only media provenance to the established SQL principal", async () => {
  const f = fixture("token"), request = f.request();
  const auth = await f.gate.authorizeGalleryAdmin(request);
  assert.equal(auth.actorId, automationActor);
  const response = await f.route.PUT(request);
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.find(call => call[0] === "save")[2], { actorType: "admin_panel_token", actorId: "configured-admin-panel" });
  assert.equal((await f.gate.authorizeGalleryAdmin(request)).actorId, automationActor);
  assert.deepEqual(f.calls.slice(-2), [["copy"], ["media"]]);
});
test("actual session PUT retains verified UUID and ignores client actor claims", async () => {
  const f = fixture("session");
  const response = await f.route.PUT(f.request());
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.find(call => call[0] === "save")[2], { actorType: "supabase_user", actorId: sessionActor });
  assert.deepEqual(f.calls.slice(-2), [["copy"], ["media"]]);
});
test("session origin rejection occurs before catalog reads or provenance writes", async () => {
  for (const headers of [{}, { origin: "https://untrusted.example" }]) {
    const f = fixture("session");
    assert.equal((await f.route.PUT(f.request(headers))).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test("plain-object copy lock conflict returns safe 409 without scheduling work or leaking SQL details", async () => {
  const f = fixture("session", { code: "P0001", message: "SYNC_COPY_BUSY_RETRY", details: "private SQL details" });
  const response = await f.route.PUT(f.request());
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: "SYNC_COPY_BUSY_RETRY" });
  assert.ok(!f.calls.some(call => ["copy", "media"].includes(call[0])));
});

test("unknown database error objects keep the generic response", async () => {
  const f = fixture("session", { message: "private SQL details", code: "XX000" });
  const response = await f.route.PUT(f.request());
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Failed to save carousel data" });
});
test("mapped token principal matches the frozen media SQL and removal contracts", () => {
  const sql = read("supabase/migrations/20261001_media_planning_runtime.sql");
  assert.ok(sql.includes("p_actor->>'actorType'='admin_panel_token' and p_actor->>'actorId'='configured-admin-panel'"));
  assert.ok(sql.includes("p_actor->>'actorType'='supabase_user'"));
  const journal = read("supabase/migrations/20260930_media_sync_journal.sql");
  assert.ok(journal.includes("configured-admin-panel"));
});
