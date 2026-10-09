// The self-hosted-media audit is the standing guard against the "gallery angle
// re-hosts its own copy of a photo the store already carries" glitch. Every
// imported item is born self-hosted (import-handler.ts), and automatic adoption
// only fires once an angle already points at a store cdn URL, so a self-hosted
// angle is structurally invisible to it. These tests pin the guard's contract:
// it FLAGS self-hosted angles as candidates for human review, honours the three
// full-item and three angle-level exemptions verbatim, distinguishes store CDN
// from our Supabase bucket, and never mutates its input.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleOf = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const audit = await moduleOf(read("src/lib/shopify/self-hosted-media-audit.ts"));
const {
  isSelfHostedImagePath,
  auditSelfHostedMedia,
  SELF_HOSTED_AUDIT_EXEMPTIONS,
} = audit;

const STORE = "https://cdn.shopify.com/s/files/1/0622/8082/7130/products/SZV24_05J_06.jpg?v=1645786938";
const SELF = "https://abcdefgh.supabase.co/storage/v1/object/public/carousel-media/imports/mandarina/JNV05/08Q_01.jpg";

const angle = (order, imagePath, key = `k${order}`) => ({ angleOrder: order, angleKey: key, imagePath });
const item = (id, catalogNumber, angles) => ({ id, catalogNumber, angles });

test("isSelfHostedImagePath distinguishes store CDN from our Supabase bucket", () => {
  assert.equal(isSelfHostedImagePath(STORE), false);
  assert.equal(isSelfHostedImagePath(SELF), true);
  // A supabase URL in a different bucket is not the carousel-media glitch.
  assert.equal(isSelfHostedImagePath("https://x.supabase.co/storage/v1/object/public/other-bucket/a.jpg"), false);
  // A shopify-hosted asset is never self-hosted even if the URL also mentions supabase-ish text.
  assert.equal(isSelfHostedImagePath("https://cdn.shopify.com/s/files/carousel-media/a.jpg"), false);
  // Defensive: non-strings never throw and never flag.
  assert.equal(isSelfHostedImagePath(null), false);
  assert.equal(isSelfHostedImagePath(undefined), false);
  assert.equal(isSelfHostedImagePath(""), false);
});

test("a non-exempt item with a self-hosted angle is flagged as a candidate", () => {
  const items = [item("item-1", "P10NEW0001", [angle(1, STORE), angle(2, SELF)])];
  const result = auditSelfHostedMedia(items);
  assert.equal(result.scannedItems, 1);
  assert.equal(result.candidateAngleCount, 1);
  assert.equal(result.exemptAngleCount, 0);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0], {
    itemId: "item-1",
    catalogNumber: "P10NEW0001",
    selfHostedAngles: [{ angleOrder: 2, angleKey: "k2" }],
  });
});

test("an item fully linked to the store yields no candidate", () => {
  const result = auditSelfHostedMedia([item("item-ok", "P10OK0001", [angle(1, STORE), angle(2, STORE)])]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.candidateAngleCount, 0);
  assert.equal(result.exemptAngleCount, 0);
});

test("full-item exemptions are suppressed, not flagged", () => {
  for (const catalogNumber of ["ORI05500.024", "ORI05500.909", "P10ZJT06-24U-TU"]) {
    const result = auditSelfHostedMedia([item(`i-${catalogNumber}`, catalogNumber, [angle(1, SELF), angle(2, SELF)])]);
    assert.equal(result.candidates.length, 0, `${catalogNumber} must not be flagged`);
    assert.equal(result.candidateAngleCount, 0);
    assert.equal(result.exemptAngleCount, 2, `${catalogNumber} both self-hosted angles are exempt`);
  }
});

test("angle-level exemptions suppress only the named angles and still flag the rest", () => {
  // P10JNV0508Q exempts angles 1,2,3. Angle 4 self-hosted must still surface.
  const result = auditSelfHostedMedia([
    item("jnv", "P10JNV0508Q", [angle(1, SELF), angle(2, SELF), angle(3, SELF), angle(4, SELF), angle(5, STORE)]),
  ]);
  assert.equal(result.exemptAngleCount, 3);
  assert.equal(result.candidateAngleCount, 1);
  assert.deepEqual(result.candidates[0].selfHostedAngles, [{ angleOrder: 4, angleKey: "k4" }]);
});

test("angle-level exemption with every self-hosted angle exempt yields no candidate", () => {
  // P10SZV24-05J-TU exempts angles 1,2,3 — all self-hosted here.
  const result = auditSelfHostedMedia([
    item("szv", "P10SZV24-05J-TU", [angle(1, SELF), angle(2, SELF), angle(3, SELF), angle(4, STORE)]),
  ]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.exemptAngleCount, 3);
  assert.equal(result.candidateAngleCount, 0);
});

test("candidate angles are sorted by angleOrder and candidates sorted by catalogNumber", () => {
  const result = auditSelfHostedMedia([
    item("b", "P10BBB", [angle(3, SELF), angle(1, SELF)]),
    item("a", "P10AAA", [angle(2, SELF)]),
  ]);
  assert.deepEqual(result.candidates.map(c => c.catalogNumber), ["P10AAA", "P10BBB"]);
  assert.deepEqual(result.candidates[1].selfHostedAngles.map(a => a.angleOrder), [1, 3]);
});

test("an item with a null catalogNumber is still flagged (never silently exempt)", () => {
  const result = auditSelfHostedMedia([item("nc", null, [angle(1, SELF)])]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].catalogNumber, null);
});

test("audit is pure: it never mutates the input items or angles", () => {
  const items = [item("item-1", "P10NEW0001", [angle(1, STORE), angle(2, SELF)])];
  const snapshot = JSON.parse(JSON.stringify(items));
  auditSelfHostedMedia(items);
  assert.deepEqual(items, snapshot);
});

test("exemption table is exactly the six documented, verified entries", () => {
  assert.deepEqual([...SELF_HOSTED_AUDIT_EXEMPTIONS], [
    { catalogNumber: "ORI05500.024", fullItem: true },
    { catalogNumber: "ORI05500.909", fullItem: true },
    { catalogNumber: "P10ZJT06-24U-TU", fullItem: true },
    { catalogNumber: "P10JNV0508Q", angles: [1, 2, 3] },
    { catalogNumber: "P10JNV05465", angles: [5] },
    { catalogNumber: "P10SZV24-05J-TU", angles: [1, 2, 3] },
  ]);
});

test("a healthy, fully-reconciled catalog produces zero candidates (rerun idempotency)", () => {
  // Every real glitch fixed → every remaining self-hosted angle is exempt.
  const items = [
    item("i1", "P10NEW0001", [angle(1, STORE), angle(2, STORE)]),
    item("i2", "ORI05500.024", [angle(1, SELF)]),
    item("i3", "P10JNV0508Q", [angle(1, SELF), angle(2, SELF), angle(3, SELF), angle(4, STORE)]),
    item("i4", "P10JNV05465", [angle(5, SELF), angle(1, STORE)]),
  ];
  const result = auditSelfHostedMedia(items);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.candidateAngleCount, 0);
  assert.equal(result.exemptAngleCount, 5);
});
