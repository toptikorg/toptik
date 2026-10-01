import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import sharp from 'sharp';
const mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const core=mod(readFileSync('src/lib/shopify/media-sync-core.ts','utf8'));
const allow=mod(readFileSync('src/lib/catalog-source/source-allowlist.ts','utf8'));
const dns=mod('export const lookup=async(...args)=>globalThis.__source.dns(...args);');
const source=readFileSync('src/lib/shopify/media-source-bytes.ts','utf8').replace('import "server-only";','').replace('"sharp"',JSON.stringify(import.meta.resolve('sharp')))
  .replace('"node:dns/promises"',JSON.stringify(dns)).replace('"@/lib/catalog-source/source-allowlist"',JSON.stringify(allow)).replaceAll('"./media-sync-core"',JSON.stringify(core));
const {readVerifiedMediaSourceBytes,captureMediaSourceBytes}=await import(mod(source));
const identity={productId:'gid://shopify/Product/123',variantId:'gid://shopify/ProductVariant/456',itemId:'a0000000-0000-4000-8000-000000000001',
  exactGallerySku:'ABC',exactShopifySku:'ABC',productHandle:'abc'};
const bytes=await sharp({create:{width:16,height:24,channels:3,background:'#102030'}}).png().toBuffer();
const proof=()=>({identity,evidenceId:'g-source',url:'https://cdn.shopify.com/s/files/1/image.png?v=1',sha256:createHash('sha256').update(bytes).digest('hex'),
  mime:'image/png',width:16,height:24,byteLength:bytes.length});
async function run(fn){const prior=globalThis.fetch; const f=globalThis.__source={calls:[],dnsCalls:[],dns:async(...a)=>{f.dnsCalls.push(a);return [{address:'8.8.8.8',family:4}];},handler:async()=>new Response(bytes)};
  globalThis.fetch=async(...a)=>{f.calls.push(a);return f.handler(...a);};try{await fn(f);}finally{globalThis.fetch=prior;delete globalThis.__source;}}
test('actual pixel decode and SHA preserve exact bytes from approved Shopify URL',()=>run(async f=>{
  const p=proof(),result=await readVerifiedMediaSourceBytes(p,Date.now()+5000);assert.deepEqual(Buffer.from(result),bytes);assert.notEqual(result,bytes);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],p.url);assert.equal(f.calls[0][1].redirect,'error');assert.equal(f.calls[0][1].headers,undefined);assert.equal(f.calls[0][1].method,undefined);
}));
test('new source capture returns real decoded pixels and hash without trusting input metadata',()=>run(async f=>{
  const result=await captureMediaSourceBytes(identity,proof().url,Date.now()+5000);
  assert.equal(result.width,16);assert.equal(result.height,24);assert.equal(result.mime,'image/png');
  assert.equal(result.sha256,proof().sha256);assert.equal(result.byteLength,bytes.length);assert.deepEqual(Buffer.from(result.bytes),bytes);assert.equal(f.calls.length,1);
}));
test('new source capture cannot bless a PNG header with truncated pixels',()=>run(async f=>{
  f.handler=async()=>new Response(bytes.subarray(0,48));await assert.rejects(captureMediaSourceBytes(identity,proof().url,Date.now()+1000),/DECODE_FAILED/);
}));
test('existing exact project carousel image is allowed without rewriting its path',()=>run(async f=>{
  const p=proof();p.url='https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/original/product.png';
  await readVerifiedMediaSourceBytes(p,Date.now()+5000);assert.equal(f.calls[0][0],p.url);
}));
for(const address of ['https://other.supabase.co/storage/v1/object/public/carousel-media/x.png','https://cdn.shopify.com.evil.test/s/files/x',
  'http://cdn.shopify.com/s/files/x','https://cdn.shopify.com:444/s/files/x','https://user@cdn.shopify.com/s/files/x',
  'https://cdn.shopify.com/s/files/%2e%2e/x','https://cdn.shopify.com/s/files/x#x','https://127.0.0.1/s/files/x',
  'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/other/x'])test(`refuses source URL ${address}`,()=>run(async f=>{
    const p=proof();p.url=address;await assert.rejects(readVerifiedMediaSourceBytes(p,Date.now()+1000),/MEDIA_SOURCE_(URL|PROOF)_INVALID/);assert.equal(f.calls.length,0);assert.equal(f.dnsCalls.length,0);
  }));
test('any private DNS result blocks read',()=>run(async f=>{f.dns=async()=>[{address:'8.8.8.8',family:4},{address:'::1',family:6}];
  await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+1000),/DNS_UNSAFE/);assert.equal(f.calls.length,0);}));
test('HTTP errors and redirects stay unverified, no retries',()=>run(async f=>{for(const status of [302,404,500]){
  f.handler=async()=>new Response('x',{status});await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+1000),/READ_FAILED/);}
  assert.equal(f.calls.length,3);
}));
test('byte mismatch or false metadata never produces source bytes',()=>run(async f=>{
  for(const change of [p=>p.sha256='f'.repeat(64),p=>p.width++,p=>p.mime='image/webp',p=>p.byteLength++]){const p=proof();change(p);await assert.rejects(readVerifiedMediaSourceBytes(p,Date.now()+1000),/BYTES_CHANGED|DECODE_FAILED/);}
  assert.equal(f.calls.length,4);
}));
test('valid PNG header with truncated pixels is not decoded evidence',()=>run(async f=>{
  const broken=bytes.subarray(0,48);f.handler=async()=>new Response(broken);const p=proof();p.byteLength=broken.length;p.sha256=createHash('sha256').update(broken).digest('hex');
  await assert.rejects(readVerifiedMediaSourceBytes(p,Date.now()+1000),/DECODE_FAILED/);
}));
test('oversized and extra streamed bytes are rejected',()=>run(async f=>{
  f.handler=async()=>new Response(bytes,{headers:{'content-length':String(8388609)}});await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+1000),/READ_FAILED/);
  f.handler=async()=>new Response(Buffer.concat([bytes,Buffer.from('extra')]));await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+1000),/READ_FAILED/);
}));
test('expired or hanging DNS is bounded without a GET',()=>run(async f=>{
  await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()-1),/TIME_BUDGET/);assert.equal(f.dnsCalls.length,0);
  f.dns=()=>new Promise(()=>{});await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+15),/TIME_BUDGET/);assert.equal(f.calls.length,0);
}));
