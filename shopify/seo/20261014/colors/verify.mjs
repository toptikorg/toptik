// Synthetic fixtures only. Does not call Shopify or deploy.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Liquid} from 'liquidjs';
const root=path.dirname(fileURLToPath(import.meta.url)), read=n=>fs.readFileSync(path.join(root,n),'utf8');
const map=JSON.parse(read('canonical-map.json')),updates=JSON.parse(read('product-updates.json'));
const engine=new Liquid({root:path.join(root,'theme/snippets'),extname:'.liquid'});
engine.registerFilter('json',JSON.stringify);
// Shopify's doc block is documentation only; ignore it in the local renderer.
engine.registerTag('doc',{parse(token,remain){while(remain.length){const t=remain.shift();if(t.name==='enddoc')break;}},render(){return '';}});
let checks=0;const check=(v,m)=>{assert(v,m);checks++};
(async()=>{
 check(map.length===178,'mapping count');check(new Set(map.map(x=>x.from)).size===178,'unique child');
 const all={};for(const p of updates)all[p.handle]={id:p.id,url:'/products/'+p.handle};
 const parents=new Set(map.map(m=>m.to.split('/products/')[1]));check(parents.size===66,'parent count');
 const block=read('canonical-block.txt');
 for(const p of updates){
  const product={id:p.id,handle:p.handle,url:'/products/'+p.handle,selected_variant:null};
  const ctx={product,request:{page_type:'product',path:product.url},all_products:all,tt_effective_canonical_url:'https://www.toptik.co.il'+product.url};
  const m=map.find(x=>x.from===ctx.tt_effective_canonical_url);
  check((await engine.parseAndRender(block+'{{tt_effective_canonical_url}}',ctx)).trim()===(m?.to||ctx.tt_effective_canonical_url),'canonical '+p.handle);
  for(const kind of ['variant','tag','collection','missing-parent']){
   const c={...ctx,product:{...product},request:{...ctx.request}};
   if(kind==='variant')c.product.selected_variant={id:'synthetic'};
   if(kind==='tag')c.request.path+='/tag';
   if(kind==='collection')c.request.path='/collections/example'+c.request.path;
   if(kind==='missing-parent')c.all_products={};
   check((await engine.parseAndRender(block+'{{tt_effective_canonical_url}}',c)).trim()===ctx.tt_effective_canonical_url,'protected/fallback '+kind);
  }
  for(const group of [false,true]){
   const node={'@type':'Product',name:'Synthetic test product',sku:'TEST',image:'https://example.com/test.jpg',offers:{'@type':'Offer',price:'1.00',priceCurrency:'ILS'}};
   if(group)node.color='Synthetic variant color';
   const native=group?{'@context':'https://schema.org','@type':'ProductGroup',hasVariant:[node]}:{'@context':'https://schema.org',...node};
   const out=JSON.parse(await engine.renderFile('toptik-seo-family-schema',{product,structured_data:JSON.stringify(native)}));
   if(!parents.has(p.handle)){check(JSON.stringify(out)===JSON.stringify(native),'child schema stable');continue;}
   const changed=group?out.hasVariant[0]:out;check(changed.color&&changed.isSimilarTo?.length,'schema additions');
   delete changed.isSimilarTo;if(!group)delete changed.color;
   check(JSON.stringify(out)===JSON.stringify(native),'all native fields preserved');
  }
  check(p.after.seo.title?.trim()&&p.after.seo.description?.trim(),'SEO is nonempty');
 }
 console.log(JSON.stringify({checks,failures:0,scope:'local synthetic fixtures; not live/Rich Results verification'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
