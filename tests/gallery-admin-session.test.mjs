import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const read = p => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const moduleOf = s => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString("base64")}`);
const policy = await moduleOf(await read("src/lib/admin/gallery-session-policy.ts"));
const origin = "https://admin.toptik.co.il";

test("session mutations require exact same-origin, including writeful GET", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(policy.allowsGallerySessionRequest(method, origin, new Headers({ origin })), true);
    for (const other of [undefined, "null", "https://landing.toptik.co.il", "https://evil.example", origin + ".evil.example"]) {
      assert.equal(policy.allowsGallerySessionRequest(method, origin, new Headers(other ? { origin: other } : {})), false);
    }
    assert.equal(policy.allowsGallerySessionRequest(method, origin, new Headers({ origin, "sec-fetch-site": "cross-site" })), false);
  }
  assert.equal(policy.allowsGallerySessionRequest("GET", origin, new Headers()), true);
  assert.equal(policy.allowsGallerySessionRequest("GET", origin, new Headers(), true), false);
  assert.equal(policy.allowsGallerySessionRequest("GET", origin, new Headers({ origin }), true), true);
});

test("login destination is a closed internal allowlist", () => {
  assert.equal(policy.galleryLoginDestination("/admin"), "/admin");
  for (const value of [undefined, "/dashboard", "//evil.example", "https://evil.example", "/admin?next=https://evil.example", ["/admin"]]) {
    assert.equal(policy.galleryLoginDestination(value), "/dashboard");
  }
});

test("real gallery gate retains token path and verifies session role before origin and privileged reads", async () => {
  const source = await read("src/lib/admin/gallery-access.ts");
  // Execute the actual gate with controlled token/session collaborators.
  const executable = source.replace(/^import[^\n]*;\r?\n/gm, "");
  for (const scenario of ["token", "anonymous", "no-role", "admin"]) {
    const dependencyCode = `const NextResponse = { json: (body, init) => ({body, status:init.status}) };
      const requireAdminToken = () => ${scenario === "token" ? "null" : "({status:401})"};
      const requireAdminUser = async () => ${scenario === "anonymous" ? "({ok:false,response:{status:401}})" : scenario === "no-role" ? "({ok:false,response:{status:403}})" : "({ok:true,user:{id:'verified-user'},role:'admin'})"};
      const allowsGallerySessionRequest = ${policy.allowsGallerySessionRequest.toString()};\n`;
    const gate = await moduleOf(dependencyCode + executable);
    const request = { method: "PUT", nextUrl: { origin }, headers: new Headers({ origin }) };
    const result = await gate.authorizeGalleryAdmin(request);
    if (scenario === "anonymous" || scenario === "no-role") {
      assert.equal(result.ok, false); assert.equal(result.response.status, scenario === "anonymous" ? 401 : 403);
    } else {
      assert.equal(result.ok, true);
      assert.equal(result.authMethod, scenario === "token" ? "token" : "session");
      if (scenario === "admin") {
        assert.equal(result.actorId, "verified-user");
        assert.equal((await gate.authorizeGalleryAdmin({ ...request, headers: new Headers() })).response.status, 403);
      } else {
        assert.equal((await gate.authorizeGalleryAdmin({ ...request, headers: new Headers() })).ok, true);
      }
    }
  }
});

test("session access is limited to interactive editor; background sync remains token-only", async () => {
  for (const file of ["carousel", "upload", "translate", "import/by-url", "shopify/creation-intents", "shopify/specs/fields"]) {
    assert.match(await read(`src/app/api/admin/${file}/route.ts`), /await requireGalleryAdmin\(/);
  }
  assert.match(await read("src/app/api/admin/shopify/sync/route.ts"), /requireAdminToken\(/);
  assert.match(await read("src/app/api/admin/warm-tech-specs/route.ts"), /sessionMutation: true/);
  assert.match(await read("src/lib/admin/config.ts"), /NEXT_PUBLIC_GALLERY_EDITOR_URL \?\? "\/admin"/);
});
