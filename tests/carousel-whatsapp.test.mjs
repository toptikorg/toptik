import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("gallery WhatsApp contact links to the approved phone number", () => {
  const source = readFileSync(new URL("../src/app/carousel/CarouselPageClient.tsx", import.meta.url), "utf8");
  assert.match(source, /href="https:\/\/wa\.me\/972544444918"/);
  assert.match(source, /carousel-whatsapp-contact/);
});
