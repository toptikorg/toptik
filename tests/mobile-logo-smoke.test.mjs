import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { assertLogoGeometry } from '../scripts/mobile-logo-smoke.mjs';

const rect = (left, right) => ({ left, right, top: 10, bottom: 30, width: right - left, height: 20 });
const good = () => ({ text: 'TOPTIK', visible: true, first: rect(5, 15), logo: rect(5, 100), clips: [], width: 320, height: 844, firstHit: true });
test('visible mobile logo passes geometry check', () => assert.doesNotThrow(() => assertLogoGeometry(good())));
test('first letter outside viewport fails', () => assert.throws(() => assertLogoGeometry({ ...good(), first: rect(-2, 8) }), /clipped/));
test('ancestor clipping fails', () => assert.throws(() => assertLogoGeometry({ ...good(), clips: [rect(10, 200)] }), /ancestor/));
test('covered first letter and invisible logo fail', () => { assert.throws(() => assertLogoGeometry({ ...good(), firstHit: false }), /covered/); assert.throws(() => assertLogoGeometry({ ...good(), visible: false }), /invisible/); });
