import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const colorGroups = moduleUrl(readFileSync('src/lib/carousel/color-groups.ts', 'utf8'));
const vendorDetect = moduleUrl(readFileSync('src/lib/catalog-source/vendor-detect.ts', 'utf8'));
const brands = moduleUrl(readFileSync('src/lib/carousel/brands.ts', 'utf8'));
const source = readFileSync('src/lib/carousel/colors.ts', 'utf8')
  .replace('"./color-groups"', JSON.stringify(colorGroups))
  .replace('"@/lib/catalog-source/vendor-detect"', JSON.stringify(vendorDetect))
  .replace('"./brands"', JSON.stringify(brands));
const {modelCodeFromCatalog, colorCodeFromCatalog, buildModelSiblingSwatches, resolveItemSwatches, colorSwatchStyle, verifiedPublishedColorName, VERIFIED_PUBLISHED_COLOR_BINDINGS_20261109} = await import(moduleUrl(source));

const item = (sku, overrides = {}) => ({
  id: sku, catalogNumber: sku, title: sku, isActive: true,
  coverImagePath: `${sku}-front.jpg`,
  angles: [{angleOrder: 2, imagePath: `${sku}-back.jpg`}, {angleOrder: 1, imagePath: `${sku}-front.jpg`}],
  ...overrides,
});

test('verified Havana color never borrows a black illustration for its swatch', () => {
  const members=[
    item('P10QMT39209',{coverImagePath:'https://cdn.example.test/black-illustration.jpg',shopifyLink:{handle:'תיק-גב-mandarina-duck-md20-qmt39-בצבע-חמרה-havana',variantId:'68127817859322',isPublished:true}}),
    item('P10QMT39B09',{coverImagePath:'https://cdn.example.test/cocoon.jpg',shopifyLink:{handle:'p10qmt39b09',variantId:'67616516079866',isPublished:true}}),
  ];
  const swatches=buildModelSiblingSwatches(members).get(members[0].id);
  const havana=swatches.find(s=>s.name==='חמרה Havana');
  assert.ok(havana);
  assert.equal(havana.hex,null);
  assert.equal(colorSwatchStyle(havana),undefined);
  assert.equal('useProductImageAsSwatch' in havana,false);
});

test('four imported color names are readable while sibling identities and images stay exact', () => {
  const members = [['001','שחור'],['08Q','כחול'],['24B','תכלת'],['27D',"צ'אי הודי (חום)"]]
    .map(([code,color]) => item('P10FZT73'+code,{color,title:'FZT73'}));
  const groups = buildModelSiblingSwatches(members);
  for (const member of members) {
    assert.deepEqual(groups.get(member.id).map(s=>s.name), members.map(m=>m.color));
    assert.deepEqual(groups.get(member.id).map(s=>s.itemId), members.map(m=>m.id));
    assert.deepEqual(groups.get(member.id).map(s=>s.imagePath), members.map(m=>m.coverImagePath));
  }
});

test('compact Mandarina SKU separates exact model and trailing color, including alphanumeric models', () => {
  for (const [sku, model, color] of [
    ['P10FZT73209', 'FZT73', '209'], ['P10FZT73A46', 'FZT73', 'A46'],
    ['p10fzt7328mtu', 'FZT73', '28M'], ['P10FZTA7001', 'FZTA7', '001'],
    ['P10FZTA7A46', 'FZTA7', 'A46'],
  ]) {
    assert.equal(modelCodeFromCatalog(sku), model);
    assert.equal(colorCodeFromCatalog(sku), color);
  }
});

test('separated Mandarina codes and Bric codes retain their existing model and color', () => {
  for (const [sku, model, color] of [
    ['P10SZV24-05J-TU', 'SZV24', '05J'], ['P10FZT73-A46', 'FZT73', 'A46'],
    ['P10FZT73_A46', 'FZT73', 'A46'], ['P10FZT73/A46', 'FZT73', 'A46'],
    ['P10FZT73.A46', 'FZT73', 'A46'], ['BXL58145.101', 'BXL58145', '101'],
    ['BXL38124078', 'BXL38124078', '078'],
  ]) {
    assert.equal(modelCodeFromCatalog(sku), model);
    assert.equal(colorCodeFromCatalog(sku), color);
  }
});

test('compact grouping is restricted to complete P10 model and color identities', () => {
  for (const [sku, expected] of [
    [null, null], [undefined, null], ['', null], ['ABC', null],
    ['P10FZT73', 'FZT73'], ['P10FZT73A4', 'FZT73A4'], ['P10FZT73A460', 'FZT73A460'],
    ['P20FZT73A46', 'FZT73A46'], ['P100FZT73A46', 'FZT73A46'],
    ['P10FZT73A46-extra', 'FZT73A46'],
  ]) assert.equal(modelCodeFromCatalog(sku), expected);
});

test('the twelve published FZT73 colors share exact sibling targets and their own images', () => {
  const colors = ['209', 'B01', 'B07', 'A61', 'A41', '28M', '04O', '24X', '25G', '26R', '13U', 'A46'];
  const members = colors.map(color => item(`P10FZT73${color}`));
  const unrelated = item('P10FZT7504O');
  const groups = buildModelSiblingSwatches([...members, unrelated]);
  assert.equal(groups.size, 12);
  for (const member of members) {
    const swatches = resolveItemSwatches(groups.get(member.id));
    assert.equal(swatches.length, 12);
    assert.deepEqual(swatches.map(s => s.itemId), members.map(m => m.id));
    assert.equal(swatches.filter(s => s.isCurrent).length, 1);
    assert.equal(swatches.find(s => s.isCurrent).itemId, member.id);
    for (const swatch of swatches) {
      const sibling = members.find(m => m.id === swatch.itemId);
      assert.equal(swatch.imagePath, sibling.coverImagePath);
      assert.deepEqual(swatch.angles, [`${sibling.id}-front.jpg`, `${sibling.id}-back.jpg`]);
    }
  }
  assert.deepEqual(resolveItemSwatches(groups.get(unrelated.id)), []);
});

test('compact and separated colors group together, deduplicate colors and preserve distinct models', () => {
  const members = [item('P10FZTA7001'), item('P10FZTA7-A46-TU'), item('P10FZTA7A46'), item('P10FZT73001')];
  const groups = buildModelSiblingSwatches(members);
  assert.deepEqual(groups.get(members[0].id).map(s => s.itemId), members.slice(0, 2).map(m => m.id));
  assert.equal(groups.get(members[2].id).find(s => s.isCurrent).itemId, members[1].id);
  assert.equal(groups.has(members[3].id), false);
});

test('verified Shopify color names replace raw codes only for the exact published variant', () => {
  const matches = [
    item('P10QMT3901V',{coverImagePath:'https://cdn.example.test/mint.jpg',shopifyLink:{handle:'p10qmt3901v',variantId:'67616514310394',isPublished:true}}),
    item('P10QMT39B06',{coverImagePath:'https://cdn.example.test/amber.jpg',shopifyLink:{handle:'p10qmt39b06',variantId:'67616515784954',isPublished:true}}),
  ];
  const swatches=buildModelSiblingSwatches(matches).get(matches[0].id);
  assert.deepEqual(swatches.map(s=>s.name),['מנטה','ענבר']);
  assert.ok(swatches.every(s=>s.hex===null && colorSwatchStyle(s)===undefined));
  assert.equal(colorSwatchStyle({...swatches[0],imagePath:'http://insecure.test/image.jpg'}),undefined);
  const altered=structuredClone(matches);altered[0].shopifyLink.variantId='1';
  const result=buildModelSiblingSwatches(altered).get(altered[0].id);
  assert.notEqual(result[0].name,'מנטה');
  assert.equal('useProductImageAsSwatch' in result[0],false);
});

test('Porsche Roadster uses verified black and racing-yellow colors, not Mandarina color 024', () => {
  const members = [item('ORI05500.909', { title: 'טרולי Porsche Design Roadster בגודל 55 ס״מ בשחור מבריק' }),
    item('ORI05500.024', { title: 'טרולי Porsche Design Roadster בגודל 55 ס״מ בצהוב רייסינג' })];
  const swatches = buildModelSiblingSwatches(members).get(members[0].id);
  assert.deepEqual(swatches.map(s => ({name:s.name,hex:s.hex,itemId:s.itemId})), [
    {name:'שחור מבריק',hex:'#1a1a1a',itemId:'ORI05500.909'},
    {name:'צהוב רייסינג',hex:'#f0c040',itemId:'ORI05500.024'},
  ]);
  const mandarina = [item('P10FZT73024'),item('P10FZT73001')];
  assert.equal(buildModelSiblingSwatches(mandarina).get(mandarina[0].id)[0].name,'פיריט');
});

test('verified additional Shopify color labels respect exact SKU, handle and variant', () => {
 const bags=[
  item('P10QMMM3B03',{coverImagePath:'https://cdn.example.test/bordeaux.jpg',shopifyLink:{handle:'p10qmmm3b03',variantId:'67616509690106',isPublished:true}}),
  item('P10QMMM3B06',{coverImagePath:'https://cdn.example.test/amber.jpg',shopifyLink:{handle:'p10qmmm3b06',variantId:'67616510017786',isPublished:true}}),
 ];
 const group=buildModelSiblingSwatches(bags).get(bags[0].id);
 assert.deepEqual(group.map(s=>s.name),['בורדו','ענבר']);
 assert.ok(group.every(s=>s.hex===null && colorSwatchStyle(s)===undefined));
 assert.equal(colorSwatchStyle({...group[0],imagePath:'http://unsafe.test/x.jpg'}),undefined);
 const changed=structuredClone(bags); changed[0].shopifyLink.variantId='1';
 assert.notEqual(buildModelSiblingSwatches(changed).get(changed[0].id)[0].name,'בורדו');
 const brics=[
  item('BAH08453.001',{shopifyLink:{handle:'bah08453-001',variantId:'50083958980858',isPublished:true}}),
  item('BAH08453.006',{shopifyLink:{handle:'bah08453-006',variantId:'50083959046394',isPublished:true}}),
 ];
 assert.deepEqual(buildModelSiblingSwatches(brics).get(brics[0].id).map(s=>s.name),['שחור','כחול']);
});

test('all 130 additional color labels are pinned to exact published variant identities', () => {
 const evidence=JSON.parse(readFileSync('docs/verified-other-store-color-names-20261109.json','utf8')).items;
 assert.equal(evidence.length,130);
 assert.equal(new Set(evidence.map(x=>x.sku)).size,130);
 assert.deepEqual(Object.keys(VERIFIED_PUBLISHED_COLOR_BINDINGS_20261109).sort(),evidence.map(x=>x.sku).sort());
 for(const e of evidence){
  const variantId=e.variantGid.split('/').at(-1);
  assert.deepEqual(VERIFIED_PUBLISHED_COLOR_BINDINGS_20261109[e.sku],{handle:e.handle,variantId,name:e.label});
  const row=item(e.sku,{shopifyLink:{handle:e.handle,variantId,isPublished:true}});
  assert.equal(verifiedPublishedColorName(row),e.label,e.sku);
  assert.equal(verifiedPublishedColorName({...row,shopifyLink:{...row.shopifyLink,isPublished:false}}),null,e.sku);
  assert.equal(verifiedPublishedColorName({...row,shopifyLink:{...row.shopifyLink,variantId:'1'}}),null,e.sku);
 }
});

test('all 209 verified color bindings use neutral text, never a potentially different product photo', () => {
 const evidence=['docs/verified-store-color-names-20261109.json','docs/verified-other-store-color-names-20261109.json']
   .flatMap(path=>JSON.parse(readFileSync(path,'utf8')).items);
 assert.equal(evidence.length,209);
 for(const e of evidence){
   const row=item(e.sku,{coverImagePath:'https://cdn.example.test/black-placeholder.jpg',shopifyLink:{handle:e.handle,variantId:e.variantGid.split('/').at(-1),isPublished:true}});
   const sibling=item(e.sku.slice(0,-3)+'ZZZ');
   const swatches=buildModelSiblingSwatches([row,sibling]).get(row.id);
   assert.ok(swatches,`model grouping ${e.sku}`);
   const selected=swatches.find(s=>s.itemId===row.id);
   assert.equal(selected.name,e.label,e.sku);
   assert.equal(selected.hex,null,e.sku);
   assert.equal(colorSwatchStyle(selected),undefined,e.sku);
 }
 const card=readFileSync('src/components/carousel/CarouselGrid.tsx','utf8');
 const modal=readFileSync('src/components/carousel/ProductModal.tsx','utf8');
 assert.match(card,/!swatch\.hex\s*\?\s*swatch\.name/);
 assert.match(modal,/!c\.hex\s*\?\s*c\.name/);
});
