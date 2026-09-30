import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {core,coreUrl,moduleUrl,source} from './helpers/typed-spec-modules.mjs';
const mergeUrl=moduleUrl(readFileSync(new URL('../src/lib/carousel/merge-typed-specs.ts',import.meta.url),'utf8'));
const {mergeTypedSpecPresentation}=await import(mergeUrl);
const {overlayTypedSpecs}=await import(moduleUrl(source('typed-spec-display').replace('"./typed-spec-core"',JSON.stringify(coreUrl)).replace('"../carousel/merge-typed-specs"',JSON.stringify(mergeUrl))));
const base=()=>({id:'id1',catalogNumber:'SKU.1',weight:99,title:'Product',techSpecs:{category:'suitcase',colors:[{name:'Black'}],specs:[{heading:'Manufacturer',items:[{label:'חומר',value:'Old PC'},{label:'מידות',value:'52 × 75 × 28'},{label:'משקל',value:'3.6 kg'},{label:'אבזם מיוחד',value:'Original feature'}]}]}});
test('typed display replaces only known facts and preserves unknown legacy/brand/color/category',()=>{
 const item=base(),result=overlayTypedSpecs(item,{itemId:'id1',exactSku:'SKU.1',fields:{material:'100% PC',net_weight:core.normalizeMeasurement('net_weight',{value:'2.4',unit:'kg'})}});
 const rows=result.techSpecs.specs.flatMap(s=>s.items);assert.equal(rows.filter(x=>x.label==='חומר').length,1);assert.equal(rows.find(x=>x.label==='חומר').value,'100% PC');assert.ok(rows.some(x=>x.label==='משקל עצמי'&&x.value==='2.4 ק״ג'));assert.ok(rows.some(x=>x.label==='מידות'&&x.value==='52 × 75 × 28'));assert.ok(rows.some(x=>x.label==='אבזם מיוחד'));assert.deepEqual(result.techSpecs.colors,item.techSpecs.colors);assert.equal(result.techSpecs.category,'suitcase');assert.equal(result.weight,99);assert.equal(item.techSpecs.specs[0].items[0].value,'Old PC');
});
test('identity mismatch/empty typed fields do not affect product or infer shipping weight',()=>{
 const item=base();assert.equal(overlayTypedSpecs(item,{itemId:'id1',exactSku:'SKU1',fields:{material:'PC'}}),item);assert.equal(overlayTypedSpecs(item,{itemId:'id1',exactSku:'SKU.1',fields:{}}),item);
});
test('one explicit axis preserves legacy dimension string; all three can replace it',()=>{
 const height=core.normalizeMeasurement('height',{value:'55',unit:'cm'}),width=core.normalizeMeasurement('width',{value:'40',unit:'cm'}),depth=core.normalizeMeasurement('depth',{value:'23',unit:'cm'});
 const all=fields=>overlayTypedSpecs(base(),{itemId:'id1',exactSku:'SKU.1',fields}).techSpecs.specs.flatMap(x=>x.items);
 assert.ok(all({height}).some(x=>x.label==='מידות'));assert.ok(!all({height,width,depth}).some(x=>x.label==='מידות'));assert.ok(all({height,width,depth}).some(x=>x.label==='גובה'&&x.value==='55 ס״מ'));
});

test('partial wheel edits preserve composite legacy count; full pair replaces it',()=>{
 const item=base();item.techSpecs.specs[0].items.push({label:'גלגלים',value:'4 double spinner wheels'});
 const rows=fields=>overlayTypedSpecs(item,{itemId:'id1',exactSku:'SKU.1',fields}).techSpecs.specs.flatMap(s=>s.items);
 for(const fields of [{wheel_type:'Spinner'},{wheel_count:'4'}])assert.ok(rows(fields).some(row=>row.value==='4 double spinner wheels'));
 assert.ok(rows({wheel_type:'Spinner'}).some(row=>row.label==='סוג גלגלים'&&row.value==='Spinner'));
 const all=rows({wheel_type:'Spinner',wheel_count:'4'});assert.ok(!all.some(row=>row.value==='4 double spinner wheels'));
 assert.ok(all.some(row=>row.label==='מספר גלגלים'&&row.value==='4'));assert.ok(all.some(row=>row.label==='סוג גלגלים'&&row.value==='Spinner'));
});
test('first typed fact does not suppress lazy manufacturer details and merges unknown facts after fetch',()=>{
 const item={...base(),sourceUrl:'https://www.bricsmilano.com/products/exact',techSpecs:null};
 const projected=overlayTypedSpecs(item,{itemId:'id1',exactSku:'SKU.1',fields:{material:'100% PC'}});
 assert.equal(projected.techSpecs,null);assert.ok(projected.sourceUrl);assert.equal(projected.typedSpecsOverlay.specs[0].items[0].value,'100% PC');
 const fetched={specs:[{heading:'Manufacturer',items:[{label:'אבזם מיוחד',value:'Preserved unknown fact'},{label:'חומר',value:'old'}]}],colors:[]};
 const merged=mergeTypedSpecPresentation(fetched,projected.typedSpecsOverlay),rows=merged.specs.flatMap(x=>x.items);
 assert.ok(rows.some(x=>x.value==='Preserved unknown fact'));assert.equal(rows.filter(x=>x.label==='חומר').length,1);assert.ok(rows.some(x=>x.value==='100% PC'));
 const modal=readFileSync(new URL('../src/components/carousel/TechSpecsModal.tsx',import.meta.url),'utf8');assert.match(modal,/if \(!url \|\| synchronousDetails\) return/);assert.match(modal,/mergeTypedSpecPresentation\(legacyDetails, item\?\.typedSpecsOverlay\)/);
});
