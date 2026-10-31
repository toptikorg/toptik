import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("journal thumbnail anchor reserves a definite card width before lazy image load", async () => {
  const page = await readFile(new URL("../src/app/journal/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/components/editorial/Journal.module.css", import.meta.url), "utf8");
  assert.match(page, /<Link className=\{styles\.archiveImageLink\}[^>]+tabIndex=\{-1\} aria-hidden="true">/);
  assert.match(css, /\.archiveImageLink\s*\{[^}]*align-self:\s*stretch;[^}]*width:\s*100%;/);
  assert.match(css, /\.archiveImage\s*\{[^}]*width:\s*100%;[^}]*aspect-ratio:\s*3\s*\/\s*2;/);
});

test("journal images bypass the unavailable production image optimizer", async () => {
  const archive = await readFile(new URL("../src/app/journal/page.tsx", import.meta.url), "utf8");
  const article = await readFile(new URL("../src/app/journal/[slug]/page.tsx", import.meta.url), "utf8");

  assert.match(archive, /<Image[^>]+unoptimized\s*\/>/);
  assert.equal((article.match(/<Image[^>]+unoptimized\s*\/>/g) || []).length, 2);
});
