import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import sharp from 'sharp';
const mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(resolveImageLimits(s))).toString('base64');
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
test('25MP original bytes decode without resizing the source; greater pixel count is rejected',()=>run(async f=>{
  const original=await sharp({create:{width:5000,height:5000,channels:3,background:'#102030'}}).png().toBuffer();
  f.handler=async()=>new Response(original);
  const value=await captureMediaSourceBytes(identity,proof().url,Date.now()+10000);
  assert.equal(value.width,5000);assert.equal(value.height,5000);
  assert.deepEqual(Buffer.from(value.bytes),original);
  assert.equal(value.sha256,createHash('sha256').update(original).digest('hex'));
  const tooLarge=await sharp({create:{width:5001,height:5000,channels:3,background:'#102030'}}).png().toBuffer();
  f.handler=async()=>new Response(tooLarge);
  await assert.rejects(captureMediaSourceBytes(identity,proof().url,Date.now()+10000),/DECODE_FAILED/);
}));
test('proof bounds retain the edge and byte limits independently of the 25MP ceiling',()=>run(async f=>{
  for(const change of [p=>{p.width=5001;p.height=5000;},p=>{p.width=16001;p.height=1;},p=>p.byteLength=8388609]){
    const p=proof();change(p);await assert.rejects(readVerifiedMediaSourceBytes(p,Date.now()+1000),/PROOF_INVALID/);
  }
  assert.equal(f.calls.length,0);assert.equal(f.dnsCalls.length,0);
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
test('oversized sources get their own PERMANENT code; extra streamed bytes stay a read failure',()=>run(async f=>{
  f.handler=async()=>new Response(bytes,{headers:{'content-length':String(8388609)}});await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+1000),/BYTE_LIMIT/);
  f.handler=async()=>new Response(Buffer.concat([bytes,Buffer.from('extra')]));await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+1000),/READ_FAILED/);
  f.handler=async()=>new Response(new ReadableStream({start(c){const big=new Uint8Array(1024*1024);for(let i=0;i<9;i++)c.enqueue(big);c.close();}}));
  const giant=proof();giant.byteLength=8388608;await assert.rejects(readVerifiedMediaSourceBytes(giant,Date.now()+5000),/BYTE_LIMIT/);
  f.handler=async()=>{const r=new Response(bytes);Object.defineProperty(r,'body',{value:{getReader:()=>({read:async()=>{throw new Error('socket reset');},cancel:async()=>{}}),cancel:async()=>{}}});return r;};
  await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+1000),/READ_FAILED/);
}));
test('expired or hanging DNS is bounded without a GET',()=>run(async f=>{
  await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()-1),/TIME_BUDGET/);assert.equal(f.dnsCalls.length,0);
  f.dns=()=>new Promise(()=>{});await assert.rejects(readVerifiedMediaSourceBytes(proof(),Date.now()+15),/TIME_BUDGET/);assert.equal(f.calls.length,0);
}));

const coreApi = await import(core);
const photo = (dx = 0) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#ffffff"/>
  <rect x="${150 + dx}" y="120" width="300" height="520" rx="40" fill="#20303f"/><rect x="${270 + dx}" y="60" width="60" height="80" fill="#5a4630"/>
  <circle cx="${200 + dx}" cy="660" r="28" fill="#111"/><circle cx="${400 + dx}" cy="660" r="28" fill="#111"/><rect x="${280 + dx}" y="300" width="40" height="40" fill="#c08040"/></svg>`);
const encode = async (svg, fmt, pad) => { let p = sharp(svg); if (pad) p = sharp(await p.png().toBuffer()).extend({ top: pad, bottom: pad, left: pad * 2, right: pad * 2, background: '#ffffff' }); return fmt === 'jpeg' ? p.jpeg({ quality: 80 }).toBuffer() : fmt === 'webp' ? p.webp({ quality: 75 }).toBuffer() : p.png().toBuffer(); };
const captureVisual = async buf => { let out; await run(async f => { f.handler = async () => new Response(buf); out = await captureMediaSourceBytes(identity, proof().url, Date.now() + 10000); }); return out.visual; };
test('capture returns a 32x32 RGB fingerprint; the same photo re-encoded and re-padded stays within the duplicate distance', async () => {
  const png = await captureVisual(await encode(photo(), 'png', 0));
  assert.match(png, /^(?:[a-f0-9]{2}){9216}$/);
  // Pads beyond ~12% of razor-edge synthetic art drift just past the limit (2.72 at pad 120); the
  // fingerprint finds CANDIDATES for review, so a heavy-crop/heavy-pad miss is accepted by design.
  for (const [fmt, pad] of [['jpeg', 0], ['webp', 0], ['jpeg', 40], ['webp', 90]]) {
    const other = await captureVisual(await encode(photo(), fmt, pad));
    assert.ok(coreApi.mediaVisualDistance(png, other) <= coreApi.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, `${fmt} pad ${pad}: ${coreApi.mediaVisualDistance(png, other)}`);
  }
});
test('tone and colourspace round-trips of the same photo stay within the duplicate distance', async () => {
  const base = await encode(photo(), 'jpeg', 0), png = await captureVisual(base);
  const variants = {
    brighter: await sharp(base).linear(1, 2).jpeg({ quality: 90 }).toBuffer(),
    gamma: await sharp(base).gamma(2.2, 2.0).jpeg({ quality: 90 }).toBuffer(),
    cmyk: await sharp(base).toColourspace('cmyk').jpeg().toBuffer(),
    squareCanvas: await sharp(base).flatten({ background: '#fff' }).resize(800, 800, { fit: 'contain', background: '#ffffff' }).jpeg().toBuffer(),
    resized: await sharp(base).resize(300).webp({ quality: 80 }).toBuffer(),
  };
  for (const [name, buf] of Object.entries(variants)) {
    const d = coreApi.mediaVisualDistance(png, await captureVisual(buf));
    assert.ok(d <= coreApi.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, `${name}: ${d}`);
  }
});
const sideView = () => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#ffffff"/>
  <rect x="230" y="120" width="140" height="520" rx="30" fill="#20303f"/><rect x="285" y="40" width="30" height="100" fill="#5a4630"/>
  <circle cx="300" cy="660" r="28" fill="#111"/></svg>`);
test('a different photo of the same object (another angle) is beyond the duplicate distance', async () => {
  const a = await captureVisual(await encode(photo(), 'png', 0)), b = await captureVisual(await encode(sideView(), 'png', 0));
  assert.ok(coreApi.mediaVisualDistance(a, b) > coreApi.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, String(coreApi.mediaVisualDistance(a, b)));
});
test('greyscale, transparent and fully uniform images still give a 3-channel fingerprint', async () => {
  const grey = await sharp(photo()).greyscale().png().toBuffer();
  const transparent = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const uniform = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } }).png().toBuffer();
  for (const buf of [grey, transparent, uniform]) assert.match(await captureVisual(buf), /^(?:[a-f0-9]{2}){9216}$/);
});
test('EXIF orientation is applied before fingerprinting: a tagged photo matches the physically rotated one', async () => {
  const upright = await sharp(photo()).rotate(90).jpeg({ quality: 85 }).toBuffer();
  const tagged = await sharp(photo()).jpeg({ quality: 85 }).withMetadata({ orientation: 6 }).toBuffer();
  const d = coreApi.mediaVisualDistance(await captureVisual(upright), await captureVisual(tagged));
  assert.ok(d <= coreApi.MEDIA_VISUAL_DUPLICATE_MAX_DISTANCE, String(d));
});
