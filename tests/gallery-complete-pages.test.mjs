import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(new URL("../src/lib/carousel/read-complete-pages.ts", import.meta.url), "utf8");
const { readCompletePages } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

test("reads all 1,237 angles with a simulated 1,000-row server cap", async () => {
  const rows = Array.from({ length: 1237 }, (_, i) => ({ id: String(i) }));
  const calls = [];
  const result = await readCompletePages(async (from, to) => {
    calls.push([from, to]);
    return { data: rows.slice(from, Math.min(to + 1, from + 1000)), count: rows.length, error: null };
  });
  assert.deepEqual(result, rows);
  assert.deepEqual(calls, [[0, 499], [500, 999], [1000, 1499]]);
});
test("respects a lower server cap without mistaking a short page for completion", async () => {
  const rows = Array.from({ length: 251 }, (_, i) => ({ id: String(i) }));
  assert.deepEqual(await readCompletePages(async from => ({ data: rows.slice(from, from + 100), count: 251, error: null })), rows);
});
test("empty catalog is complete", async () => {
  assert.deepEqual(await readCompletePages(async () => ({ data: [], count: 0, error: null })), []);
});

test("public 1000-row pages remain complete above and below the server cap", async () => {
  const rows = Array.from({length:1253}, (_, i) => ({id:String(i)}));
  for (const cap of [1000, 300]) {
    const calls=[];
    const actual=await readCompletePages(async (from,to)=>{
      calls.push([from,to]);
      return {data:rows.slice(from,Math.min(to+1,from+cap)),count:rows.length,error:null};
    },100_000,1000);
    assert.deepEqual(actual,rows);
    assert.equal(calls.length,Math.ceil(rows.length/cap));
  }
});
for (const [label, second] of Object.entries({
  failure: { data: null, count: null, error: new Error("read failed") },
  truncated: { data: [], count: 2, error: null },
  changedCount: { data: [{ id: "b" }], count: 3, error: null },
  duplicate: { data: [{ id: "a" }], count: 2, error: null },
  missingCount: { data: [{ id: "b" }], count: null, error: null },
})) test(`rejects ${label} instead of returning a saveable partial snapshot`, async () => {
  let n = 0;
  await assert.rejects(readCompletePages(async () => n++ ? second : { data: [{ id: "a" }], count: 2, error: null }), /GALLERY_READ_INCOMPLETE/);
});
