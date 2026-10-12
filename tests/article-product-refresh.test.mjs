import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire, stripTypeScriptTypes} from 'node:module';
const require=createRequire(import.meta.url);
const {Liquid}=require(process.env.ARTICLE_LIQUID_TEST_MODULE || 'liquidjs');
const liquid=new Liquid({root:'shopify/snippets',extname:'.liquid'});
liquid.registerTag('doc',{parse(token,tokens){while(tokens.length){const t=tokens.shift();if(t.name==='enddoc')break;}},render(){return '';}});
liquid.registerFilter('image_url',(img)=>img?.src??'');
const policy=JSON.parse(fs.readFileSync('src/lib/editorial/product-reference-policy.json','utf8'));
const source=stripTypeScriptTypes(fs.readFileSync('src/lib/editorial/product-reference-core.ts','utf8')).replace(/^import .*;\r?\n/gm,'');
const {storeHandle,resolveProductReference}=await import('data:text/javascript;base64,'+Buffer.from('const policyJson='+JSON.stringify(policy)+';\n'+source).toString('base64'));
const render=(content,products)=>liquid.renderFile('toptik-live-article-examples',{content,all_products:products});
const primary='p10fzt13001',fallback=policy[primary].fallbacks[0];
const product=(handle)=>({id:Number(policy[handle]?.id??1),handle,title:'תיק צד Mandarina Duck Mellow Leather',vendor:'Mandarina Duck',type:'תיק צד',available:true,url:'/products/'+handle,featured_image:{src:'https://cdn.shopify.com/new.jpg',width:800,height:900}});
test('store URL identity rejects external, deceptive, cart and unsafe paths',()=>{
 assert.equal(storeHandle('/products/bag?variant=1'),'bag');
 for(const u of ['https://evil.test/products/bag','https://www.toptik.co.il.evil/products/bag','/cart/1','/products/%2Fadmin','http://www.toptik.co.il/products/bag'])assert.equal(storeHandle(u),null);
});
test('active reference stays the same even when out of stock',async()=>{
 const p={...product(primary),available:false};const r=await resolveProductReference(primary,async()=>({state:'found',product:p}));assert.equal(r.replaced,false);assert.equal(r.product,p);
});
test('network failures never imply removal or trigger fallback reads',async()=>{
 let reads=0;const r=await resolveProductReference(primary,async()=>{reads++;return {state:'unavailable'}});assert.equal(reads,1);assert.equal(r.product,null);
});
test('confirmed removal selects an available compatible candidate',async()=>{
 const r=await resolveProductReference(primary,async h=>h===primary?{state:'missing'}:{state:'found',product:{...product(h),id:policy[h].id}});assert.equal(r.replaced,true);assert.equal(r.product.handle,fallback);
});
test('mismatched vendor and unavailable candidates cannot become examples',async()=>{
 const r=await resolveProductReference(primary,async h=>h===primary?{state:'missing'}:{state:'found',product:{...product(h),vendor:'Wrong'}});assert.equal(r.product,null);
});
test('Liquid leaves active HTML byte-identical',async()=>{
 const html=`<p>text</p><figure class="photo"><a href="/products/${primary}"><img src="old.jpg" alt="old"></a><figcaption><a href="/products/${primary}">original</a></figcaption></figure>`;
 assert.equal(await render(html,{[primary]:product(primary)}),html);
});
test('Liquid replaces complete figure: image, title, caption and link',async()=>{
 const html=`<p>spec remains historical</p><figure><img src="old.jpg" alt="old"><figcaption><a href="/products/${primary}">old model</a></figcaption></figure><p>end</p>`;
 const output=await render(html,{[fallback]:product(fallback)});assert.ok(output.includes('new.jpg'));assert.ok(output.includes('/products/'+fallback));assert.ok(!output.includes('old.jpg'));assert.ok(output.includes('מפרט החלופה'));assert.ok(output.endsWith('<p>end</p>'));
 assert.equal(await render(output,{[fallback]:product(fallback)}),output);
});
test('list example replacement drops the old model claims',async()=>{
 const output=await render(`<ul><li><a href="/products/${primary}">old</a> old dimensions 10x20</li></ul>`,{[fallback]:product(fallback)});
 assert.ok(!output.includes('10x20'));assert.ok(output.includes('<li>'));assert.ok(output.includes(fallback));
});
test('missing fallback removes dead image and purchase link',async()=>{
 const output=await render(`<figure><img src="old.jpg"><a href="/products/no-candidate">old</a></figure>`,{});
 assert.ok(!output.includes('old.jpg'));assert.ok(!output.includes('<a '));assert.ok(output.includes('אינה זמינה'));
});
test('exact handle matching never changes a longer handle or external link',async()=>{
 const html=`<a href="/products/${primary}">old</a><a href="/products/${primary}-other">other</a><a href="https://evil.test/products/${primary}">external</a>`;
 const output=await render(html,{[primary+'-other']:product(primary+'-other'),[fallback]:product(fallback)});
 assert.ok(output.includes(`href="/products/${primary}-other">other`));assert.ok(output.includes(`href="https://evil.test/products/${primary}">external`));
});
test('anchor pass preserves aside containers and supports single quotes',async()=>{
 const out=await render(`<aside><p>before <a href='/products/${primary}'>old</a> after</p></aside>`,{[fallback]:product(fallback)});
 assert.ok(out.startsWith('<aside><p>before '));assert.ok(out.endsWith(' after</p></aside>'));assert.ok(out.includes(fallback));
});
test('original products are reserved before fallback budget is used',async()=>{
 const ps={};let html='';for(let i=0;i<17;i++){const h='live-'+i;ps[h]=product(h);html+=`<a href="/products/${h}">${h}</a>`;}
 html=`<a href="/products/${primary}">old</a>`+html;assert.ok((await render(html,ps)).includes('>live-16</a>'));
});
test('authored policies have only same-family alternatives and no cycles to self',()=>{
 for(const [h,r] of Object.entries(policy))for(const f of r.fallbacks){assert.notEqual(h,f);assert.equal(policy[f].vendor,r.vendor);assert.equal(policy[f].type,r.type);assert.ok(r.family);assert.equal(policy[f].family,r.family);}
});
test('every inline product photo has an unambiguous authored color binding',()=>{
 for(const story of JSON.parse(fs.readFileSync('src/lib/editorial/mandarina-image-stories.json')))
  for(const image of story.images)assert.equal(story.products.filter(p=>p.color===image.color).length,1,story.slug+':'+image.color);
});
if(process.env.ARTICLE_AUDIT_FIXTURE)test('all live article fixtures preserve active content and safely handle each removed reference',async()=>{
 const articles=JSON.parse(fs.readFileSync(process.env.ARTICLE_AUDIT_FIXTURE));const rows=JSON.parse(fs.readFileSync(process.env.ARTICLE_PRODUCT_FIXTURE));const products={};
 for(const r of rows.filter(r=>r.status===200))products[r.handle]={...r.product,url:'/products/'+r.handle,featured_image:{src:r.product.featured_image,width:800,height:800}};
 for(const a of articles.filter(a=>a.isPublished)){
  assert.equal((await render(a.body,products)).trim(),a.body.trim(),a.handle);
  const handles=[...new Set([...a.body.matchAll(/href="(?:https:\/\/www\.toptik\.co\.il)?\/products\/([^"?]+)[^"]*"/g)].map(m=>decodeURIComponent(m[1])))];
  for(const handle of handles){const ps={...products};delete ps[handle];const out=await render(a.body,ps);assert.ok(!out.includes(`href="/products/${handle}"`)&&!out.includes(`href="https://www.toptik.co.il/products/${handle}"`),a.handle+':'+handle);}
 }
});
