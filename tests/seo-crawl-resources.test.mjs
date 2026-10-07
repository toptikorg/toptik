import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import sharp from "sharp";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const load = async path => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(await read(path))).toString("base64")}`);
const robots = (await load("src/app/robots.ts")).default();
const config = (await load("next.config.ts")).default;
const rules = robots.rules;
const matches = (pattern, path) => new RegExp("^" + pattern
  .replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).test(path);
const permitted = path => [...rules.allow.map(pattern => ({pattern, allow:true})),
  ...[rules.disallow].flat().map(pattern => ({pattern, allow:false}))]
  .filter(r => matches(r.pattern,path)).sort((a,b) => b.pattern.length-a.pattern.length || Number(b.allow)-Number(a.allow))[0]?.allow ?? true;

test("robots permits the exact public JSON and image resources needed for rendering", () => {
  for (const path of ["/carousel", "/api/carousel", "/api/carousel?", "/api/carousel?v=1",
    "/api/img-trim?u=https%3A%2F%2Fekgpaoavsavrtbhlbwdg.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fcarousel-media%2Fphoto.jpg&w=720&v=3"])
    assert.equal(permitted(path),true,path);
});

test("public-resource exceptions do not expose sibling, admin, or arbitrary API paths", () => {
  for (const path of ["/api/carousel-extra", "/api/carousel/private", "/api/carousel-admin?x=1",
    "/api/img-trim", "/api/img-trim-other?u=x", "/api/img-trim/private?u=x", "/api/admin/carousel",
    "/api/panel/users", "/api/product-details?url=x", "/api/debug-scrape"])
    assert.equal(permitted(path),false,path);
});

test("JSON endpoints and private surfaces retain their generic noindex headers", async () => {
  const headers=await config.headers();
  for (const source of ["/api", "/api/:path((?!img-trim$).*)", "/admin/:path*", "/dashboard/:path*"])
    assert.equal(headers.find(r=>r.source===source)?.headers.find(h=>h.key==="X-Robots-Tag")?.value,"noindex, nofollow");
  assert.equal(headers.find(r=>r.has?.some(h=>h.type==="host"&&h.value==="admin.toptik.co.il"))?.headers[0].value,"noindex, nofollow");
});

const source=stripTypeScriptTypes((await read("src/app/api/img-trim/route.ts")).replace(/import[^\n]+\n/g,""))
  .replace(/export /g, "");
const factory=new Function("sharp","NextResponse","fetch",`${source}\nreturn GET;`);
class TestResponse extends Response { static json(value,init) { return Response.json(value,init); } }
const photo=await sharp({create:{width:80,height:80,channels:3,background:"white"}}).png().toBuffer();
const exact="https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/imports/product.jpg";
const request=(host,source=exact)=>({nextUrl:new URL(`https://${host}/api/img-trim?u=${encodeURIComponent(source)}&w=720`),headers:new Headers({host})});

test("only successfully decoded canonical catalog images explicitly permit indexing", async () => {
  const result=await factory(sharp,TestResponse,async()=>new Response(photo))(request("landing.toptik.co.il"));
  assert.equal(result.status,200);
  assert.equal(result.headers.get("X-Robots-Tag"),"index, follow");
  assert.equal(result.headers.get("content-type"),"image/webp");
  assert.ok((await sharp(Buffer.from(await result.arrayBuffer())).metadata()).width>0);
});

test("preview, admin, other Supabase projects and other buckets remain noindex", async () => {
  const get=factory(sharp,TestResponse,async()=>new Response(photo));
  for(const req of [request("admin.toptik.co.il"), request("preview.vercel.app"),
    request("landing.toptik.co.il",exact.replace("ekgpaoavsavrtbhlbwdg","another")),
    request("landing.toptik.co.il",exact.replace("carousel-media","another-bucket"))]) {
    const result=await get(req);assert.equal(result.status,200);
    assert.equal(result.headers.get("X-Robots-Tag"),"noindex, nofollow");
  }
});

test("errors never carry the successful image indexing override", async () => {
  for(const fetcher of [async()=>new Response("<html>not an image</html>"),async()=>new Response("missing",{status:404})]) {
    const result=await factory(sharp,TestResponse,fetcher)(request("landing.toptik.co.il"));
    assert.equal(result.status,502);assert.equal(result.headers.get("X-Robots-Tag"),"noindex, nofollow");
  }
  const denied=await factory(sharp,TestResponse,async()=>{throw new Error("must not fetch")})(request("landing.toptik.co.il","https://unapproved.example/photo.jpg"));
  assert.equal(denied.status,403);assert.equal(denied.headers.get("X-Robots-Tag"),"noindex, nofollow");
});
