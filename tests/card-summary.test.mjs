import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile(new URL('../src/lib/carousel/card-summary.ts', import.meta.url), 'utf8');
const { productCardSummary } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);

test('short product copy is unchanged and long specifications stay available to the caller', () => {
  const intro = 'תיק נסיעות קל עם רצועת כתף.';
  const full = `${intro}\n\nמידות: 40 × 25 × 20 ס״מ.\n\nתיאור ארוך נוסף.`;
  assert.equal(productCardSummary(full), intro);
  assert.ok(full.includes('40 × 25 × 20'));
});
test('long single paragraph is bounded at a word boundary without inventing copy', () => {
  const full = 'מזוודה קלה לנסיעה עם כיס קדמי ורצועות אריזה. '.repeat(30);
  const summary = productCardSummary(full);
  assert.ok(Array.from(summary).length <= 181);
  assert.ok(summary.endsWith('…'));
  assert.ok(full.startsWith(summary.slice(0, -1)));
});
test('handles empty and nonbreaking single-word Unicode safely', () => {
  assert.equal(productCardSummary('   '), '');
  const summary = productCardSummary('🧳'.repeat(220));
  assert.equal(Array.from(summary).length, 181);
  assert.ok(!summary.includes('\uFFFD'));
});
