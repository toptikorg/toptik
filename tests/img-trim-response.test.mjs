import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import sharp from "sharp";

const source = stripTypeScriptTypes((await readFile(new URL("../src/app/api/img-trim/route.ts", import.meta.url), "utf8"))
  .replace(/import[^\n]+\n/g, ""))
  .replace(/export /g, "");
const routeFactory = new Function("sharp", "NextResponse", "fetch", `${source}\nreturn GET;`);
class TestResponse extends Response {
  static json(value, init) { return Response.json(value, init); }
}
const request = {nextUrl:new URL("https://gallery.example/api/img-trim?u=" +
  encodeURIComponent("https://example.supabase.co/storage/v1/object/public/images/item.jpg") + "&w=720")};

test("a valid photo stays a decodable image even when crop has no visible subject", async () => {
  const photo = await sharp({create:{width:80,height:80,channels:3,background:"white"}}).png().toBuffer();
  const get = routeFactory(sharp, TestResponse, async()=>new Response(photo));
  const result = await get(request);
  assert.equal(result.status,200);
  assert.equal(result.headers.get("content-type"),"image/webp");
  const pixels = await sharp(Buffer.from(await result.arrayBuffer())).raw().toBuffer();
  assert.ok(pixels.length>0);
});

test("non-image upstream 200 is rejected, not cached as an immutable successful WebP", async () => {
  const get = routeFactory(sharp, TestResponse, async()=>new Response("<html>service unavailable</html>"));
  const result = await get(request);
  assert.equal(result.status,502);
  assert.equal(result.headers.get("cache-control"),"no-store");
  assert.deepEqual(await result.json(),{error:"invalid source image"});
});

test("source errors and timeouts are non-cacheable failures for client fallback", async () => {
  for(const fetcher of [async()=>new Response("unavailable",{status:503}),async()=>{throw new Error("timeout")}]) {
    const result=await routeFactory(sharp,TestResponse,fetcher)(request);
    assert.equal(result.status,502);
    assert.equal(result.headers.get("cache-control"),"no-store");
  }
});

test("image repair preserves the existing upstream host restriction", async () => {
  const get=routeFactory(sharp,TestResponse,async()=>{throw new Error("must not fetch")});
  const result=await get({nextUrl:new URL("https://gallery.example/api/img-trim?u=https://other.example/image.jpg")});
  assert.equal(result.status,403);
});
