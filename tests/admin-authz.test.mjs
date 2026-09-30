import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { z } from "zod";

// Admin-panel authorization (owner decision 2026-09-29): a signed-in Supabase
// user is not an admin by default; roles come from app_metadata only (plus a
// closed, temporary list of the two existing accounts); user_metadata is never
// authority; user management is owner-only; the vault needs an authorized admin
// AND a valid OTP; anonymous → 401, signed in without a role → 403; public
// sign-up can never create an admin; every service-role entry point is gated.
const root = fileURLToPath(new URL("../", import.meta.url));
const src = path.join(root, "src");
const rel = (file) => path.relative(root, file).split(path.sep).join("/");
const read = (file) => readFile(path.join(root, file), "utf8");
const toModule = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

const coreSource = await read("src/lib/admin/authz-core.ts");
const core = await toModule(coreSource);

// ── Users ────────────────────────────────────────────────────────────────────
const CONFIRMED = "2026-06-21T17:00:00Z";
const USERS = {
  anonymous: null,
  // What a public sign-up produces: app_metadata is set by Supabase, the rest is
  // whatever the sign-up sent — including a forged role in user_metadata.
  signupForgedOwner: { id: "s1", email: "attacker@example.com", email_confirmed_at: CONFIRMED,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { role: "owner" } },
  signupForgedAdmin: { id: "s2", email: "attacker2@example.com", email_confirmed_at: CONFIRMED,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { role: "admin" } },
  signedInNoRole: { id: "n1", email: "someone@example.com", email_confirmed_at: CONFIRMED,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {} },
  unconfirmedAppAdmin: { id: "u1", email: "new-admin@example.com", email_confirmed_at: null,
    app_metadata: { provider: "email", role: "admin" } },
  anonymousSignIn: { id: "a1", email: null, email_confirmed_at: null, is_anonymous: true,
    app_metadata: { provider: "anonymous", role: "owner" } },
  appAdmin: { id: "ad1", email: "admin@example.com", email_confirmed_at: CONFIRMED,
    app_metadata: { provider: "email", role: "admin" }, user_metadata: { role: "owner" } },
  appOwner: { id: "ow1", email: "owner@example.com", email_confirmed_at: CONFIRMED,
    app_metadata: { provider: "email", role: "owner" } },
  legacyOwner: { id: "l1", email: "rordan@gmail.com", email_confirmed_at: CONFIRMED,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { role: "owner" } },
  legacyAdmin: { id: "l2", email: "service@toptik.com", email_confirmed_at: CONFIRMED,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { role: "admin" } },
};

test("authorization rules: 401 / 403 / roles", () => {
  const decide = (name, required) => core.authorizePanelUser(USERS[name], required);
  assert.deepEqual(decide("anonymous", "admin"), { ok: false, status: 401, reason: "anonymous" });
  for (const name of ["signupForgedOwner", "signupForgedAdmin", "signedInNoRole"]) {
    assert.equal(decide(name, "admin").status, 403, `${name}: user_metadata never grants access`);
    assert.equal(decide(name, "owner").status, 403, name);
  }
  assert.equal(decide("unconfirmedAppAdmin", "admin").status, 403, "unconfirmed email is refused");
  assert.equal(decide("anonymousSignIn", "admin").status, 403, "anonymous sign-in is refused");
  assert.deepEqual(decide("appAdmin", "admin"), { ok: true, role: "admin", source: "app_metadata" });
  assert.equal(decide("appAdmin", "owner").status, 403, "admin is not owner (user_metadata owner ignored)");
  assert.deepEqual(decide("appOwner", "owner"), { ok: true, role: "owner", source: "app_metadata" });
  assert.deepEqual(decide("legacyOwner", "owner"), { ok: true, role: "owner", source: "legacy_email" });
  assert.deepEqual(decide("legacyAdmin", "admin"), { ok: true, role: "admin", source: "legacy_email" });
  assert.equal(decide("legacyAdmin", "owner").status, 403);
});

test("the temporary legacy list is closed, exact and cannot become a general path", () => {
  assert.deepEqual({ ...core.LEGACY_ROLE_BY_EMAIL }, { "rordan@gmail.com": "owner", "service@toptik.com": "admin" });
  assert.ok(Object.isFrozen(core.LEGACY_ROLE_BY_EMAIL));
  const variants = [
    { email: "RORDAN@gmail.com " }, // same account, normalised
  ];
  for (const v of variants) {
    assert.equal(core.authorizePanelUser({ ...USERS.legacyOwner, ...v }, "owner").ok, true);
  }
  const refused = [
    { email: "rordan@gmail.co" }, { email: "xrordan@gmail.com" }, { email: "service@toptik.co.il" },
    { email: "other@toptik.com" }, { email: "rordan+x@gmail.com" },
    { email_confirmed_at: null },                               // unconfirmed
    { app_metadata: { provider: "google" } },                   // not the email-password account
    { app_metadata: { provider: "email", role: "viewer" } },   // explicit app role wins
  ];
  for (const change of refused) {
    const user = { ...USERS.legacyOwner, ...change };
    assert.equal(core.authorizePanelUser(user, "admin").ok, false, JSON.stringify(change));
  }
  // No pattern or domain matching anywhere in the rules.
  assert.doesNotMatch(coreSource, /endsWith\(|\.includes\(|RegExp|\.match\(|\.test\(|indexOf\(/);
});

test("user_metadata is never read for authorization anywhere in src", async () => {
  const offenders = [];
  for (const file of await walk(src)) {
    const text = await readFile(file, "utf8");
    if (/user_metadata\s*(\?\.|\.|\[)\s*["']?role|user_metadata:\s*\{\s*role/.test(text)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, []);
});

test("public sign-up can never produce an admin", async () => {
  // Nothing in the app signs users up, and roles are written only server-side.
  const writers = [];
  for (const file of await walk(src)) {
    const text = await readFile(file, "utf8");
    if (/\.auth\.signUp\(/.test(text)) writers.push(`${rel(file)}: signUp`);
    if (/app_metadata\s*:/.test(text) && !["src/lib/admin/users.ts", "src/lib/admin/demo.ts"].includes(rel(file))) {
      writers.push(`${rel(file)}: app_metadata write`);
    }
  }
  assert.deepEqual(writers, []);
  // Whatever a sign-up puts in user_metadata, the result is 403.
  for (const role of ["owner", "admin", "OWNER", "superuser"]) {
    const user = { ...USERS.signedInNoRole, user_metadata: { role, is_admin: true } };
    assert.equal(core.authorizePanelUser(user, "admin").status, 403, role);
  }
});

// ── Route-level behaviour with the real gates ────────────────────────────────
function importsOf(source) {
  const names = [];
  for (const m of source.matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+["'][^"']+["'];?\s*$/gm)) {
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const cleaned = part.trim().replace(/^type\s+/, "");
        if (!cleaned || part.trim().startsWith("type ")) continue;
        names.push(cleaned.split(/\s+as\s+/).pop().trim());
      }
    }
    const def = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    if (def) names.push(def);
  }
  return names;
}

async function loadWithDeps(file, deps) {
  let source = await read(file);
  const names = importsOf(source);
  source = source.replace(/^import\s[\s\S]*?["'];?\s*$/gm, "");
  const key = `__deps_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = deps;
  for (const n of names) assert.ok(n in deps, `${file}: missing test dependency ${n}`);
  return toModule(`const { ${names.join(", ")} } = globalThis["${key}"];\n${source}`);
}

const NextResponse = {
  json: (body, init = {}) => ({ body, status: init.status ?? 200, cookies: { set() {} } }),
};
const redirects = [];
function redirect(url) {
  redirects.push(url);
  throw new Error(`REDIRECT:${url}`);
}

let currentUser = null;
const authz = await loadWithDeps("src/lib/admin/authz.ts", {
  NextResponse, redirect, getPanelUser: async () => currentUser, authorizePanelUser: core.authorizePanelUser,
});

function spies() {
  const calls = [];
  const spy = (name, value) => async (...args) => { calls.push(name); return typeof value === "function" ? value(...args) : value; };
  return { calls, spy };
}

async function routeHarness(file, extra = {}) {
  const { calls, spy } = spies();
  const panelClient = { auth: {
    signInWithOtp: spy("signInWithOtp", { error: null }),
    verifyOtp: spy("verifyOtp", { error: null }),
  } };
  const deps = {
    NextResponse, NextRequest: class {}, z,
    requireAdminUser: authz.requireAdminUser, requireOwnerUser: authz.requireOwnerUser,
    hasSupabaseAdminEnv: () => true, isPanelDemo: () => false,
    DEMO_USERS: [], DEMO_USER: null, DEMO_MASKED_EMAIL: "",
    listAdminUsers: spy("listAdminUsers", []), createAdminWithPassword: spy("createAdminWithPassword", {}),
    deleteAdmin: spy("deleteAdmin", undefined), setAdminPassword: spy("setAdminPassword", undefined),
    createPanelServerClient: async () => panelClient,
    isVaultConfigured: () => true, listVaultEntries: spy("listVaultEntries", []),
    createVaultEntry: spy("createVaultEntry", undefined),
    issueStepUpToken: () => "step-up", STEP_UP_COOKIE: "c", STEP_UP_MAX_AGE: 60,
    ...extra,
  };
  const mod = await loadWithDeps(file, deps);
  return { mod, calls };
}

const request = (body = {}, search = "") => ({
  json: async () => body,
  nextUrl: new URL(`https://admin.toptik.co.il/api${search}`),
  headers: new Map(),
});

async function asUser(name, run) {
  currentUser = USERS[name];
  try { return await run(); } finally { currentUser = null; }
}

test("user management is owner-only: 401 anonymous, 403 for everyone else", async () => {
  const { mod, calls } = await routeHarness("src/app/api/panel/users/route.ts");
  const reset = await routeHarness("src/app/api/panel/users/reset/route.ts");
  const attempts = [
    () => mod.GET(),
    () => mod.POST(request({ email: "x@example.com", password: "0123456789ab" })),
    () => mod.DELETE(request({}, "?id=ow1")),
    () => reset.mod.POST(request({ id: "ow1", password: "0123456789ab" })),
  ];
  for (const [name, status] of [["anonymous", 401], ["signupForgedOwner", 403], ["signedInNoRole", 403],
    ["unconfirmedAppAdmin", 403], ["appAdmin", 403], ["legacyAdmin", 403]]) {
    for (const attempt of attempts) {
      const res = await asUser(name, attempt);
      assert.equal(res.status, status, `${name}`);
    }
  }
  assert.deepEqual([...calls, ...reset.calls], [], "no service-role operation was reached");
  // Owners (app_metadata or the legacy owner) reach the operations.
  for (const name of ["appOwner", "legacyOwner"]) {
    assert.equal((await asUser(name, () => mod.GET())).status, 200, name);
  }
  assert.deepEqual(calls, ["listAdminUsers", "listAdminUsers"]);
});

test("the vault needs an authorized admin first — an OTP alone never opens it", async () => {
  const challenge = await routeHarness("src/app/api/panel/vault/challenge/route.ts");
  const unlock = await routeHarness("src/app/api/panel/vault/unlock/route.ts");
  const stepUp = await loadWithDeps("src/lib/admin/vault-api.ts", {
    cookies: async () => ({ get: () => ({ value: "valid-step-up" }) }),
    NextResponse, requireAdminUser: authz.requireAdminUser,
    isVaultConfigured: () => true, verifyStepUpToken: () => true, STEP_UP_COOKIE: "c",
    isPanelDemo: () => false, DEMO_USER: null,
  });
  const vault = await routeHarness("src/app/api/panel/vault/route.ts", {
    authStepUp: stepUp.authStepUp, parseVaultInput: stepUp.parseVaultInput,
  });
  for (const [name, status] of [["anonymous", 401], ["signupForgedOwner", 403], ["signedInNoRole", 403], ["unconfirmedAppAdmin", 403]]) {
    assert.equal((await asUser(name, () => challenge.mod.POST())).status, status, `challenge ${name}`);
    assert.equal((await asUser(name, () => unlock.mod.POST(request({ code: "123456" })))).status, status, `unlock ${name}`);
    // Even with a valid step-up cookie, a non-admin is refused.
    assert.equal((await asUser(name, () => vault.mod.GET())).status, status, `vault ${name}`);
  }
  assert.deepEqual([...challenge.calls, ...unlock.calls, ...vault.calls], [], "no OTP sent or verified, no entries read");
  // An authorized admin gets the OTP flow and then the entries.
  assert.equal((await asUser("appAdmin", () => challenge.mod.POST())).status, 200);
  assert.equal((await asUser("legacyAdmin", () => unlock.mod.POST(request({ code: "123456" })))).status, 200);
  assert.equal((await asUser("appAdmin", () => vault.mod.GET())).status, 200);
  assert.deepEqual(challenge.calls, ["signInWithOtp"]);
  assert.deepEqual(unlock.calls, ["verifyOtp", "listVaultEntries"]);
  assert.deepEqual(vault.calls, ["listVaultEntries"]);
});

test("panel pages send non-admins away before rendering", async () => {
  redirects.length = 0;
  for (const [name, target] of [["anonymous", "/login"], ["signupForgedOwner", "/login?error=forbidden"], ["signedInNoRole", "/login?error=forbidden"]]) {
    await asUser(name, () => assert.rejects(authz.requireAdminPage(), /REDIRECT/));
    assert.equal(redirects.at(-1), target, name);
  }
  await asUser("appAdmin", () => assert.rejects(authz.requireOwnerPage(), /REDIRECT/));
  assert.deepEqual(await asUser("appAdmin", () => authz.requireAdminPage()), { user: USERS.appAdmin, role: "admin" });
  assert.deepEqual(await asUser("signupForgedOwner", () => authz.getPanelAccess()), { user: USERS.signupForgedOwner, role: null });
});

// ── Static: every entry point that reaches the service role is gated ────────
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolve(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(src, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(c)) return c;
  return null;
}

const valueImports = (source) =>
  [...source.matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["'];?\s*$/gm)].map((m) => ({ clause: m[1], spec: m[2] }));

// Signed third-party webhooks have their own HMAC/shop/topic gate. Keep it
// explicit here so privileged inbox writes cannot appear before verification.
const GATES = /\b(requireAdminUser|requireOwnerUser|requireAdminPage|requireOwnerPage|requireAdminToken|verifyProductWebhook|authStepUp|isValidSetupToken)\(/;
const HARMLESS = new Set(["isVaultConfigured", "STEP_UP_COOKIE", "STEP_UP_MAX_AGE", "parseVaultInput", "authStepUp", "requireAdminUser", "requireOwnerUser"]);

test("no route, page or server action reaches the service role without a gate", async () => {
  const files = await walk(src);
  // Modules that reach the service-role client, directly or transitively.
  const importsByFile = new Map();
  const sourceByFile = new Map();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    sourceByFile.set(file, source);
    importsByFile.set(file, valueImports(source).map((i) => ({ ...i, target: resolve(file, i.spec) })));
  }
  const privileged = new Set([path.join(src, "lib/supabase/service-role.ts")]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, imports] of importsByFile) {
      if (privileged.has(file)) continue;
      // authz.ts / admin-token.ts are gates, not privileged operations.
      if (imports.some((i) => i.target && privileged.has(i.target))) { privileged.add(file); grew = true; }
    }
  }
  const entryFiles = files.filter((f) => /[\\/](route|page)\.tsx?$/.test(f) || /^\s*["']use server["']/m.test(sourceByFile.get(f) ?? ""));
  const problems = [];
  const table = [];
  for (const file of entryFiles) {
    const source = sourceByFile.get(file) ?? "";
    if (/^\s*["']use server["']/m.test(source) && !GATES.test(source)) problems.push(`${rel(file)}: server action without gate`);
    const privNames = [];
    for (const imp of importsByFile.get(file)) {
      if (!imp.target || !privileged.has(imp.target)) continue;
      const braces = imp.clause.match(/\{([^}]*)\}/);
      for (const part of (braces ? braces[1].split(",") : [imp.clause])) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
        if (name && !part.trim().startsWith("type ") && !HARMLESS.has(name)) privNames.push(name);
      }
    }
    if (privNames.length === 0) continue;
    // Each exported handler must call a gate before the first privileged call.
    const handlers = [...source.matchAll(/export (?:default )?async function (\w*)\s*\(/g)];
    const factories = [...source.matchAll(/export const (\w+) = (createImportRouteHandler)\(/g)];
    for (const [i, h] of handlers.entries()) {
      const end = handlers[i + 1]?.index ?? source.length;
      const body = source.slice(h.index, end).split("\n").filter((line) => !/if \(isPanelDemo\(\)\)/.test(line)).join("\n");
      const privAt = Math.min(...privNames.map((n) => { const m = body.match(new RegExp(`\\b${n}\\(`)); return m ? m.index : Infinity; }));
      if (privAt === Infinity) continue;
      const gate = body.match(GATES);
      table.push(`${rel(file)} ${h[1] || "page"}: ${gate ? gate[1] : "NONE"}`);
      if (!gate || gate.index > privAt) problems.push(`${rel(file)} ${h[1] || "default"}: privileged call before gate`);
    }
    for (const f of factories) table.push(`${rel(file)} ${f[1]}: ${f[2]} (gated in import-handler)`);
  }
  // The import route factory gates first.
  const importer = await read("src/lib/import/import-handler.ts");
  const factoryBody = importer.slice(importer.indexOf("export function createImportRouteHandler"));
  assert.ok(factoryBody.indexOf("requireAdminToken(") > 0 && factoryBody.indexOf("requireAdminToken(") < factoryBody.indexOf("runAdminManufacturerImport("));
  assert.deepEqual(problems, []);
  assert.ok(table.length >= 15, `expected the privileged entry points to be found (${table.length})`);
});
