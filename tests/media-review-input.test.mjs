import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const api = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(read('src/lib/shopify/media-review-input.ts'))).toString('base64'));
const identity = { itemId:'11111111-1111-4111-8111-111111111111', productId:'gid://shopify/Product/11', variantId:'gid://shopify/ProductVariant/22', productHandle:'yellow-bag', exactGallerySku:'SKU-YELLOW', exactShopifySku:'SKU-YELLOW' };
const item = {id:identity.itemId,sku:identity.exactGallerySku,title:'Yellow bag',color:'Yellow',handle:identity.productHandle,variantId:'22'};
const input = {identity,mediaId:'gid://shopify/MediaImage/33',imageUrl:'https://cdn.shopify.com/s/files/1/123/image.png?v=1',expectedSha256:'a'.repeat(64),sourceUrl:'https://manufacturer.example/photo.png',evidence:'Exact yellow SKU reviewed against official source.',reviewedExactSkuColor:true};
const prepare = (v, catalog=[item]) => api.prepareMediaReview(JSON.stringify(v),catalog);
test('preview preserves exact verified inputs without authoring product facts', () => {
  const actual=prepare([input]); assert.deepEqual(actual[0].input,input); assert.deepEqual(actual[0].item,item);
});
test('preview rejects different SKU, variant, handle or item, even same product model', () => {
  for (const override of [{exactGallerySku:'SKU-BLACK'},{variantId:'gid://shopify/ProductVariant/23'},{productHandle:'black-bag'},{itemId:'22222222-2222-4222-8222-222222222222'}])
    assert.throws(()=>prepare([{...input,identity:{...identity,...override}}]));
});
test('unknown catalog product, duplicate media and unreviewed input are held', () => {
  assert.throws(()=>prepare([input],[])); assert.throws(()=>prepare([input,input]));
  assert.throws(()=>prepare([{...input,reviewedExactSkuColor:false}]));
});
test('a changed image has a different load acknowledgement key', () => {
  assert.notEqual(prepare([input])[0].key,prepare([{...input,imageUrl:input.imageUrl+'&v=2'}])[0].key);
  assert.notEqual(prepare([input])[0].key,prepare([{...input,expectedSha256:'b'.repeat(64)}])[0].key);
});
test('unsafe URLs, extra fields, bad hash and oversized plans are rejected', () => {
  for(const change of [{sourceUrl:'javascript:alert(1)'},{imageUrl:'https://evil.example/photo.png'},{imageUrl:'https://cdn.shopify.com/s/files/%2fsecret'},{sourceUrl:'https://user:pass@example.com/a'},{extra:1},{expectedSha256:'x'.repeat(64)}])
    assert.throws(()=>prepare([{...input,...change}]));
  assert.throws(()=>prepare([])); assert.throws(()=>prepare(Array(21).fill(input))); assert.throws(()=>api.prepareMediaReview(' '.repeat(200001),[item]));
});
test('image decode and explicit review gate precede same-origin registration', () => {
  const source=read('src/components/admin/MediaReviewEditor.tsx');
  assert.match(source,/!accepted \|\| !preview.length \|\| preview.some\(p => !loaded\[p.key\]\)/);
  assert.match(source,/naturalWidth > 0/); assert.match(source,/sending.current = true/);
  assert.match(source,/credentials: "same-origin"/); assert.match(source,/result.decodedSha256 !== entry.input.expectedSha256/);
  assert.match(source,/if \(registered\[entry.key\]\) continue/);
  assert.ok(!source.includes('localStorage')); assert.ok(!source.includes('dangerouslySetInnerHTML'));
});
test('page is authenticated before reading catalog and excluded from index', () => {
  const source=read('src/app/(panel)/dashboard/media-review/page.tsx');
  assert.ok(source.indexOf('await requireAdminPage()') < source.indexOf('await getCarouselPayload'));
  assert.match(source,/index: false, follow: false/);
});
test('partial registration stops on failure and retry skips durable successes', async () => {
  const source=read('src/components/admin/MediaReviewEditor.tsx');
  const handler=source.slice(source.indexOf('async function register()'),source.indexOf('\n  return <section'));
  const inputs=[input,{...input,mediaId:'gid://shopify/MediaImage/34'},{...input,mediaId:'gid://shopify/MediaImage/35'}];
  const preview=prepare(inputs), requested=[];
  let failOnce=true;
  const context={sending:{current:false},accepted:true,preview,loaded:Object.fromEntries(preview.map(p=>[p.key,true])),registered:{},busy:false,message:'',
    setBusy(v){this.busy=v;},setMessage(v){this.message=v;},setRegistered(update){this.registered=update(this.registered);},
    async fetch(url,options){const body=JSON.parse(options.body);requested.push(body.mediaId);
      assert.equal(url,'/api/admin/shopify/media/review');assert.equal(options.credentials,'same-origin');
      if(body.mediaId===inputs[1].mediaId && failOnce){failOnce=false;throw new Error('Temporary network failure');}
      return {ok:true,json:async()=>({registered:true,queued:true,mediaId:body.mediaId,decodedSha256:body.expectedSha256})};}
  };
  for(const name of ['setBusy','setMessage','setRegistered','fetch'])context[name]=context[name].bind(context);
  const register=Function('context',`with(context){${handler};return register;}`)(context);
  await register();assert.equal(Object.keys(context.registered).length,1);assert.equal(requested.length,2);assert.equal(context.busy,false);
  await register();assert.equal(Object.keys(context.registered).length,3);assert.deepEqual(requested,[inputs[0].mediaId,inputs[1].mediaId,inputs[1].mediaId,inputs[2].mediaId]);
  await register();assert.equal(requested.length,4);
});
