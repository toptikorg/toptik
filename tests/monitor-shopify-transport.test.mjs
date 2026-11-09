import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorTransport } from '../scripts/monitor-shopify-transport.mjs';

function harness(handler, paced = true) {
  let time = 0;
  const calls = [];
  const transport = createMonitorTransport({
    paced, storeBase: 'https://www.toptik.co.il', now: () => time, wallNow: () => 0,
    sleep: async (ms) => { time += ms; },
    fetchImpl: async (url, options) => {
      calls.push({ url, time, options });
      assert.equal(options.signal.aborted, false, 'timeout starts only after the wait');
      return handler(url, options, calls.length);
    },
  });
  return { transport, calls };
}

test('parallel Shopify requests are serialized with 30 seconds between starts', async () => {
  const { transport, calls } = harness(() => new Response('ok'));
  await Promise.all(['one', 'two', 'three'].map((p) => transport(`https://www.toptik.co.il/${p}`)));
  assert.deepEqual(calls.map((call) => call.time), [0, 30_000, 60_000]);
});

test('the next request waits for the preceding response body to finish', async () => {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const { transport, calls } = harness((url, options, n) => n === 1 ? new Response(stream) : new Response('second'));
  const pending = Promise.all([transport('https://www.toptik.co.il/a'), transport('https://www.toptik.co.il/b')]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  controller.enqueue(new TextEncoder().encode('first')); controller.close();
  const [first, second] = await pending;
  assert.equal(await first.text(), 'first'); assert.equal(await second.text(), 'second');
  assert.deepEqual(calls.map((call) => call.time), [0, 30_000]);
});

test('redirect hops to Shopify, including from another host, are paced and credentials are not forwarded', async () => {
  const { transport, calls } = harness((url) => url.includes('/first')
    ? new Response(null, { status: 302, headers: { location: 'https://www.toptik.co.il/second' } })
    : url.includes('/second')
      ? new Response(null, { status: 302, headers: { location: '/third' } })
      : new Response('ok'));
  const result = await transport('https://landing.toptik.co.il/first', { headers: { authorization: 'test', cookie: 'private=1' } });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map((call) => call.time), [0, 0, 30_000]);
  assert.equal(new Headers(calls[1].options.headers).has('authorization'), false);
  assert.equal(new Headers(calls[1].options.headers).has('cookie'), false);
});

test('a Shopify 429 stops all queued and future Shopify calls and reports Retry-After', async () => {
  const { transport, calls } = harness(() => new Response(null, { status: 429, headers: { 'retry-after': '120' } }));
  const results = await Promise.allSettled([transport('https://www.toptik.co.il/a'), transport('https://www.toptik.co.il/b')]);
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /HTTP 429.*Retry-After: 120/);
  assert.equal(results[1].status, 'rejected');
  await assert.rejects(transport('https://cdn.shopify.com/file'), /HTTP 429/);
  assert.equal(calls.length, 1);
});

test('a 429 still closes the gate if response-body cancellation fails', async () => {
  const { transport, calls } = harness(() => ({ status: 429, headers: new Headers(), body: { cancel: async () => { throw new Error('stream failed'); } } }));
  await assert.rejects(transport('https://www.toptik.co.il/a'), /HTTP 429/);
  await assert.rejects(transport('https://www.toptik.co.il/b'), /HTTP 429/);
  assert.equal(calls.length, 1);
});

test('manual redirect requests preserve HEAD publication status', async () => {
  const { transport, calls } = harness(() => new Response(null, { status: 302, headers: { location: '/elsewhere' } }));
  const response = await transport('https://www.toptik.co.il/p', { method: 'HEAD', redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'HEAD');
});

test('Retry-After on 503 is honored for queued requests, including HTTP-date form', async () => {
  for (const header of ['120', 'Thu, 01 Jan 1970 00:02:00 GMT']) {
    const { transport, calls } = harness((url, options, n) => n === 1
      ? new Response(null, { status: 503, headers: { 'retry-after': header } }) : new Response('ok'));
    await Promise.all([transport('https://www.toptik.co.il/a'), transport('https://www.toptik.co.il/b')]);
    assert.deepEqual(calls.map((call) => call.time), [0, 120_000]);
  }
});

test('Retry-After on a redirect from outside the store delays the Shopify hop', async () => {
  const { transport, calls } = harness((url, options, n) => n === 1
    ? new Response(null, { status: 302, headers: { location: 'https://www.toptik.co.il/product', 'retry-after': '80' } })
    : new Response('ok'));
  await transport('https://landing.toptik.co.il/first');
  assert.deepEqual(calls.map((call) => call.time), [0, 80_000]);
});

test('default mode leaves native redirect and request scheduling intact', async () => {
  const { transport, calls } = harness(() => new Response('ok'), false);
  await Promise.all([transport('https://www.toptik.co.il/a'), transport('https://www.toptik.co.il/b')]);
  assert.deepEqual(calls.map((call) => call.time), [0, 0]);
  assert.equal(calls[0].options.redirect, undefined);
});
