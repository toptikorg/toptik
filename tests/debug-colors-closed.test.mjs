import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("the public debug-colors route is closed: 404, no data access", async () => {
  const route = await read("src/app/api/debug-colors/route.ts");
  assert.match(route, /status: 404/);
  assert.match(route, /export const GET = NOT_FOUND;/);
  assert.doesNotMatch(route, /getCarouselPayload|repository|supabase|buildItemColorGroups|fetch\(/);
});

test("nothing in src calls /api/debug-colors", async () => {
  const offenders = [];
  const walk = async (dir) => {
    for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${e.name}`;
      if (e.isDirectory()) await walk(`${rel}/`);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && rel !== "src/app/api/debug-colors/route.ts") {
        if (/api\/debug-colors/.test(await read(rel))) offenders.push(rel);
      }
    }
  };
  await walk("src/");
  assert.deepEqual(offenders, []);
});
