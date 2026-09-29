import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static import-graph guard (GAL-015 / GAL-025): client code and public routes
// must not reach the service-role client, directly or through other modules.
const root = fileURLToPath(new URL("../", import.meta.url));
const src = path.join(root, "src");
const rel = (file) => path.relative(root, file).split(path.sep).join("/");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveSpecifier(fromFile, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(src, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null; // package or node builtin
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`,
    path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && /\.(ts|tsx|js|mjs|json)$/.test(candidate)) return candidate;
  }
  return null;
}

// Value imports only: `import type` / `export type` are erased at build time.
function valueSpecifiers(source) {
  const specs = [];
  const patterns = [
    /^\s*import\s+(?!type\b)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+(?!type\b)[^'";]*?\s+from\s+["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) specs.push(match[1]);
  return specs;
}

async function reachable(entries) {
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const source = await readFile(file, "utf8");
    seen.set(file, source);
    if (file.endsWith(".json")) continue;
    for (const specifier of valueSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

const allFiles = await walk(src);
const clientEntries = [];
for (const file of allFiles) {
  if (/^\s*["']use client["']/.test(await readFile(file, "utf8"))) clientEntries.push(file);
}
const publicEntries = [
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/robots.ts",
  "src/app/carousel/page.tsx",
  "src/app/api/carousel/route.ts",
  "src/app/api/product-details/route.ts",
  "src/app/api/img-trim/route.ts",
  "src/app/api/debug-colors/route.ts",
  "src/app/api/debug-scrape/route.ts",
].map((file) => path.join(root, file));

const SERVICE_ROLE_MODULES = ["src/lib/supabase/service-role.ts", "src/lib/carousel/repository-admin.ts"];
const FORBIDDEN_TEXT = /createSupabaseServiceRoleClient|SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey/;

function assertNoServiceRole(graph, label) {
  const offenders = [];
  for (const [file, source] of graph) {
    const name = rel(file);
    if (SERVICE_ROLE_MODULES.includes(name) || FORBIDDEN_TEXT.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `${label} reaches service-role code: ${offenders.join(", ")}`);
}

test("client components never import the service-role module, directly or indirectly", async () => {
  assert.ok(clientEntries.length >= 10, "expected the app's client components to be discovered");
  assertNoServiceRole(await reachable(clientEntries), "client code");
});

test("public pages and public API routes never import the service-role module", async () => {
  assertNoServiceRole(await reachable(publicEntries), "public routes");
});

test("service-role and server clients are marked server-only", async () => {
  for (const file of ["src/lib/supabase/server.ts", "src/lib/supabase/service-role.ts"]) {
    assert.match(await readFile(path.join(root, file), "utf8"), /^import "server-only";/m, file);
  }
  const serverSource = await readFile(path.join(root, "src/lib/supabase/server.ts"), "utf8");
  assert.doesNotMatch(serverSource, FORBIDDEN_TEXT, "server.ts must hold only the public (anon) client");
});

test("the public catalog read path contains no database writes", async () => {
  const graph = await reachable([
    path.join(root, "src/app/api/carousel/route.ts"),
    path.join(root, "src/app/api/product-details/route.ts"),
  ]);
  for (const [file, source] of graph) {
    assert.doesNotMatch(source, /\.(insert|update|upsert|delete)\(|storage\.from\([^)]*\)\.(upload|remove)/, rel(file));
  }
});

test("admin writers still get the service-role client from its dedicated module", async () => {
  const admin = await readFile(path.join(root, "src/app/api/admin/carousel/route.ts"), "utf8");
  assert.match(admin, /from "@\/lib\/carousel\/repository-admin"/);
  const saver = await readFile(path.join(root, "src/lib/carousel/repository-admin.ts"), "utf8");
  assert.match(saver, /from "@\/lib\/supabase\/service-role"/);
  for (const file of allFiles) {
    const source = await readFile(file, "utf8");
    if (/createSupabaseServiceRoleClient/.test(source) && !file.endsWith(path.join("supabase", "service-role.ts"))) {
      assert.match(source, /from "@\/lib\/supabase\/service-role"/, `${rel(file)} must import the service role from service-role.ts`);
    }
  }
});
