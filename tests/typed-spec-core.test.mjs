import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const source=readFileSync(new URL('../src/lib/shopify/typed-spec-core.ts',import.meta.url),'utf8');
const api=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const expectedKeys=['manufacturer_sku','manufacturer_model','material','height','width','depth','expanded_height','expanded_width','expanded_depth','volume','expanded_volume','net_weight','wheel_count','wheel_type','lock_type','expandable','color_name','warranty_text','additional_specs'];
const p=(overrides={})=>({authority:'merchant',producer:'gallery_typed_editor',observedAt:'2026-09-30T18:00:00Z',evidenceId:'evidence-1',intentId:'intent-1',raw:{label:'מפרט',value:'exact raw original'},...overrides});
const manufacturer=(key,raw='official original')=>p({authority:'manufacturer',producer:'manufacturer_catalog',sourceUrl:'https://www.samsonite.com/example',manufacturerSku:'150700-9199',axis:key,intentId:undefined,raw});
const value=(key,raw,revision='v1',provenance=p())=>api.observe(api.makeSpecValue(key,raw,provenance),revision);
const doc=fields=>({fields,rawProducerData:{unchanged:['original section','unknown field']},legacySections:[{heading:'ישן',items:[{label:'מידות',value:'52 × 75 × 28'}]}]});
const pair=(g,s)=>({gallery:doc(g),shopify:doc(s)});
const clone=x=>structuredClone(x);

test('all19 keys/types/units match the approved draft contract, without commerce/copy fields',()=>{
  assert.equal(api.SPEC_KEYS.length,19);
  assert.deepEqual(api.SPEC_KEYS,expectedKeys);
  for(const forbidden of ['shipping_weight','price','sku','descriptionHtml','inventory_quantity'])assert.throws(()=>api.makeSpecValue(forbidden,'x',p()),/FIELD_NOT_ALLOWED/);
});

test('exact unit conversions retain source lexemes and never round using binary floating point',()=>{
  for(const [key,raw,decimal,unit] of [
    ['height',{value:'21.6500',unit:'inches'},'54.991','centimeters'],
    ['depth',{value:'230',unit:'millimeters'},'23','centimeters'],
    ['expanded_height',{value:'0.550000',unit:'meters'},'55','centimeters'],
    ['net_weight',{value:'5.5',unit:'pounds'},'2.494758035','kilograms'],
    ['net_weight',{value:'1',unit:'ounces'},'0.028349523125','kilograms'],
    ['volume',{value:'48000',unit:'milliliters'},'48','liters'],
    ['volume',{value:'1',unit:'us_gallons'},'3.785411784','liters'],
    ['volume',{value:'1',unit:'imperial_gallons'},'4.54609','liters'],
  ]){
    const v=api.normalizeMeasurement(key,raw);assert.equal(v.decimal,decimal);assert.equal(v.unit,unit);assert.deepEqual(v.original,raw);
  }
  assert.equal(api.normalizeMeasurement('height',{value:'0.1000000000000000000001',unit:'meters'}).decimal,'10.00000000000000000001');
});

test('unknown/ambiguous units, ranges, unlabeled axes and shipping provenance cannot create facts',()=>{
  for(const raw of [{value:'55 × 40 × 23',unit:'cm'},{value:'42/48',unit:'liters'},{value:'4',unit:'gal'},{value:'-2',unit:'cm'},{value:'0',unit:'cm'},{value:9007199254740992,unit:'cm'}])
    assert.throws(()=>api.normalizeMeasurement(raw.unit==='liters'||raw.unit==='gal'?'volume':'height',raw));
  assert.throws(()=>api.makeSpecValue('height',{value:'55',unit:'cm'},manufacturer('width')),/EXPLICIT_AXIS/);
  assert.throws(()=>api.makeSpecValue('net_weight',{value:3.6,unit:'kg'},p({producer:'shopify_inventory_measurement'})),/PROVENANCE/);
  assert.throws(()=>api.makeSpecValue('material','PC',p({producer:'shopify_product_body'})),/PROVENANCE/);
  assert.throws(()=>api.makeSpecValue('depth',{value:'28',unit:'cm'},p({authority:'manufacturer',producer:'manufacturer_catalog'})),/MANUFACTURER_EVIDENCE/);
});

test('false, explicit zero wheels, unknown, missing and merchant clear are distinct',()=>{
  assert.equal(api.makeSpecValue('expandable',false,p()).value,false);
  assert.equal(api.makeSpecValue('wheel_count',0,p()).value,'0');
  assert.throws(()=>api.makeSpecValue('wheel_count',null,p()),/INTEGER/);
  assert.throws(()=>api.makeSpecValue('expandable','false',p()),/BOOLEAN/);
  assert.throws(()=>api.makeSpecValue('material','',p()),/TEXT/);
  assert.equal(api.makeSpecClear('material',p()).state,'clear');
  assert.throws(()=>api.makeSpecClear('material',manufacturer('material')),/MERCHANT_INTENT/);
  assert.equal(api.specValuesEqual(api.missing().cell,api.absent().cell),false);
});

test('independent initial baselines preserve both existing descriptions/spec values without first overwrite',()=>{
  const baseline=pair({material:value('material','Gallery value')},{material:value('material','Shop value')});
  const before=clone(baseline);const plan=api.planSpecMerge(baseline,baseline);
  assert.deepEqual(plan,{operations:[],conflicts:[],acknowledgements:[]});assert.deepEqual(baseline,before);
  assert.equal(api.planSpecMerge(baseline,pair({},{})).conflicts[0].code,'SPEC_BASELINE_REQUIRED');
});

test('different fields merge in opposite directions, preserving raw provenance and independent CAS',()=>{
  const baseline=pair({material:value('material','PC'),wheel_count:value('wheel_count',4)},{material:value('material','PC'),wheel_count:value('wheel_count',4)});
  const current=clone(baseline);current.gallery.fields.material=value('material','PP','g2',p({raw:{producerLabel:'100% polypropylene',url:'original'}}));
  current.shopify.fields.wheel_count=value('wheel_count',8,'s2',p({producer:'shopify_typed_metafield',intentId:'shop-edit'}));
  const plan=api.planSpecMerge(current,baseline);assert.equal(plan.operations.length,2);assert.equal(plan.conflicts.length,0);
  assert.deepEqual(plan.operations.map(o=>[o.key,o.source,o.target]),[['material','gallery','shopify'],['wheel_count','shopify','gallery']]);
  assert.deepEqual(plan.operations[0].value.provenance.raw,current.gallery.fields.material.cell.provenance.raw);
  api.assertFieldCas(plan.operations[0],baseline.shopify.fields.material);
  assert.throws(()=>api.assertFieldCas(plan.operations[0],value('material','PC','s-new')),/CAS_CONFLICT/);
  assert.throws(()=>api.assertFieldCas(plan.operations[0],value('material','changed','v1')),/CAS_CONFLICT/);
});

test('simultaneous different edits conflict only their field; no newest timestamp winner',()=>{
  const baseline=pair({material:value('material','PC'),lock_type:value('lock_type','TSA')},{material:value('material','PC'),lock_type:value('lock_type','TSA')});
  const current=clone(baseline);current.gallery.fields.material=value('material','PP','g2');current.shopify.fields.material=value('material','Nylon','s2',p({observedAt:'2099-01-01T00:00:00Z'}));
  current.gallery.fields.lock_type=value('lock_type','Combination lock','g3');
  const plan=api.planSpecMerge(current,baseline);assert.deepEqual(plan.conflicts,[{key:'material',code:'SPEC_CONCURRENT_FIELD_CONFLICT'}]);
  assert.equal(plan.operations.length,1);assert.equal(plan.operations[0].key,'lock_type');
});

test('unit-equivalent edits generate no echo; both baselines acknowledge their actual source forms',()=>{
  const baseline=pair({height:value('height',{value:'54',unit:'cm'})},{height:value('height',{value:'54',unit:'cm'})});
  const current=pair({height:value('height',{value:'0.55',unit:'m'},'g2')},{height:value('height',{value:'550',unit:'mm'},'s2')});
  const plan=api.planSpecMerge(current,baseline);assert.equal(plan.operations.length,0);assert.equal(plan.acknowledgements.length,1);
  const accepted=api.acceptVerifiedSpecReadback(baseline,plan,current);assert.deepEqual(accepted,current);
  assert.deepEqual(api.planSpecMerge(current,accepted),{operations:[],conflicts:[],acknowledgements:[]});
});

test('an automatic manufacturer refresh cannot overwrite a merchant correction or tombstone',()=>{
  const baseline=pair({material:value('material','PC','g1',manufacturer('material'))},{material:value('material','PP','s1',p())});
  const current=clone(baseline);current.gallery.fields.material=value('material','Nylon','g2',manufacturer('material','newer official raw'));
  assert.deepEqual(api.planSpecMerge(current,baseline).conflicts,[{key:'material',code:'SPEC_MERCHANT_CORRECTION_PROTECTED'}]);
  baseline.shopify.fields.material=api.observe(api.makeSpecClear('material',p()),null);
  current.shopify.fields.material=clone(baseline.shopify.fields.material);
  assert.equal(api.planSpecMerge(current,baseline).conflicts[0].code,'SPEC_MERCHANT_CORRECTION_PROTECTED');
});

test('unobserved fields do not clear; observed disappearance needs explicit deletion intent',()=>{
  const baseline=pair({material:value('material','PC')},{material:value('material','PC')});
  const current=clone(baseline);delete current.gallery.fields.material;
  assert.equal(api.planSpecMerge(current,baseline).operations.length,0);
  current.shopify.fields.material=value('material','PP','s2');
  assert.equal(api.planSpecMerge(current,baseline).conflicts[0].code,'SPEC_TARGET_UNOBSERVED');
  current.gallery.fields.material=api.absent();current.shopify.fields.material=clone(baseline.shopify.fields.material);
  assert.equal(api.planSpecMerge(current,baseline).conflicts[0].code,'SPEC_ABSENCE_NEEDS_EXPLICIT_CLEAR');
});

test('explicit clear propagates abstractly but never emits unsafe Shopify blank/zero/delete request',()=>{
  const baseline=pair({net_weight:value('net_weight',{value:'2.6',unit:'kg'})},{net_weight:value('net_weight',{value:'2.6',unit:'kg'})});
  const current=clone(baseline);current.gallery.fields.net_weight=api.observe(api.makeSpecClear('net_weight',p()),'g2');
  const plan=api.planSpecMerge(current,baseline);assert.equal(plan.operations[0].intent,'clear');
  const wire=api.buildShopifySpecWritePlan('gid://shopify/Product/1',plan.operations);
  assert.equal(wire.status,'blocked_clear_transport');assert.deepEqual(wire.sets,[]);assert.equal(wire.clears.length,1);
  const readback=clone(current);readback.shopify.fields.net_weight=api.absent();
  const accepted=api.acceptVerifiedSpecReadback(baseline,plan,readback);
  assert.equal(accepted.shopify.fields.net_weight.cell.state,'absent');assert.equal(accepted.gallery.fields.net_weight.cell.state,'clear');
});

test('Shopify set plans contain only PRODUCT nineteen-field namespace and mandatory current digest',()=>{
  const baseline=pair({height:api.absent()},{height:api.absent()});
  const current=clone(baseline);current.gallery.fields.height=value('height',{value:'21.65',unit:'inches'},'g2');
  const plan=api.planSpecMerge(current,baseline);const wire=api.buildShopifySpecWritePlan('gid://shopify/Product/1',plan.operations);
  assert.equal(wire.status,'ready');assert.deepEqual(wire.sets,[{ownerId:'gid://shopify/Product/1',namespace:'toptik_specs',key:'height',type:'dimension',value:'{"value":54.991,"unit":"centimeters"}',compareDigest:null}]);
  assert.throws(()=>api.buildShopifySpecWritePlan('gid://shopify/ProductVariant/1',plan.operations),/PRODUCT_OWNER/);
  assert.throws(()=>api.buildShopifySpecWritePlan('gid://shopify/Product/1',[...plan.operations,...plan.operations]),/DUPLICATE/);
});

test('Shopify writes reject omitted, inherited or invalid digests before JSON can drop the CAS guard',()=>{
  const baseline=pair({material:value('material','PC')},{material:value('material','PC')});
  const current=clone(baseline);current.gallery.fields.material=value('material','PP','g2');
  const operation=api.planSpecMerge(current,baseline).operations[0];
  const omitted=clone(operation);delete omitted.expectedRevision;
  const inherited=Object.assign(Object.create({expectedRevision:'v1'}),omitted);
  for(const invalid of [omitted,inherited,...[undefined,'','   ',0,false,{},[]].map(expectedRevision=>({...operation,expectedRevision}))]){
    assert.throws(()=>api.buildShopifySpecWritePlan('gid://shopify/Product/1',[invalid]),/COMPARE_DIGEST_REQUIRED/);
  }
  for(const expectedRevision of [null,'current-digest']){
    const wire=api.buildShopifySpecWritePlan('gid://shopify/Product/1',[{...operation,expectedRevision}]);
    const encoded=JSON.parse(JSON.stringify(wire));
    assert.equal(Object.hasOwn(encoded.sets[0],'compareDigest'),true);assert.equal(encoded.sets[0].compareDigest,expectedRevision);
  }
});

test('fresh clear intents propagate from absent or old-clear baselines without losing concurrent conflicts',()=>{
  for(const source of ['gallery','shopify']){
    const target=source==='gallery'?'shopify':'gallery';
    const baseline=pair({material:api.absent()},{material:api.absent()});
    baseline[target].fields.material=value('material','PC','target-1');
    for(const prior of [api.absent(),api.observe(api.makeSpecClear('material',p({intentId:'previous-clear'})),'source-old')]){
      baseline[source].fields.material=prior;
      const current=clone(baseline);
      current[source].fields.material=api.observe(api.makeSpecClear('material',p({intentId:'fresh-clear'})),'source-2');
      const plan=api.planSpecMerge(current,baseline);
      assert.equal(plan.operations.length,1);assert.equal(plan.operations[0].source,source);assert.equal(plan.operations[0].intent,'clear');
      assert.deepEqual(plan.conflicts,[]);
      const concurrent=clone(current);concurrent[target].fields.material=value('material','PP','target-2');
      assert.deepEqual(api.planSpecMerge(concurrent,baseline).conflicts,[{key:'material',code:'SPEC_CONCURRENT_FIELD_CONFLICT'}]);
      const readback=clone(current);readback[target].fields.material=api.absent();
      const accepted=api.acceptVerifiedSpecReadback(baseline,plan,readback);
      assert.deepEqual(api.planSpecMerge(readback,accepted),{operations:[],conflicts:[],acknowledgements:[]});
    }
    const acknowledged=clone(baseline);acknowledged[source].fields.material=api.observe(api.makeSpecClear('material',p({intentId:'same-clear'})),'same-1');
    const revisionOnly=clone(acknowledged);revisionOnly[source].fields.material.revision='same-2';
    assert.deepEqual(api.planSpecMerge(revisionOnly,acknowledged),{operations:[],conflicts:[],acknowledgements:[]});
  }
});

test('readback must match source revision and target value before any baseline advances',()=>{
  const baseline=pair({material:value('material','PC')},{material:value('material','PC')});
  const current=clone(baseline);current.gallery.fields.material=value('material','PP','g2');
  const plan=api.planSpecMerge(current,baseline);const readback=clone(current);
  assert.throws(()=>api.acceptVerifiedSpecReadback(baseline,plan,readback),/READBACK_CONFLICT/);
  readback.shopify.fields.material=value('material','PP','s2');
  const accepted=api.acceptVerifiedSpecReadback(baseline,plan,readback);
  assert.deepEqual(accepted.gallery.legacySections,baseline.gallery.legacySections);assert.deepEqual(accepted.shopify.rawProducerData,baseline.shopify.rawProducerData);
  assert.deepEqual(api.planSpecMerge(readback,accepted),{operations:[],conflicts:[],acknowledgements:[]});
  readback.gallery.fields.material=value('material','PP','g3');assert.throws(()=>api.acceptVerifiedSpecReadback(baseline,plan,readback),/READBACK_CONFLICT/);
});

test('typed Shopify decode retains high precision, checks field type and refuses other namespaces',()=>{
  const field={namespace:'toptik_specs',key:'height',type:'dimension',value:'{"unit":"centimeters","value":10.00000000000000000001}',compareDigest:'digest1'};
  const observation=api.decodeShopifySpecField(field,p({producer:'shopify_typed_metafield'}));
  assert.equal(observation.cell.value.decimal,'10.00000000000000000001');
  assert.equal(api.encodeShopifySpecValue('height',observation.cell),'{"value":10.00000000000000000001,"unit":"centimeters"}');
  assert.throws(()=>api.decodeShopifySpecField({...field,namespace:'inventory'},p()),/NAMESPACE/);
  assert.throws(()=>api.decodeShopifySpecField({...field,type:'weight'},p()),/TYPE_COLLISION/);
  assert.throws(()=>api.decodeShopifySpecField({...field,value:'{"value":1,"unit":"cm","extra":"55"}'},p()),/JSON_INVALID/);
});

test('unmapped ordered sections and original provenance survive unchanged without becoming typed axes',()=>{
  const raw=[{heading:'פרטי מוצר',items:[{label:'מידות',value:'52 × 75 × 28'},{label:'תא פנימי',value:''}]}];
  const observation=value('additional_specs',raw,'g1',p({raw:{originalSections:clone(raw)}}));
  assert.deepEqual(observation.cell.value,raw);assert.equal(observation.cell.provenance.raw.originalSections[0].items[0].value,'52 × 75 × 28');
  const current=pair({additional_specs:observation},{additional_specs:api.absent()});
  const baseline=pair({additional_specs:api.absent()},{additional_specs:api.absent()});
  assert.deepEqual(api.planSpecMerge(current,baseline).operations.map(o=>o.key),['additional_specs']);
  const edited=clone(observation);edited.cell.value[0].items[0].value='changed';assert.equal(observation.cell.value[0].items[0].value,'52 × 75 × 28');
});

test('runtime schema rejects forged normalization, unknown fields and missing per-field revisions',()=>{
  const item=value('height',{value:'55',unit:'cm'});item.cell.value.decimal='56';
  assert.throws(()=>api.validateSpecDocument(doc({height:item})),/TAMPERED/);
  assert.throws(()=>api.validateSpecDocument(doc({shipping_weight:value('net_weight',{value:'3',unit:'kg'})})),/FIELD_NOT_ALLOWED/);
  assert.throws(()=>api.observe(api.makeSpecValue('material','PC',p()),null),/PRESENT_REVISION/);
  assert.throws(()=>api.observe({state:'absent'},'digest'),/ABSENT_REVISION/);
  assert.throws(()=>api.makeSpecValue('material','PC',p({raw:{value:Infinity}})),/NOT_JSON/);
  assert.throws(()=>api.makeSpecValue('material','PC',p({raw:{value:undefined}})),/NOT_JSON/);
});
