import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

// Demo and relay servers side by side; the fetcher never touches the network.
const fetcher = async () => ({ ok: true, status: 200, final_url: 'https://example.org/', content_type: 'text/plain',
  truncated: false, sha256: '0'.repeat(64), bytes: 5, body: Buffer.from('hello'), fetched_at: new Date().toISOString() });

let demo, relay, demoBase, relayBase;
before(async () => {
  demo = createServer({ fetcher, demo: true, limits: { perIpPerHour: 2, perDay: 3, maxItems: 3 } });
  relay = createServer({ fetcher, demo: false });
  await new Promise((r) => demo.listen(0, '127.0.0.1', r));
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  demoBase = `http://127.0.0.1:${demo.address().port}`;
  relayBase = `http://127.0.0.1:${relay.address().port}`;
});
after(() => { demo.close(); relay.close(); });

const check = (base, ip, n = 1) => fetch(`${base}/v1/check`, {
  method: 'POST',
  headers: ip ? { 'x-forwarded-for': `203.0.113.99, ${ip}` } : {},
  body: JSON.stringify({ items: Array.from({ length: n }, () => ({ url: 'https://example.org/' })) }),
});

test('demo limits each caller per hour, keyed on the last forwarded address', async () => {
  assert.equal((await check(demoBase, '198.51.100.1')).status, 200);
  const second = await check(demoBase, '198.51.100.1');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-demo-remaining'), '0');
  const third = await check(demoBase, '198.51.100.1');
  assert.equal(third.status, 429);
  assert.equal((await third.json()).error.code, 'demo_limit_reached');
});

test('demo has a global daily cap across callers', async () => {
  assert.equal((await check(demoBase, '198.51.100.2')).status, 200); // 3rd of 3 for the day
  const r = await check(demoBase, '198.51.100.3');
  assert.equal(r.status, 429);
  assert.match((await r.json()).error.detail, /daily/);
});

test('demo caps items per check at 3', async () => {
  const r = await check(demoBase, '198.51.100.4', 4);
  assert.equal(r.status, 400);
});

test('relay backend is never rate limited and accepts 10 items', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await check(relayBase, '198.51.100.1')).status, 200);
  assert.equal((await check(relayBase, null, 10)).status, 200);
});

test('both modes serve the OpenAPI contract; only the demo labels itself', async () => {
  const spec = await (await fetch(`${relayBase}/openapi.json`)).json();
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.paths['/v1/check'].post);
  assert.equal((await (await fetch(`${demoBase}/`)).json()).mode, 'public-demo');
  assert.equal((await (await fetch(`${relayBase}/`)).json()).mode, undefined);
});
