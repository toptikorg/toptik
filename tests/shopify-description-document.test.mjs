import test from "node:test";
import assert from "node:assert/strict";
import { descriptionHelpers as document } from "./helpers/description-module.mjs";

test("rich descriptions retain structure, links, Hebrew entities and explicit clearing", () => {
  const html = '<p dir="rtl">תיק &amp; מזוודה</p><ul><li><strong>קל</strong></li></ul><table><tr><th>גובה</th><td>55</td></tr></table><p><a href="https://www.toptik.co.il/products/bag">פרטים</a></p>';
  assert.doesNotThrow(() => document.assertSafeDescriptionHtml(html));
  const text = document.descriptionTextFromHtml(html);
  assert.match(text, /תיק & מזוודה/);
  assert.match(text, /גובה\t55/);
  assert.match(text, /פרטים/);
  assert.equal(document.descriptionTextFromHtml(""), "");
  assert.equal(document.plainDescriptionToHtml(""), "");
  assert.equal(document.plainDescriptionToHtml('a < b\n& "quoted"'), '<p>a &lt; b<br>&amp; &quot;quoted&quot;</p>');
});

test("HTML comparison accepts serialization changes but detects link and format edits", () => {
  const a = '<p class="copy" dir="rtl"><a href="/products/a">תיק</a></p>';
  const b = "<p dir='rtl' class='copy'><a href='/products/a'>תיק</a></p>";
  assert.equal(document.canonicalDescriptionHtml(a), document.canonicalDescriptionHtml(b));
  assert.notEqual(document.canonicalDescriptionHtml(a), document.canonicalDescriptionHtml(a.replace('/products/a', '/products/b')));
  assert.notEqual(document.canonicalDescriptionHtml('<p>תיק</p>'), document.canonicalDescriptionHtml('<p><b>תיק</b></p>'));
});

test("active HTML, wrapper attributes and obfuscated URLs are rejected without sanitizing", () => {
  const inputs = [
    '<script>alert(1)</script>', '<img src="https://example.com/bag.jpg" onerror="alert(1)">',
    '<body onload="alert(1)"><p>תיק</p></body>', '<html onmouseover="alert(1)"><p>תיק</p></html>',
    '<meta http-equiv="refresh" content="0;url=https://example.com">', '<iframe src="https://example.com"></iframe>',
    '<a href="jav&#97;script:alert(1)">תיק</a>', '<a href="java&#10;script:alert(1)">תיק</a>',
    '<img src="data:image/svg+xml,a">', '<svg onload="alert(1)"></svg>',
    '<p style="background:url(https://example.com)">תיק</p>', '<p style="background:u/**/rl(https://example.com)">תיק</p>',
    '<form><input name="token"></form>', '<template><img onerror="alert(1)"></template>',
  ];
  for (const html of inputs) assert.throws(() => document.assertSafeDescriptionHtml(html), /SYNC_DESCRIPTION_HTML_UNSAFE/, html);
});

test("passive inline formatting is preserved and bounded", () => {
  assert.doesNotThrow(() => document.assertSafeDescriptionHtml('<p style="color:#222; text-align:right"><a href="mailto:service@toptik.co.il">יצירת קשר</a></p>'));
  assert.throws(() => document.assertSafeDescriptionHtml('x'.repeat(200001)), /UNSAFE/);
  assert.throws(() => document.assertSafeDescriptionHtml('a\u0000b'), /UNSAFE/);
});
