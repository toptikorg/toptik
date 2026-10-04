import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const moduleUrl = s => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const brands = moduleUrl(readFileSync('src/lib/carousel/brands.ts','utf8'));
const map = JSON.parse(readFileSync('src/lib/carousel/series-reviewed.json','utf8'));
const source = readFileSync('src/lib/carousel/series.ts','utf8')
 .replace('import reviewed from "./series-reviewed.json";', `const reviewed = ${JSON.stringify(map)};`)
 .replace('"./brands"',JSON.stringify(brands));
const seriesModuleUrl = moduleUrl(source);
const {seriesForItem, availableSeries, filterBySeries} = await import(seriesModuleUrl);
const {publicCollectionItems} = await import(brands);
const labels = {'mandarina-duck':'Mandarina Duck',brics:"Bric's",samsonite:'Samsonite','american-tourister':'American Tourister'};
const item = (sku,brand) => ({id:sku,catalogNumber:sku,isActive:true,techSpecs:{specs:[{items:[{label:'מותג',value:labels[brand] ?? 'Unknown brand'}]}]}});
test('every reviewed exact SKU resolves only within its verified brand',()=>{
 for(const [sku,s] of Object.entries(map)){
  assert.deepEqual(seriesForItem(item(sku,s.brand)),s);
  assert.equal(seriesForItem(item(sku,'invalid')),null);
 }
 assert.equal(seriesForItem(item('UNKNOWN','samsonite')),null);
});
test('series intersection never mixes brands or returns unrelated products',()=>{
 const items=Object.entries(map).map(([sku,s])=>item(sku,s.brand));
 for(const s of availableSeries(items)){
  const filtered=filterBySeries(items,s.key);
  assert.ok(filtered.length);
  assert.ok(filtered.every(i=>seriesForItem(i).key===s.key));
 }
 assert.equal(filterBySeries(items,'unknown').length,0);
 assert.equal(filterBySeries(items,'all'),items);
});
test('American Tourister is public only with explicit brand identity and active products',()=>{
 const p=item('AT-EXAMPLE','american-tourister');
 assert.deepEqual(publicCollectionItems([p]),[p]);
 assert.deepEqual(publicCollectionItems([{...p,isActive:false}]),[]);
});
const storeSource=readFileSync('src/lib/carousel/store-classification.ts','utf8')
 .replace('import "server-only";','').replace('"./brands"',JSON.stringify(brands)).replace('"./series"',JSON.stringify(seriesModuleUrl));
const {classificationIndex,applyStoreClassification}=await import(moduleUrl(storeSource));
test('live store classification overrides a reviewed fallback and follows explicit tags',()=>{
 const [sku,s]=Object.entries(map).find(([,s])=>s.brand==='samsonite');
 const product={vendor:'Samsonite',product_type:'תיק גב למחשב',tags:[`tt-series:${s.key}`],variants:[{sku}]};
 const p=item(sku,s.brand);
 const [updated]=applyStoreClassification([p],classificationIndex([product]));
 assert.deepEqual(seriesForItem(updated),s);
 assert.equal(updated.techSpecs.category,'laptop-bags');
 const [cleared]=applyStoreClassification([p],classificationIndex([{...product,tags:[]}]));
 assert.equal(seriesForItem(cleared),null);
 assert.equal(applyStoreClassification([p],null)[0],p);
 assert.equal(applyStoreClassification([p],classificationIndex([product,product]))[0],p);
 assert.equal(applyStoreClassification([p],classificationIndex([{...product,vendor:"Bric's"}]))[0],p);
});

test('verified WEEK-END medium suitcase has a separate series and never enters Mellow Leather',()=>{
 const p=item('P10JLV03651','mandarina-duck');
 assert.equal(seriesForItem(p).key,'mandarina-duck-weekend');
 assert.deepEqual(filterBySeries([p],'mandarina-duck-mellow-leather'),[]);
 assert.deepEqual(filterBySeries([p],'mandarina-duck-weekend'),[p]);
});
