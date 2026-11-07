import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/lib/video-gallery.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(source).replaceAll('export ', '');
const context = vm.createContext({ URL });
const videos = vm.runInContext(`${js}\ngalleryVideos`, context);
const videoSchema = vm.runInContext("videoStructuredData", context);

test('each video has a unique route, playable file, poster, Hebrew captions and clean store links', () => {
  assert.equal(videos.length, 3);
  assert.equal(new Set(videos.map(video => video.slug)).size, videos.length);
  assert.deepEqual(Array.from(videos.filter(video => video.collection).map(video => video.slug)), ['intuo-upscape', 'choosing-55cm-trolley']);
  for (const video of videos.filter(video => video.collection)) {
    assert.equal(new URL(video.collection.url).origin, 'https://www.toptik.co.il');
    assert.equal(decodeURI(new URL(video.collection.url).pathname), '/collections/מזוודות');
  }
  for (const video of videos) {
    for (const extension of ['mp4', 'webp', 'he.vtt']) {
      const path = new URL(`../public/videos/${video.file}.${extension}`, import.meta.url);
      assert.equal(existsSync(path), true, `${video.slug} missing ${extension}`);
      assert.ok(statSync(path).size > 100, `${video.slug} empty ${extension}`);
    }
    const captions = readFileSync(new URL(`../public/videos/${video.file}.he.vtt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(captions, /^WEBVTT\n/);
    const cues = [...captions.matchAll(/(\d\d):(\d\d):(\d\d\.\d{3}) --> (\d\d):(\d\d):(\d\d\.\d{3})/g)];
    assert.ok(cues.length >= 2);
    let previousEnd = 0;
    for (const cue of cues) {
      const start = +cue[1] * 3600 + +cue[2] * 60 + +cue[3];
      const end = +cue[4] * 3600 + +cue[5] * 60 + +cue[6];
      assert.ok(start >= previousEnd && end > start && end <= (video.durationSeconds ?? 20), `${video.slug}: invalid caption timing`);
      previousEnd = end;
    }
    const text = captions.replace(/^WEBVTT\s*/, '').replace(/^\d\d:.*$/gm, '');
    const normalize = value => value.replace(/[\s.,?!׳״]+/g, '');
    assert.equal(normalize(text), normalize(video.transcript), `${video.slug}: captions differ from transcript`);
    assert.ok(video.transcript.length > 30);
    assert.ok(video.products.length > 0);
    for (const product of video.products) {
      const url = new URL(product.url);
      assert.equal(url.origin, 'https://www.toptik.co.il');
      assert.ok(url.pathname.startsWith('/products/'));
      assert.equal(url.search, '');
    }
  }
});

test('approved video pages are indexable, canonical and discoverable while unknown slugs remain excluded', () => {
  assert.equal(vm.runInContext("findGalleryVideo('does-not-exist')", context), undefined);
  for (const route of ['../src/app/videos/page.tsx', '../src/app/videos/[slug]/page.tsx']) {
    const source = readFileSync(new URL(route, import.meta.url), 'utf8');
    assert.match(source, /index:\s*true/);
    assert.match(source, /canonical:/);
  }
  const watchPage = readFileSync(new URL('../src/app/videos/[slug]/page.tsx', import.meta.url), 'utf8');
  assert.match(watchPage, /if \(!video\) return \{ robots: \{ index: false, follow: true \} \}/);
  const sitemap = readFileSync(new URL('../src/app/sitemap.ts', import.meta.url), 'utf8');
  assert.match(sitemap, /absoluteUrl\("\/videos"\)/);
  assert.match(sitemap, /galleryVideos\.map/);
  assert.match(sitemap, /absoluteUrl\(`\/videos\/\$\{video\.slug\}`\)/);
});

test('pause and resume do not inflate starts, and replay after completion counts a new start', () => {
  const playbackSource = readFileSync(new URL('../src/lib/video-playback.ts', import.meta.url), 'utf8');
  const playbackJS = stripTypeScriptTypes(playbackSource).replaceAll('export ', '');
  const playback = vm.runInNewContext(`${playbackJS}\ncreateVideoPlaybackTracker`, {});
  const events = [];
  const tracker = playback(event => events.push(event));
  tracker.ended();
  tracker.play();
  tracker.play();
  tracker.play();
  tracker.ended();
  tracker.ended();
  tracker.play();
  tracker.ended();
  assert.deepEqual(events, ['video_start', 'video_complete', 'video_start', 'video_complete']);
});


test('watch-page video metadata describes the actual video and canonical assets', () => {
  const seen = new Set();
  for (const video of videos) {
    const schema = videoSchema(video, 'https://landing.toptik.co.il');
    assert.equal(schema['@type'], 'VideoObject');
    assert.equal(schema.name, video.title);
    assert.equal(schema.description, video.description);
    assert.equal(schema.uploadDate, video.firstPublishedOn);
    assert.match(schema.uploadDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(schema.thumbnailUrl, `https://landing.toptik.co.il/videos/${video.file}.webp`);
    assert.equal(schema.contentUrl, `https://landing.toptik.co.il/videos/${video.file}.mp4`);
    assert.equal(schema['@id'], `https://landing.toptik.co.il/videos/${video.slug}#video`);
    assert.ok(!seen.has(schema.name));
    seen.add(schema.name);
  }
  const page = readFileSync(new URL('../src/app/videos/[slug]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /jsonLdString\(videoStructuredData\(video, SITE_ORIGIN\)\)/);
});

test('withdrawn red bag videos and their assets remain unavailable', () => {
  for (const slug of ['mandarina-duck-red-bag-city-style', 'mandarina-duck-city-bag']) {
    assert.equal(videos.some(video => video.slug === slug), false);
  }
  for (const file of ['04-mandarina', '05-mandarina-city-style']) {
    for (const ext of ['mp4', 'webp', 'he.vtt']) {
      assert.equal(existsSync(new URL(`../public/videos/${file}.${ext}`, import.meta.url)), false);
    }
  }
});
