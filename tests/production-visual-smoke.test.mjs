import test from "node:test";
import assert from "node:assert/strict";
import { decodeHtmlAttribute, extractAttributeValues } from "../scripts/production-visual-smoke.mjs";

test("visual monitor extracts direct image and article URLs from rendered HTML", () => {
  const html = '<article><a href="/journal/example"><img src="https://www.toptik.co.il/a.jpg?v=1&amp;width=1200" alt="דוגמה"></a></article>';

  assert.deepEqual(extractAttributeValues(html, "img", "src"), ["https://www.toptik.co.il/a.jpg?v=1&width=1200"]);
  assert.deepEqual(extractAttributeValues(html, "a", "href"), ["/journal/example"]);
});

test("visual monitor decodes URL-safe HTML entities", () => {
  assert.equal(decodeHtmlAttribute("a&amp;b&#x27;c&quot;d"), "a&b'c\"d");
});
