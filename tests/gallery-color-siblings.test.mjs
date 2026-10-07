import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const colorGroups = moduleUrl(readFileSync('src/lib/carousel/color-groups.ts', 'utf8'));
const vendorDetect = moduleUrl(readFileSync('src/lib/catalog-source/vendor-detect.ts', 'utf8'));
const source = readFileSync('src/lib/carousel/colors.ts', 'utf8')
  .replace('"./color-groups"', JSON.stringify(colorGroups))
  .replace('"@/lib/catalog-source/vendor-detect"', JSON.stringify(vendorDetect));
const {modelCodeFromCatalog, colorCodeFromCatalog, buildModelSiblingSwatches, resolveItemSwatches} = await import(moduleUrl(source));

const item = (sku, overrides = {}) => ({
  id: sku, catalogNumber: sku, title: sku, isActive: true,
  coverImagePath: `${sku}-front.jpg`,
  angles: [{angleOrder: 2, imagePath: `${sku}-back.jpg`}, {angleOrder: 1, imagePath: `${sku}-front.jpg`}],
  ...overrides,
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
