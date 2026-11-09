import test from 'node:test';
import assert from 'node:assert/strict';
import { family, plan, policy } from './helpers/owned-edit-harness.mjs';

const stalePrior = 'SYNC_OWNED_COPY_CONFLICT';
async function setup(key, index = 0) {
  const f = await family(key);
  const source = await f.read(Date.now() + 45000);
  const variant = f.variants[index];
  const before = f.cardOf(variant.itemId);
  const run = (edit, live = source) => plan.planOwnedEdit({ source: live, variant, before, edit }, f.helpers);
  const apply = result => ({
    ...source,
    ...(result.copy ?? {}),
    media: source.media.map(m => ({ ...m, alt: result.mediaAlt.find(u => u.mediaId === m.id)?.alt ?? m.alt })),
  });
  return { f, source, variant, before, run, apply };
}

for (const key of ['fzt73', 'md20']) {
  const suffix = v => ` בצבע ${v.color}`;

  test(`${key}: an edit that changes nothing is a no-op and writes nothing`, async () => {
    const { run, before } = await setup(key);
    const result = run({ title: before.title, seoTitle: before.seo_title, coverImageAlt: before.cover_image_alt });
    assert.equal(result.noop, true);
    assert.equal(result.copy, null);
    assert.deepEqual(result.mediaAlt, []);
  });

  test(`${key}: description edit is shared by every color and validated as a rich pair`, async () => {
    const { f, run, apply, source } = await setup(key);
    const html = '<p>תיאור חדש לכל הצבעים</p><ul><li>כיס פנימי</li></ul>';
    const text = f.helpers.descriptionTextFromHtml(html);
    const result = run({ description: text, descriptionHtml: html });
    assert.deepEqual(result.written, ['description']);
    assert.equal(result.copy.descriptionHtml, html);
    const patched = apply(result);
    for (const v of f.variants) assert.equal(f.project(patched, v).description_html, html);
    assert.equal(f.project(source, f.variants[0]).description_html, '<p>' + (key === 'fzt73' ? 'עור איטלקי. כיס פנימי.' : 'תיק פאוץ׳ קטן.') + '</p>');
  });

  test(`${key}: plain text alone, mismatched pair and unsafe markup are refused before any write`, async () => {
    const { run } = await setup(key);
    assert.throws(() => run({ description: 'טקסט בלבד' }), /SYNC_DESCRIPTION_RICH_EDITOR_REQUIRED/);
    assert.throws(() => run({ description: 'לא תואם', descriptionHtml: '<p>אחר</p>' }), /SYNC_DESCRIPTION_PAIR_MISMATCH/);
    assert.throws(() => run({ description: 'x', descriptionHtml: '<p>x</p><script>alert(1)</script>' }), /SYNC_DESCRIPTION_HTML_UNSAFE|SYNC_DESCRIPTION_PAIR_MISMATCH/);
  });

  test(`${key}: SEO title keeps the verified color suffix and rejects anything else`, async () => {
    const { run, variant, apply, f } = await setup(key);
    const good = 'כותרת SEO חדשה' + suffix(variant);
    const result = run({ seoTitle: good });
    assert.equal(result.copy.seoTitle, 'כותרת SEO חדשה');
    assert.equal(f.project(apply(result), variant).seo_title, good);
    assert.throws(() => run({ seoTitle: 'בלי סיומת צבע' }), /SYNC_OWNED_SEO_TITLE_SUFFIX_REQUIRED/);
    assert.throws(() => run({ seoTitle: suffix(variant) }), /SYNC_OWNED_SEO_TITLE_INVALID/);
    assert.throws(() => run({ seoTitle: ' רווח' + suffix(variant) }), /SYNC_OWNED_SEO_TITLE_INVALID/);
    assert.throws(() => run({ seoTitle: 'א'.repeat(130) + suffix(variant) }), /SYNC_OWNED_SEO_TITLE_INVALID/);
  });

  test(`${key}: SEO description round-trips exactly or is refused`, async () => {
    const { run, variant, apply, f } = await setup(key);
    const good = 'משפט ראשון חדש' + suffix(variant) + '. משפט שני.';
    const result = run({ seoDescription: good });
    assert.equal(result.copy.seoDescription, 'משפט ראשון חדש. משפט שני.');
    assert.equal(f.project(apply(result), variant).seo_description, good);
    assert.throws(() => run({ seoDescription: 'בלי נקודה' + suffix(variant) }), /SYNC_OWNED_SEO_DESCRIPTION_NOT_REPRESENTABLE/);
    assert.throws(() => run({ seoDescription: 'משפט בלי צבע.' }), /SYNC_OWNED_SEO_DESCRIPTION_NOT_REPRESENTABLE/);
    assert.throws(() => run({ seoDescription: '' }), /SYNC_OWNED_SEO_DESCRIPTION_NOT_REPRESENTABLE/);
  });

  test(`${key}: a SEO description is never rewritten when the card hides sentences that Shopify has`, async () => {
    const { f, variant } = await setup(key);
    f.state.product.seo.description = Array.from({ length: 6 }, (_, i) => `משפט מספר ${i + 1} ארוך מאוד שממלא את החלון של מאה ושישים תווים`).join('. ') + '.';
    const source = await f.read(Date.now() + 45000);
    const before = f.project(source, variant);
    assert.ok(before.seo_description.length <= 160);
    assert.throws(() => plan.planOwnedEdit({ source, variant, before, edit: {
      seoDescription: 'משפט מספר 1 ארוך מאוד שממלא את החלון של מאה ושישים תווים' + suffix(variant) + '.' } }, f.helpers), /SYNC_OWNED_SEO_DESCRIPTION_NOT_REPRESENTABLE/);
  });

  test(`${key}: a field changed in Shopify after the editor loaded is a conflict, other fields still go through`, async () => {
    const { f, source, variant, before } = await setup(key);
    const live = structuredClone(source);
    live.title = 'כותרת שהשתנתה בחנות';
    live.descriptionHtml = '<p>תיאור שהשתנה בחנות</p>';
    const edit = { description: 'תיאור שלי', descriptionHtml: '<p>תיאור שלי</p>' };
    assert.throws(() => plan.planOwnedEdit({ source: live, variant, before, edit }, f.helpers), new RegExp(stalePrior));
    const titleOnlyElsewhere = plan.planOwnedEdit({ source: live, variant, before, edit: { seoDescription: 'חדש' + suffix(variant) + '.' } }, f.helpers);
    assert.deepEqual(titleOnlyElsewhere.written, ['seoDescription']);
  });

  test(`${key}: a value Shopify already holds is reported as applied, not written again`, async () => {
    const { f, source, variant, before } = await setup(key);
    const live = structuredClone(source);
    live.descriptionHtml = '<p>כבר בחנות</p>';
    const result = plan.planOwnedEdit({ source: live, variant, before, edit: { description: 'כבר בחנות', descriptionHtml: '<p>כבר בחנות</p>' } }, f.helpers);
    assert.equal(result.noop, true);
    assert.deepEqual(result.alreadyApplied, ['description']);
  });

  test(`${key}: image alt text maps to the exact Shopify image of this color`, async () => {
    const { run, before, variant, apply, f, source } = await setup(key);
    const second = before.angles[1];
    const alt = key === 'md20' ? 'תמונה שנייה מעודכנת' + second.image_alt.match(/ \| [^|]+ \| \d+$/)[0] : 'תיאור חדש לתמונה השנייה';
    const result = run({ angleAlts: [{ imagePath: second.image_path, imageAlt: alt }] });
    assert.equal(result.copy, null);
    assert.equal(result.mediaAlt.length, 1);
    assert.equal(result.mediaAlt[0].mediaId, source.media.find(m => m.image.url === second.image_path).id);
    assert.equal(f.project(apply(result), variant).angles[1].image_alt, alt);
    // The other colors' images are untouched.
    for (const other of f.variants.filter(v => v !== variant)) {
      assert.deepEqual(f.project(apply(result), other).angles, f.project(source, other).angles);
    }
  });

  test(`${key}: cover alt text is the first image's alt and cannot disagree with it`, async () => {
    const { run, before, f, source, variant, apply } = await setup(key);
    const token = key === 'md20' ? before.angles[0].image_alt.match(/ \| [^|]+ \| \d+$/)[0] : '';
    const result = run({ coverImageAlt: 'כיסוי חדש' + token });
    assert.equal(result.mediaAlt[0].mediaId, source.media.find(m => m.image.url === before.cover_image_path).id);
    assert.equal(f.project(apply(result), variant).cover_image_alt, 'כיסוי חדש' + token);
    assert.throws(() => run({ coverImageAlt: 'א' + token, angleAlts: [{ imagePath: before.cover_image_path, imageAlt: 'ב' + token }] }), /SYNC_OWNED_ALT_CONFLICT/);
    const same = run({ coverImageAlt: 'זהה' + token, angleAlts: [{ imagePath: before.cover_image_path, imageAlt: 'זהה' + token }] });
    assert.equal(same.mediaAlt.length, 1);
  });

  test(`${key}: unknown or other-color images and unusable alt text are refused`, async () => {
    const { run, before, f, variant } = await setup(key);
    const other = f.project(await f.read(Date.now() + 45000), f.variants[1]).angles[0].image_path;
    assert.throws(() => run({ angleAlts: [{ imagePath: other, imageAlt: 'שייך לצבע אחר' }] }), /SYNC_OWNED_ALT_IMAGE_UNKNOWN/);
    assert.throws(() => run({ angleAlts: [{ imagePath: 'https://example.com/x.jpg', imageAlt: 'לא קיים' }] }), /SYNC_OWNED_ALT_IMAGE_UNKNOWN/);
    const path = before.angles[0].image_path;
    const token = key === 'md20' ? before.angles[0].image_alt.match(/ \| [^|]+ \| \d+$/)[0] : '';
    assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: ' ' + 'א' + token }] }), /SYNC_OWNED_ALT_INVALID/);
    assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: 'א'.repeat(513) + token }] }), /SYNC_OWNED_ALT_INVALID/);
    assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: 'א\nב' + token }] }), /SYNC_OWNED_ALT_INVALID/);
    assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: 'א' + token }, { imagePath: path, imageAlt: 'ב' + token }] }), /SYNC_OWNED_ALT_CONFLICT/);
    assert.ok(variant);
  });

  test(`${key}: a title that would break another color's SEO limits is refused before Shopify is touched`, async () => {
    const { f, variant } = await setup(key);
    f.state.product.seo.title = null;
    const source = await f.read(Date.now() + 45000);
    const before = f.project(source, variant);
    const long = 'א'.repeat(112);
    const title = key === 'fzt73' ? long + suffix(variant) : long;
    assert.throws(() => plan.planOwnedEdit({ source, variant, before, edit: { title } }, f.helpers), /SYNC_ONBOARDING_COPY_LIMIT/);
  });
}

test('a SEO description longer than the 160-character card window cannot round-trip and is refused', async () => {
  for (const key of ['fzt73', 'md20']) {
    const { run, variant } = await setup(key);
    const long = ['ראשון', 'ב'.repeat(80), 'ג'.repeat(80)]
      .map((sentence, index) => index === 0 ? sentence + ` בצבע ${variant.color}.` : sentence + '.').join(' ');
    assert.ok(long.length > 160);
    assert.throws(() => run({ seoDescription: long }), /SYNC_OWNED_EDIT_NOT_REPRESENTABLE/);
  }
});

test('fzt73: a SEO title that fits this color but not a longer color name is refused, because it would stall the family', async () => {
  const { run, variant, f } = await setup('fzt73', 0);
  const longest = f.variants.reduce((a, b) => b.color.length > a.color.length ? b : a);
  assert.notEqual(longest, variant);
  const room = 120 - ` בצבע ${variant.color}`.length;
  const seoTitle = 'א'.repeat(room) + ` בצבע ${variant.color}`;
  assert.equal(seoTitle.length, 120);
  assert.throws(() => run({ seoTitle }), /SYNC_ONBOARDING_COPY_LIMIT/);
  const safe = 'א'.repeat(120 - ` בצבע ${longest.color}`.length) + ` בצבע ${variant.color}`;
  assert.ok(run({ seoTitle: safe }).written.includes('seoTitle'));
});

test('fzt73: the color suffix belongs to the variant, so the title must keep it', async () => {
  const { run, variant, apply, f, source } = await setup('fzt73', 1);
  const result = run({ title: 'פאוץ׳ עור חדש בצבע ' + variant.color });
  assert.equal(result.copy.title, 'פאוץ׳ עור חדש');
  for (const v of f.variants) assert.equal(f.project(apply(result), v).title, 'פאוץ׳ עור חדש בצבע ' + v.color);
  assert.throws(() => run({ title: 'פאוץ׳ עור חדש' }), /SYNC_OWNED_TITLE_SUFFIX_REQUIRED/);
  assert.throws(() => run({ title: 'פאוץ׳ בצבע אחר בצבע פחם' }), /SYNC_OWNED_TITLE_SUFFIX_REQUIRED/);
  assert.throws(() => run({ title: ' בצבע ' + variant.color }), /SYNC_OWNED_TITLE_INVALID/);
  assert.throws(() => run({ title: 'ב'.repeat(121) + ' בצבע ' + variant.color }), /SYNC_OWNED_TITLE_INVALID|SYNC_ONBOARDING_COPY_LIMIT/);
  assert.equal(f.project(source, variant).title, 'פאוץ׳ עור קלאסי בצבע ' + variant.color);
});

test('md20: the three colors share the Shopify title, with no color suffix', async () => {
  const { run, variant, apply, f } = await setup('md20', 2);
  const result = run({ title: 'MD 20 תיק פאוץ׳ חדש' });
  assert.equal(result.copy.title, 'MD 20 תיק פאוץ׳ חדש');
  for (const v of f.variants) assert.equal(f.project(apply(result), v).title, 'MD 20 תיק פאוץ׳ חדש');
  assert.ok(variant);
});

test('md20: edited alt text must keep the SKU and order token that maps the image to its color', async () => {
  const { run, before } = await setup('md20');
  const path = before.angles[0].image_path;
  assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: 'בלי אסימון' }] }), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
  assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: 'אסימון אחר | P10QMMM109K | 1' }] }), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
  assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: 'סדר אחר | ' + policy.MD20_VARIANTS[0].sku + ' | 2' }] }), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
  assert.throws(() => run({ angleAlts: [{ imagePath: path, imageAlt: ' | ' + policy.MD20_VARIANTS[0].sku + ' | 1' }] }), /SYNC_OWNED_ALT_INVALID|SYNC_OWNED_ALT_TOKEN_REQUIRED/);
});

test('requireVariantMediaToken accepts only the same SKU and order with some text before it', () => {
  const variant = { sku: 'P10QMMM1651', color: 'שחור' };
  plan.requireVariantMediaToken(variant, 'ישן | P10QMMM1651 | 3', 'חדש | P10QMMM1651 | 3');
  for (const bad of ['חדש', 'חדש | P10QMMM1651 | 4', 'חדש | P10QMMM1465 | 3', ' | P10QMMM1651 | 3'])
    assert.throws(() => plan.requireVariantMediaToken(variant, 'ישן | P10QMMM1651 | 3', bad), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
  assert.throws(() => plan.requireVariantMediaToken(variant, 'ישן בלי אסימון', 'חדש | P10QMMM1651 | 3'), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
});

test('requireVariantMediaToken preserves the literal live Hebrew suffix, without numeric normalization', () => {
  const variant = { sku: 'P10QMMM1651', color: 'שחור' };
  const suffix = ' | P10QMMM1651 | תמונה 3';
  plan.requireVariantMediaToken(variant, 'ישן' + suffix, 'חדש' + suffix);
  for (const bad of ['חדש | P10QMMM1651 | 3', 'חדש | P10QMMM1651 | תמונה 4',
    'חדש | P10QMMM1465 | תמונה 3', 'חדש | P10QMMM1651 | תמונה 03',
    'חדש | P10QMMM1651 | תמונה3', 'חדש | P10QMMM1651 | תמונות 3', suffix]) {
    assert.throws(() => plan.requireVariantMediaToken(variant, 'ישן' + suffix, bad), /SYNC_OWNED_ALT_TOKEN_REQUIRED/, bad);
  }
  for (const malformed of ['ישן | P10QMMM1651 | תמונה 0', 'ישן | P10QMMM1651 | תמונה NaN',
    'ישן | P10QMMM1651 | תמונה 9007199254740993', 'ישן | P10QMMM1465 | תמונה 3',
    'ישן | P10QMMM1465 | תמונה 1' + suffix, 'ישן' + suffix + suffix]) {
    assert.throws(() => plan.requireVariantMediaToken(variant, malformed, 'חדש' + suffix), /SYNC_OWNED_ALT_TOKEN_REQUIRED/, malformed);
  }
});

test('the 13 QMMM1 ALT strings captured in the live preflight retain their exact technical suffix', () => {
  // Snapshot from the owner's 2026-11-09 read-only preflight, not a network dependency.
  let checked = 0;
  for (const [sku, count] of [['P10QMMM109K', 4], ['P10QMMM1465', 4], ['P10QMMM1651', 5]]) {
    const variant = policy.MD20_VARIANTS.find(row => row.sku === sku);
    assert.ok(variant);
    for (let order = 1; order <= count; order++) {
      const suffix = ` | ${sku} | תמונה ${order}`;
      const liveAlt = 'פאוץ׳ Mandarina Duck MD20 QMMM1' + suffix;
      plan.requireVariantMediaToken(variant, liveAlt, 'תיאור נגיש מעודכן' + suffix);
      assert.throws(() => plan.requireVariantMediaToken(variant, liveAlt, `תיאור נגיש מעודכן | ${sku} | ${order}`), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
      checked++;
    }
  }
  assert.equal(checked, 13);
});

test('md20: real Hebrew ALT suffixes pass source read, projection, edit planning and another source read for every color', async () => {
  const f = await family('md20');
  // The live source uses this exact label. Keep the fixture's legacy numeric form covered above.
  for (const media of f.state.product.media.nodes) media.alt = media.alt.replace(/ \| (\d+)$/, ' | תמונה $1');
  for (const variant of f.variants) {
    const source = await f.read(Date.now() + 45000);
    const before = f.project(source, variant);
    const suffix = angle => angle.image_alt.match(/ \| [^|]+ \| תמונה \d+$/)[0];
    const coverAlt = 'תיאור ראשי מדויק' + suffix(before.angles[0]);
    const angleAlt = 'תיאור תמונה שנייה מדויק' + suffix(before.angles[1]);
    const result = plan.planOwnedEdit({ source, variant, before, edit: {
      coverImageAlt: coverAlt, angleAlts: [{ imagePath: before.angles[1].image_path, imageAlt: angleAlt }],
    } }, f.helpers);
    assert.equal(result.copy, null);
    assert.equal(result.mediaAlt.length, 2);
    for (const update of result.mediaAlt) f.state.product.media.nodes.find(media => media.id === update.mediaId).alt = update.alt;
    const readback = await f.read(Date.now() + 45000);
    const after = f.project(readback, variant);
    assert.equal(after.cover_image_alt, coverAlt);
    assert.equal(after.angles[1].image_alt, angleAlt);
    assert.deepEqual(after.angles.map(angle => angle.image_path), before.angles.map(angle => angle.image_path));
    for (const other of f.variants.filter(row => row !== variant)) assert.deepEqual(f.project(readback, other).angles, f.project(source, other).angles);
    assert.ok(result.mediaAlt.every(update => update.alt.includes(' | ' + variant.sku + ' | תמונה ')));
  }
});

test('md20: Hebrew suffix edits still reject foreign, duplicate, malformed and overlapping markers', async () => {
  const f = await family('md20');
  for (const media of f.state.product.media.nodes) media.alt = media.alt.replace(/ \| (\d+)$/, ' | תמונה $1');
  const source = await f.read(Date.now() + 45000), variant = f.variants[0], before = f.project(source, variant);
  const own = ' | ' + variant.sku + ' | תמונה 1';
  const foreign = ' | ' + f.variants[1].sku + ' | תמונה 1';
  const invalid = ['תיאור' + foreign, 'תיאור | ' + variant.sku + ' | 1',
    'תיאור' + foreign + own, 'תיאור' + own + own,
    'תיאור | UNKNOWN | malformed' + own,
    'תיאור | ' + f.variants[1].sku + own, 'תיאור | ' + variant.sku + own,
    'תיאור | ' + variant.sku + ' | תמונה 2'];
  for (const desired of invalid) {
    assert.throws(() => plan.planOwnedEdit({ source, variant, before, edit: { coverImageAlt: desired } }, f.helpers), /SYNC_OWNED_ALT_TOKEN_REQUIRED/, desired);
  }
  assert.ok(f.state.product.media.nodes.every(media => !media.alt.includes('UNKNOWN')), 'planning refusals never change source data');
});

test('md20: a foreign or duplicate token before the own suffix is refused before delivery', async () => {
  const { run, before } = await setup('md20');
  const own = ' | ' + policy.MD20_VARIANTS[0].sku + ' | 1';
  const foreign = ' | ' + policy.MD20_VARIANTS[1].sku + ' | 1';
  for (const prefix of [foreign, own, ' | UNKNOWN | 4', ' | ' + policy.MD20_VARIANTS[1].sku + ' | malformed']) {
    assert.throws(() => run({ coverImageAlt: 'תיאור' + prefix + own }), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
  }
  assert.throws(() => run({ coverImageAlt: 'תיאור | ' + policy.MD20_VARIANTS[0].sku + own }), /SYNC_OWNED_ALT_TOKEN_REQUIRED/);
  assert.ok(before.cover_image_path);
});

test('invertSeoDescription mirrors the forward projection shape', () => {
  const suffix = ' בצבע שחור';
  assert.equal(plan.invertSeoDescription('א' + suffix + '.', suffix), 'א.');
  assert.equal(plan.invertSeoDescription('א' + suffix + '. ב. ג.', suffix), 'א. ב. ג.');
  for (const bad of ['', 'א.', 'א' + suffix, ' ' + suffix + '.', 'א' + suffix + '.  . ב.', 'א ' + suffix + '. ב'])
    assert.equal(plan.invertSeoDescription(bad, suffix), null, JSON.stringify(bad));
});
