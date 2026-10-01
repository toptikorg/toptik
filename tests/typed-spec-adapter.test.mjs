import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
const asModule=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const coreUrl=asModule(readFileSync(new URL('../src/lib/shopify/typed-spec-core.ts',import.meta.url),'utf8'));
const core=await import(coreUrl);
const adapter=await import(asModule(readFileSync(new URL('../src/lib/shopify/typed-spec-adapter.ts',import.meta.url),'utf8').replace('"./typed-spec-core"',JSON.stringify(coreUrl))));
const id={productGid:'gid://shopify/Product/1',variantGid:'gid://shopify/ProductVariant/2',exactSku:'BAH08453.001'};
const stamp='2026-09-30T18:00:00Z';
const provenance=(key,raw,intentId)=>({authority:'merchant',producer:'shopify_typed_metafield',observedAt:stamp,evidenceId:`verified-${key}`,intentId:intentId??`shop-${raw.compareDigest}`,raw:{value:raw.value,type:raw.type}});
const merchant=(intentId='edit-1')=>({authority:'merchant',producer:'gallery_typed_editor',observedAt:stamp,evidenceId:'gallery-editor-1',intentId,raw:{source:'typed field'}});
const field=(key,value,type=core.FIELD_DEFINITIONS[key]?.type,namespace=core.NAMESPACE)=>({id:`gid://shopify/Metafield/${Math.max(1,core.SPEC_KEYS.indexOf(key)+1)}`,namespace,key,type,value,compareDigest:createHash('sha256').update(`${type}:${value}`).digest('hex'),updatedAt:stamp});
function response(values={}){
 const product={id:id.productGid,updatedAt:stamp,variants:{nodes:[{id:id.variantGid,sku:id.exactSku}],pageInfo:{hasNextPage:false}},control:null};
 for(const key of core.SPEC_KEYS)product[`f_${key}`]=Object.hasOwn(values,key)?field(key,values[key]):null;
 return {data:{product}};
}
const parse=body=>adapter.parseSpecReadResponse(body,id,provenance);
function plan(snapshot,edits){
 const baseline={gallery:structuredClone(snapshot.document),shopify:structuredClone(snapshot.document)},current=structuredClone(baseline);
 for(const [key,value] of Object.entries(edits))current.gallery.fields[key]=core.observe(value===null?core.makeSpecClear(key,merchant()):core.makeSpecValue(key,value,merchant()),'g2');
 return {baseline,current,merge:core.planSpecMerge(current,baseline)};
}
function execute(body,request){
 const next=structuredClone(body),product=next.data.product;
 for(const write of request.variables.metafields){
  const old=product[write.key===adapter.CLEAR_KEY?'control':`f_${write.key}`];
  if((old?.compareDigest??null)!==write.compareDigest)return {body:structuredClone(body),result:{data:{metafieldsSet:{metafields:[],userErrors:[{code:'INVALID_COMPARE_DIGEST',field:['metafields']}]}}}};
 }
 const saved=[];
 for(const write of request.variables.metafields){
  const actual=field(write.key,write.value,write.type,write.namespace);saved.push(actual);product[write.key===adapter.CLEAR_KEY?'control':`f_${write.key}`]=actual;
 }
 return {body:next,result:{data:{metafieldsSet:{metafields:saved,userErrors:[]}}}};
}
test('fixed2026-07 read covers19 fields and control, exact identity and no body/inventory query',()=>{
 const request=adapter.buildSpecReadRequest(id);assert.equal(request.apiVersion,'2026-07');assert.deepEqual(request.variables,{id:id.productGid,publicationId:'gid://shopify/Publication/79538258170'});
 assert.equal((request.query.match(/: metafield\(/g)||[]).length,20);assert.match(request.query,/variants\(first: 2\)/);assert.doesNotMatch(request.query,/bodyHtml|description|inventory|price/);
 const parsed=parse(response());assert.equal(Object.keys(parsed.document.fields).length,19);assert.equal(parsed.document.fields.net_weight.cell.state,'absent');
 for(const mutate of [p=>p.variants.nodes[0].sku='BAH08453001',p=>p.id='gid://shopify/Product/3',p=>p.variants.nodes.push({id:'gid://shopify/ProductVariant/4',sku:'X'}),p=>p.variants.pageInfo.hasNextPage=true]){
  const body=response();mutate(body.data.product);assert.throws(()=>parse(body),/IDENTITY_CHANGED/);
 }
});
test('partial GraphQL data and omitted aliases fail closed; present type/digest collisions rejected',()=>{
 const body=response({height:'{"value":55,"unit":"centimeters"}'});
 assert.throws(()=>parse({...body,errors:[{message:'sensitive remote text'}]}),/^Error: SPEC_GRAPHQL_ERROR$/);
 for(const key of ['control','f_material']){const partial=structuredClone(body);delete partial.data.product[key];assert.throws(()=>parse(partial),/INCOMPLETE/);}
 for(const change of [{type:'weight'},{compareDigest:''},{updatedAt:'2026-09-30 00:00:00'},{namespace:'other'}]){const bad=structuredClone(body);Object.assign(bad.data.product.f_height,change);assert.throws(()=>parse(bad),/SHAPE_OR_TYPE/);}
});

test('Shopify native yards and all US/imperial volume units decode losslessly with raw provenance',()=>{
 const cases=[['height','yards','91.44','centimeters'],['volume','us_pints','0.473176473','liters'],
  ['volume','us_quarts','0.946352946','liters'],['volume','imperial_fluid_ounces','0.0284130625','liters'],
  ['volume','imperial_pints','0.56826125','liters'],['volume','imperial_quarts','1.1365225','liters']];
 for(const [key,unit,decimal,canonicalUnit] of cases){
  const raw=JSON.stringify({value:1,unit}),snapshot=parse(response({[key]:raw})),cell=snapshot.document.fields[key].cell;
  assert.equal(cell.state,'value');assert.equal(cell.value.decimal,decimal);assert.equal(cell.value.unit,canonicalUnit);
  assert.deepEqual(cell.value.original,{value:'1',unit});assert.equal(cell.provenance.raw.value,raw);
 }
});
test('normal set request includes every CAS plus control-map CAS; receipt and fresh readback required',()=>{
 const before=response({material:'PC'}),snapshot=parse(before),changes=plan(snapshot,{material:'PP',height:{value:'55',unit:'cm'}});
 const request=adapter.buildSpecWriteRequest(snapshot,changes.merge.operations);assert.equal(request.variables.metafields.length,3);
 assert.equal(request.variables.metafields[0].compareDigest,before.data.product.f_material.compareDigest);assert.equal(request.variables.metafields[1].compareDigest,null);assert.equal(request.variables.metafields[2].compareDigest,null);
 assert.ok(JSON.parse(JSON.stringify(request)).variables.metafields.every(x=>Object.hasOwn(x,'compareDigest')));
 assert.doesNotMatch(request.query,/message|metafieldsDelete|productUpdate/);
 const done=execute(before,request);assert.equal(adapter.parseSpecWriteResponse(done.result,request).length,3);
 assert.throws(()=>adapter.verifySpecWriteReadback(request,snapshot),/READBACK/);adapter.verifySpecWriteReadback(request,parse(done.body));
});
test('omitted operation CAS and stale target/control digest cannot become unconditional writes',()=>{
 const before=response({material:'PC'}),snapshot=parse(before),changes=plan(snapshot,{material:'PP'}),op=changes.merge.operations[0];
 const missing=structuredClone(op);delete missing.expectedRevision;assert.throws(()=>adapter.buildSpecWriteRequest(snapshot,[missing]),/COMPARE_DIGEST/);
 const request=adapter.buildSpecWriteRequest(snapshot,[op]);
 for(const mutate of [p=>p.f_material=field('material','Nylon'),p=>p.control=field(adapter.CLEAR_KEY,'{"version":1,"cleared":{}}','json',adapter.CLEAR_NAMESPACE)]){
  const concurrent=structuredClone(before);mutate(concurrent.data.product);const failed=execute(concurrent,request);
  assert.deepEqual(failed.body,concurrent);assert.throws(()=>adapter.parseSpecWriteResponse(failed.result,request),/CAS_CONFLICT/);
 }
});
test('clear defaults blocked; explicitly gated tombstone atomically guards unchanged raw typed value',()=>{
 const before=response({net_weight:'{"value":3.6,"unit":"kilograms"}'}),snapshot=parse(before),changes=plan(snapshot,{net_weight:null});
 assert.throws(()=>adapter.buildSpecWriteRequest(snapshot,changes.merge.operations),/VERIFIED_CONSUMERS/);
 const request=adapter.buildSpecWriteRequest(snapshot,changes.merge.operations,{clearConsumerContract:adapter.CLEAR_CONSUMER_CONTRACT});
 assert.equal(request.variables.metafields[0].value,before.data.product.f_net_weight.value);
 const done=execute(before,request),fresh=parse(done.body);assert.equal(fresh.document.fields.net_weight.cell.state,'clear');assert.equal(fresh.raw.net_weight.value,before.data.product.f_net_weight.value);
 adapter.verifySpecWriteReadback(request,fresh);assert.doesNotMatch(JSON.stringify(request),/metafieldsDelete/);
 const readback={gallery:changes.current.gallery,shopify:fresh.document};const accepted=core.acceptVerifiedSpecReadback(changes.baseline,changes.merge,readback);
 assert.deepEqual(core.planSpecMerge(readback,accepted),{operations:[],conflicts:[],acknowledgements:[]});
});
test('changed raw value ignores old tombstone; supported editor restoring same value removes marker',()=>{
 const before=response({material:'PC'}),snapshot=parse(before),changes=plan(snapshot,{material:null});
 const cleared=execute(before,adapter.buildSpecWriteRequest(snapshot,changes.merge.operations,{clearConsumerContract:adapter.CLEAR_CONSUMER_CONTRACT})).body;
 const changed=structuredClone(cleared);changed.data.product.f_material=field('material','PP');assert.equal(parse(changed).document.fields.material.cell.value,'PP');
 const tombstoneSnapshot=parse(cleared),restore=plan(tombstoneSnapshot,{material:'PC'}),request=adapter.buildSpecWriteRequest(tombstoneSnapshot,restore.merge.operations);
 assert.deepEqual(JSON.parse(request.variables.metafields.at(-1).value).cleared,{});
 adapter.verifySpecWriteReadback(request,parse(execute(cleared,request).body));
});
test('malformed/unknown tombstones and untrusted clear provenance fail closed',()=>{
 const before=response({material:'PC'});
 for(const value of ['{}','{"version":1,"cleared":{"price":{}}}','not json','{"version":1,"cleared":{},"extra":1}']){
  const bad=structuredClone(before);bad.data.product.control=field(adapter.CLEAR_KEY,value,'json',adapter.CLEAR_NAMESPACE);assert.throws(()=>parse(bad));
 }
 const snapshot=parse(before),changes=plan(snapshot,{material:null});const done=execute(before,adapter.buildSpecWriteRequest(snapshot,changes.merge.operations,{clearConsumerContract:adapter.CLEAR_CONSUMER_CONTRACT}));
 assert.throws(()=>adapter.parseSpecReadResponse(done.body,id,(key,raw)=>provenance(key,raw)),/CLEAR_PROVENANCE/);
});
test('all19 typed edits plus control fit one20-row atomic batch',()=>{
 const before=response(),snapshot=parse(before),edits={};
 for(const [key,definition] of Object.entries(core.FIELD_DEFINITIONS))edits[key]=definition.unit?{value:'1',unit:definition.unit}:definition.type==='boolean'?false:definition.type==='number_integer'?4:definition.type==='json'?[{heading:'פרטים',items:[{label:'בדיקה',value:'ערך'}]}]:'Typed fact';
 const request=adapter.buildSpecWriteRequest(snapshot,plan(snapshot,edits).merge.operations);assert.equal(request.variables.metafields.length,20);
 const done=execute(before,request);adapter.parseSpecWriteResponse(done.result,request);adapter.verifySpecWriteReadback(request,parse(done.body));
});
test('mutation acknowledgement errors/duplicates/omissions and incomplete live results never pass',()=>{
 const before=response(),snapshot=parse(before),request=adapter.buildSpecWriteRequest(snapshot,plan(snapshot,{material:'PC'}).merge.operations),done=execute(before,request);
 for(const mutate of [p=>p.metafields.pop(),p=>p.metafields[1]=p.metafields[0],p=>delete p.userErrors,p=>p.userErrors=[{code:'OTHER',message:'do not leak'}]]){
  const bad=structuredClone(done.result);mutate(bad.data.metafieldsSet);assert.throws(()=>adapter.parseSpecWriteResponse(bad,request),/SPEC_/);
 }
});
test('clear hash ignores native JSON whitespace/object order/numeric spelling; actual changes invalidate',()=>{const a=field('net_weight','{"value":2.4,"unit":"kg"}'),b=field('net_weight','{ "unit": "kg", "value": 2.400 }');assert.equal(adapter.rawSpecValueHash(a),adapter.rawSpecValueHash(b));assert.notEqual(adapter.rawSpecValueHash(a),adapter.rawSpecValueHash({...b,value:'{"value":2.5,"unit":"kg"}'}));});
test('control render evidence cannot disagree with its semantic value hash',()=>{const body=response({material:'PC'}),snapshot=parse(body),operation=plan(snapshot,{material:null}).merge.operations,request=adapter.buildSpecWriteRequest(snapshot,operation,{clearConsumerContract:adapter.CLEAR_CONSUMER_CONTRACT}),done=execute(body,request).body;const map=JSON.parse(done.data.product.control.value);map.cleared.material.renderValue='PP';done.data.product.control.value=JSON.stringify(map);assert.throws(()=>parse(done),/CLEAR_STATE_INVALID/);});
