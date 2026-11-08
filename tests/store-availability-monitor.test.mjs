import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoUnavailableVariants } from "../scripts/production-visual-smoke.mjs";

test("detects an unavailable variant without treating zero inventory as evidence", () => {
  assert.throws(() => assertNoUnavailableVariants([{ handle: "bag", variants: [{ sku: "BLUE", available: false }] }]), /bag \(BLUE\)/);
  assert.doesNotThrow(() => assertNoUnavailableVariants([{ handle: "bag", variants: [{ sku: "BLACK", available: true, inventory_quantity: 0 }] }]));
});

test("does not silently pass missing availability data", () => {
  assert.throws(() => assertNoUnavailableVariants([{ handle: "bag", variants: [{ id: 1 }] }]), /Missing availability/);
});
