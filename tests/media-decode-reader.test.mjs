import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source=readFileSync(new URL('../src/lib/shopify/media-decode-reader.ts',import.meta.url),'utf8');
const {readDecodedMedia}=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const identity={productId:'gid://shopify/Product/1',variantId:'gid://shopify/ProductVariant/1',itemId:'6f887176-e70a-44ba-b252-238f994b66ad',
  exactGallerySku:'g1',exactShopifySku:'s1',productHandle:'p1'};
const read=()=>({identity:structuredClone(identity),updatedAt:'2026-09-30T17:00:00Z',fingerprint:'a'.repeat(64),images:[1,2,3,4,5].map(n=>({
  mediaId:`gid://shopify/MediaImage/${n}`,imageId:`gid://shopify/ImageSource/${n}`,url:`https://cdn.shopify.com/s/files/a${n}.jpg`,width:100,height:200,
  alt:null,updatedAt:'2026-09-30T17:00:00Z',variantAssigned:n===1})),variantMediaIds:['gid://shopify/MediaImage/1'],variantImageId:'gid://shopify/ProductImage/10',variantImageUrl:'https://cdn.shopify.com/s/files/a1.jpg'});
const decoded=i=>({mediaGid:i.mediaId,url:i.url,width:i.width,height:i.height,sha256:'b'.repeat(64),byteLength:1000,mime:'image/jpeg'});
const deps=()=>({now:()=>100,read:async()=>read(),decode:async i=>decoded(i)});

test('complete decoded batch is bounded to two parallel reads and rechecks source',async()=>{
 let active=0,max=0,reads=0;
 const d=deps();d.read=async()=>{reads++;return read();};d.decode=async i=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return decoded(i);};
 const result=await readDecodedMedia(identity,50000,d);assert.equal(result.decoded.length,5);assert.equal(max,2);assert.equal(reads,2);
 assert.equal(result.decoded[0].key,undefined);assert.equal(result.decoded[0].contentId,undefined);
});
test('read-only decoder receives original deadline capped rather than refreshed',async()=>{
 const d=deps(),deadlines=[];d.read=async(_,deadline)=>{deadlines.push(deadline);return read();};d.decode=async(i,deadline)=>{deadlines.push(deadline);return decoded(i);};
 await readDecodedMedia(identity,100000,d);assert.deepEqual([...new Set(deadlines)],[45100]);
});
test('already expired request performs no network read',async()=>{
 const d=deps();d.read=async()=>{throw Error('called');};await assert.rejects(readDecodedMedia(identity,100,d),/MEDIA_TIME_BUDGET/);
});
test('no partial success on a failed image',async()=>{
 const d=deps();let reads=0;d.read=async()=>{reads++;return read();};d.decode=async i=>{if(i.mediaId.endsWith('/3'))throw Error('DECODE_FAILED');return decoded(i);};
 await assert.rejects(readDecodedMedia(identity,10000,d),/DECODE_FAILED/);assert.equal(reads,1);
});
test('source drift during decode prevents returning outdated batch',async()=>{
 const d=deps();let calls=0;d.read=async()=>{const r=read();if(calls++)r.fingerprint='c'.repeat(64);return r;};
 await assert.rejects(readDecodedMedia(identity,10000,d),/MEDIA_CHANGED_DURING_DECODE/);
});
test('decode budget expiry prevents final read',async()=>{
 const d=deps();let now=100,reads=0;d.now=()=>now;d.read=async()=>{reads++;return read();};d.decode=async i=>{now=10000;return decoded(i);};
 await assert.rejects(readDecodedMedia(identity,10000,d),/MEDIA_TIME_BUDGET/);assert.equal(reads,1);
});
test('wrong product is never decoded',async()=>{
 const d=deps();d.read=async()=>({...read(),identity:{...identity,productId:'gid://shopify/Product/2'}});
 d.decode=async()=>{throw Error('called');};await assert.rejects(readDecodedMedia(identity,10000,d),/MEDIA_DECODE_READ_IDENTITY_CHANGED/);
});
for(const [name,edit] of [['media identity',r=>r.mediaGid='gid://shopify/MediaImage/999'],['source',r=>r.url+='wrong'],
 ['dimensions',r=>r.width=2],['empty bytes',r=>r.byteLength=0],['too large',r=>r.byteLength=9000000],
 ['non-image',r=>r.mime='text/html'],['bad hash',r=>r.sha256='bad']])test(`reject decoded ${name}`,async()=>{
 const d=deps();d.decode=async i=>{const r=decoded(i);edit(r);return r;};await assert.rejects(readDecodedMedia(identity,10000,d),/MEDIA_DECODE_EVIDENCE_INVALID/);
});
test('decoder cannot mutate original snapshot passed to result',async()=>{
 const d=deps();d.decode=async i=>{const out=decoded(i);i.alt='mutated';return out;};
 const result=await readDecodedMedia(identity,10000,d);assert.equal(result.read.images[0].alt,null);
});
