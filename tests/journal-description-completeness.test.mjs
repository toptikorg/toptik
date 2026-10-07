import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// These checks catch known mechanical truncation patterns, not Hebrew grammar.
// A human content review must still confirm that each summary reads as complete.
function obviousTruncation(description, standfirst) {
  const text = description.trim();
  if (!/[.!?…]$/u.test(text)) return true;
  const stem = text.replace(/[.!?…]+$/u, "");
  if (!standfirst.startsWith(stem) || standfirst.length === stem.length) return false;
  return !/[.!?…]/u.test(standfirst.charAt(stem.length));
}

test("recognizes the previous mid-word and forced-period truncation defects", () => {
  assert.equal(obviousTruncation("דגם זה מתאי", "דגם זה מתאים ליום בעיר."), true);
  assert.equal(obviousTruncation("כך אפשר להתחיל את.", "כך אפשר להתחיל את החופשה יחד."), true);
  assert.equal(obviousTruncation("זו הקדמה שלמה.", "זו הקדמה שלמה. עכשיו ההמשך."), false);
  assert.equal(obviousTruncation("תקציר שנכתב בנפרד.", "הקדמה אחרת למאמר."), false);
});

for (const filename of ["product-guide-stories.json", "premium-stories.json"]) {
  test(`${filename} descriptions are distinct complete summaries without known clipping`, async () => {
    const stories = JSON.parse(await readFile(new URL(`../src/lib/editorial/${filename}`, import.meta.url), "utf8"));
    const seen = new Set();
    for (const story of stories) {
      assert.equal(typeof story.description, "string", story.slug);
      assert.equal(obviousTruncation(story.description, story.standfirst), false, `${story.slug}: review incomplete summary`);
      assert.ok(story.description.length >= 40 && story.description.length <= 180, `${story.slug}: editorial summary length`);
      assert.equal(seen.has(story.description), false, `${story.slug}: duplicate summary`);
      seen.add(story.description);
    }
  });
}
