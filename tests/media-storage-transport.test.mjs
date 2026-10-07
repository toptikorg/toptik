import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import sharp from 'sharp';
const url=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolveImageLimits(source))).toString('base64')}`;
const read=name=>readFileSync(`src/lib/shopify/${name}.ts`,'utf8');
const core=url(read('media-sync-core')),raw=url(read('media-transport-read').replaceAll('"./media-sync-core"',JSON.stringify(core)));
const requests=url(read('media-transport-requests').replaceAll('"./media-transport-read"',JSON.stringify(raw)));
const allow=url(readFileSync('src/lib/catalog-source/source-allowlist.ts','utf8'));
const dns=url('export const lookup=async()=>{globalThis.__storage.dnsCalls++;return globalThis.__storage.addresses;}');
const env=url('export const supabaseEnv={publicUrl:"https://ekgpaoavsavrtbhlbwdg.supabase.co",serviceRoleKey:"test-only-key"}; export const hasSupabaseAdminEnv=()=>true;');
const {supabaseEnv:envFixture}=await import(env);
const diagnostics=url(read('media-storage-diagnostics'));
const code=read('media-storage-transport').replace('import "server-only";','').replace('"sharp"',JSON.stringify(import.meta.resolve('sharp')))
 .replace('"node:dns/promises"',JSON.stringify(dns)).replace('"@/lib/catalog-source/source-allowlist"',JSON.stringify(allow))
 .replace('"@/lib/supabase/env"',JSON.stringify(env)).replaceAll('"./media-transport-requests"',JSON.stringify(requests))
 .replace('"./media-storage-diagnostics"',JSON.stringify(diagnostics));
const {uploadImmutableMedia,readImmutableMedia,assertImmutableMediaUploadPreflight}=await import(url(code));
const {mediaStorageDiagnostic,MediaStorageFailure}=await import(diagnostics);
const {stagedMediaUrl}=await import(requests);
const identity={productId:'gid://shopify/Product/123',variantId:'gid://shopify/ProductVariant/456',itemId:'a0000000-0000-4000-8000-000000000001',
 exactGallerySku:'ABC',exactShopifySku:'ABC',productHandle:'product'};
const bytes=await sharp({create:{width:16,height:24,channels:3,background:'#654321'}}).png().toBuffer();
function source(){const sha=createHash('sha256').update(bytes).digest('hex');return {identity,contentSha256:sha,mime:'image/png',byteLength:bytes.length,width:16,height:24,
 url:stagedMediaUrl(identity,sha,'image/png'),receiptId:'private-proof'};}
async function run(fn,key='test-only-key'){const fetchBefore=globalThis.fetch,vercel=process.env.VERCEL_ENV,flag=process.env.SHOPIFY_MEDIA_SYNC,previousKey=envFixture.serviceRoleKey,previousUrl=envFixture.publicUrl;
 const f=globalThis.__storage={dnsCalls:0,addresses:[{address:'8.8.8.8',family:4}],calls:[],handler:()=>new Response(bytes,{status:200})};
 globalThis.fetch=async(...args)=>{f.calls.push(args);return f.handler(...args);};process.env.VERCEL_ENV='production';process.env.SHOPIFY_MEDIA_SYNC='enabled_v1';envFixture.serviceRoleKey=key;
 try{await fn(f);}finally{globalThis.fetch=fetchBefore;envFixture.serviceRoleKey=previousKey;envFixture.publicUrl=previousUrl;if(vercel===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=vercel;
  if(flag===undefined)delete process.env.SHOPIFY_MEDIA_SYNC;else process.env.SHOPIFY_MEDIA_SYNC=flag;delete globalThis.__storage;}}

test('CRLF and surrounding whitespace normalize like SDK while POST stays pinned and immutable',()=>run(async f=>{
 for(const value of ['https://ekgpaoavsavrtbhlbwdg.supabase.co\r\n',' \thttps://ekgpaoavsavrtbhlbwdg.supabase.co/\n']){
  envFixture.publicUrl=value;assertImmutableMediaUploadPreflight(source(),Date.now()+10000);
  assert.deepEqual(await uploadImmutableMedia(source(),bytes,Date.now()+10000),{outcome:'accepted'});
 }
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(([address,init])=>address===source().url.replace('/object/public/','/object/') && init.headers['x-upsert']==='false'));
}));

test('whitespace normalization never authorizes a different origin, path, credentials or protocol',()=>run(async f=>{
 for(const value of ['https://other.supabase.co\r\n','https://ekgpaoavsavrtbhlbwdg.supabase.co.attacker.test',
  'https://ekgpaoavsavrtbhlbwdg.supabase.co/a','https://user@ekgpaoavsavrtbhlbwdg.supabase.co','http://ekgpaoavsavrtbhlbwdg.supabase.co']){
  envFixture.publicUrl=value;assert.throws(()=>assertImmutableMediaUploadPreflight(source(),Date.now()+10000),/CONFIGURATION_INVALID/);
  await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),error=>{
   assert.deepEqual(mediaStorageDiagnostic(error,'upload'),{code:'MEDIA_STORAGE_CONFIGURATION_INVALID',stage:'preflight',httpStatus:null});return true;
  });
 }
 assert.equal(f.calls.length,0);assert.equal(f.dnsCalls,0);
}));

test('upload diagnostics retain only allowlisted code, stage and HTTP status',()=>run(async f=>{
 f.handler=()=>new Response('secret body and private credentials',{status:403});
 await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),error=>{
  assert.deepEqual(mediaStorageDiagnostic(error,'upload'),{code:'MEDIA_STORAGE_UPLOAD_UNCONFIRMED',stage:'upload',httpStatus:403});
  assert.ok(!JSON.stringify(error).includes('secret'));return true;
 });
 assert.deepEqual(mediaStorageDiagnostic(Error('private message'),'upload'),{code:'MEDIA_STORAGE_UPLOAD_UNCONFIRMED',stage:'upload',httpStatus:null});
 assert.equal(new MediaStorageFailure(Error('MEDIA_STORAGE_READ_FAILED'),'readback',NaN).diagnostic.httpStatus,null);
 assert.equal(f.calls.length,1);
}));
test('one immutable upload uses exact decoded bytes, pinned project and non-overwrite POST; no completion claim',()=>run(async f=>{
 const s=source();assert.deepEqual(await uploadImmutableMedia(s,bytes,Date.now()+10000),{outcome:'accepted'});
 assert.equal(f.calls.length,1);const [address,init]=f.calls[0];assert.equal(address,s.url.replace('/object/public/','/object/'));
 assert.equal(init.method,'POST');assert.equal(init.headers['x-upsert'],'false');assert.equal(init.headers['content-type'],'image/png');
 assert.equal(init.headers.apikey,'test-only-key');assert.equal(init.headers.authorization,'Bearer test-only-key');
 assert.equal(init.redirect,'error');assert.deepEqual(Buffer.from(init.body),bytes);assert.ok(init.signal instanceof AbortSignal);
}));
test('opaque secret key upload uses apikey without putting a non-JWT in Bearer',()=>run(async f=>{
 const s=source();assert.deepEqual(await uploadImmutableMedia(s,bytes,Date.now()+10000),{outcome:'accepted'});
 assert.equal(f.calls.length,1);const [address,init]=f.calls[0];assert.equal(address,s.url.replace('/object/public/','/object/'));
 assert.equal(init.headers.apikey,'sb_secret_test-only-key');assert.equal(Object.hasOwn(init.headers,'authorization'),false);
 assert.equal(init.method,'POST');assert.equal(init.headers['x-upsert'],'false');assert.equal(init.redirect,'error');
 assert.deepEqual(Buffer.from(init.body),bytes);
},'sb_secret_test-only-key'));
for(const [kind,key] of [['legacy','test-only-key'],['opaque','sb_secret_test-only-key']]){
 test(`${kind} key readback decodes all bytes with no credential headers`,()=>run(async f=>{
  const s=source(),result=await readImmutableMedia(s,Date.now()+10000);assert.equal(result.sha256,s.contentSha256);assert.equal(result.storagePath,`sync-media/${identity.itemId}/${s.contentSha256}.png`);
  assert.equal(result.width,16);assert.equal(result.height,24);assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].headers,undefined);
 },key));
 test(`${kind} key rejection is sanitized and never retries or exposes the provider body`,()=>run(async f=>{
  f.handler=()=>new Response(`private provider rejection ${key}`,{status:401});
  await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),e=>e.message==='MEDIA_STORAGE_UPLOAD_UNCONFIRMED');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].headers['x-upsert'],'false');
 },key));
}
test('owned 25MP source readback preserves exact bytes, while over-limit source metadata is rejected',()=>run(async f=>{
 const original=await sharp({create:{width:5000,height:5000,channels:3,background:'#654321'}}).png().toBuffer();
 const s={...source(),width:5000,height:5000,byteLength:original.length,contentSha256:createHash('sha256').update(original).digest('hex')};
 s.url=stagedMediaUrl(identity,s.contentSha256,s.mime);f.handler=()=>new Response(original);
 const actual=await readImmutableMedia(s,Date.now()+10000);assert.equal(actual.width,5000);assert.equal(actual.height,5000);assert.equal(actual.sha256,s.contentSha256);
 for(const change of [p=>p.width=5001,p=>{p.width=16001;p.height=1;},p=>p.byteLength=8388609]){
  const bad={...s};change(bad);await assert.rejects(readImmutableMedia(bad,Date.now()+10000),/SOURCE_INVALID/);
 }
 assert.equal(f.calls.length,1);
}));
test('lost write response never retries; later exact readback is a separate read-only recovery',()=>run(async f=>{
 f.handler=()=>{throw Error('private provider message');};await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),e=>e.message==='MEDIA_STORAGE_UPLOAD_UNCONFIRMED');
 assert.equal(f.calls.length,1);f.handler=()=>new Response(bytes);assert.equal((await readImmutableMedia(source(),Date.now()+10000)).byteLength,bytes.length);
 assert.equal(f.calls.length,2);assert.equal(f.calls[1][1].method,undefined);
}));
test('existing object conflict cannot become upsert, overwrite, or retry',()=>run(async f=>{
 f.handler=()=>new Response('exists',{status:409});await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),/UNCONFIRMED/);
 assert.equal(f.calls.length,1);
}));
test('write feature flags, unsafe DNS and unsupported live MIME stop upload',()=>run(async f=>{
 delete process.env.SHOPIFY_MEDIA_SYNC;await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),/DISABLED/);
 process.env.SHOPIFY_MEDIA_SYNC='enabled_v1';process.env.VERCEL_ENV='preview';await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),/DISABLED/);
 process.env.VERCEL_ENV='production';const avif={...source(),mime:'image/avif'};avif.url=stagedMediaUrl(identity,avif.contentSha256,avif.mime);
 await assert.rejects(uploadImmutableMedia(avif,bytes,Date.now()+10000),/MIME_NOT_ENABLED/);
 f.addresses=[{address:'127.0.0.1',family:4}];await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()+10000),/DNS_UNSAFE/);
 assert.equal(f.calls.length,0);
}));
test('wrong bytes, claimed dimensions, or arbitrary source path never authorize upload',()=>run(async f=>{
 for(const s of [{...source(),width:17},{...source(),byteLength:bytes.length+1}])await assert.rejects(uploadImmutableMedia(s,bytes,Date.now()+10000),/BYTES_CHANGED/);
 await assert.rejects(uploadImmutableMedia({...source(),url:'https://example.com/a.png'},bytes,Date.now()+10000),/SOURCE_INVALID/);
 await assert.rejects(uploadImmutableMedia(source(),Buffer.from('not an image'),Date.now()+10000),/DECODE_FAILED/);assert.equal(f.calls.length,0);
}));
test('readback corrupt or different image remains unverified',()=>run(async f=>{
 f.handler=()=>new Response('broken');await assert.rejects(readImmutableMedia(source(),Date.now()+10000),/DECODE_FAILED/);
 f.handler=()=>new Response(bytes);await assert.rejects(readImmutableMedia({...source(),width:17},Date.now()+10000),/BYTES_CHANGED/);
}));
test('stream beyond cap and non-200 reads fail without write',()=>run(async f=>{
 f.handler=()=>new Response(bytes,{headers:{'content-length':String(8*1024*1024+1)}});await assert.rejects(readImmutableMedia(source(),Date.now()+10000),/READ_FAILED/);
 f.handler=()=>new Response('missing',{status:404});await assert.rejects(readImmutableMedia(source(),Date.now()+10000),/READ_FAILED/);
 assert.ok(f.calls.every(c=>!c[1].method));
}));
test('expired deadline never dispatches source read or upload',()=>run(async f=>{
 await assert.rejects(readImmutableMedia(source(),Date.now()-1),/TIME_BUDGET/);
 await assert.rejects(uploadImmutableMedia(source(),bytes,Date.now()-1),/TIME_BUDGET/);assert.equal(f.calls.length,0);
}));
