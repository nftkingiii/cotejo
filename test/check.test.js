import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchPage, isPublicAddress } from '../src/fetch.js';
import { createServer } from '../src/server.js';

// A loopback fixture plays both the live web and the Wayback Machine.
const PAGES = {
  '/stable': '<html><body><p>The committee said it will not renew the contract in 2027.</p></body></html>',
  '/edited': '<html><body><p>The committee is reviewing the contract.</p></body></html>',
  '/pdf': '%PDF-1.7 binary',
};
const ARCHIVE = {
  '/edited': '<html><body><p>The committee said it will not renew the contract in 2027.</p></body></html>',
  '/gone': '<html><body><p>Our 2025 target is net zero across all sites.</p></body></html>',
};

let fixture, api, fixtureBase, apiBase;

before(async () => {
  fixture = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/wayback/available') {
      const target = new URL(u.searchParams.get('url')).pathname;
      const closest = ARCHIVE[target] ? { available: true, timestamp: '20250101000000', url: 'x', status: '200' } : undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ archived_snapshots: closest ? { closest } : {} }));
    }
    const snap = u.pathname.match(/^\/web\/\d+id_\/(.+)$/);
    if (snap) {
      const target = new URL(snap[1]).pathname;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(ARCHIVE[target]);
    }
    if (u.pathname === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PAGES['/pdf']); }
    if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGES[u.pathname]); }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<p>Not here</p>');
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const port = String(fixture.address().port);
  fixtureBase = `http://127.0.0.1:${port}`;

  // Route archive.org calls to the fixture, allow only the fixture's port.
  const fetcher = (url, opts = {}) => {
    const rewritten = url
      .replace('https://archive.org/wayback/available', `${fixtureBase}/wayback/available`)
      .replace('https://web.archive.org/web/', `${fixtureBase}/web/`);
    return fetchPage(rewritten, { ...opts, allowAddress: (ip) => ip === '127.0.0.1' || isPublicAddress(ip), ports: [port] });
  };
  api = createServer({ fetcher });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${api.address().port}`;
});

after(() => { fixture.close(); api.close(); });

const post = async (path, body) => {
  const r = await fetch(apiBase + path, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

test('health and version identify the service', async () => {
  assert.deepEqual(await (await fetch(`${apiBase}/v1/version`)).json(), { service: 'citation-check', version: '0.1.0' });
  assert.deepEqual(await (await fetch(`${apiBase}/v1/health`)).json(), { status: 'ok' });
});

test('one batch covers supported, drifted, not_found, dead_archived, dead, unchecked, rejected', async () => {
  const q = 'the committee said it will not renew the contract';
  const { status, json } = await post('/v1/check', { items: [
    { url: `${fixtureBase}/stable`, quote: q },
    { url: `${fixtureBase}/edited`, quote: q },
    { url: `${fixtureBase}/stable`, quote: 'the committee approved a ten year extension of the contract' },
    { url: `${fixtureBase}/gone`, quote: 'Our 2025 target is net zero across all sites' },
    { url: `${fixtureBase}/never`, quote: q },
    { url: `${fixtureBase}/pdf`, quote: q },
    { url: 'http://169.254.169.254/latest/meta-data/', quote: q },
  ] });
  assert.equal(status, 200);
  const v = json.results.map((r) => r.verdict);
  assert.deepEqual(v, ['supported', 'drifted', 'not_found', 'dead_archived', 'dead', 'unchecked', 'rejected']);
  assert.equal(json.summary.total, 7);

  const drifted = json.results[1];
  assert.equal(drifted.live.match.kind, 'absent');
  assert.equal(drifted.archive.match.kind, 'exact');
  assert.match(drifted.archive.snapshot_url, /^https:\/\/web\.archive\.org\/web\/20250101000000\//);
  assert.match(json.results[0].live.sha256, /^[0-9a-f]{64}$/);
  assert.equal(json.results[3].live.reason, 'http_404');
  assert.deepEqual(json.results.map((r) => r.archive_status), ['skipped', 'checked', 'none', 'checked', 'none', 'skipped', 'skipped']);
});

test('no quote reports liveness only', async () => {
  const { json } = await post('/v1/check', { items: [{ url: `${fixtureBase}/stable` }, { url: `${fixtureBase}/gone` }] });
  assert.deepEqual(json.results.map((r) => r.verdict), ['alive', 'dead_archived']);
});

test('bad input gets 4xx JSON, never 5xx', async () => {
  for (const body of [{}, { items: [] }, { items: new Array(11).fill({ url: 'https://example.com' }) }, { items: [{ url: 5 }] }, { items: [{ url: 'https://a.b', cited_at: 'yesterday' }] }]) {
    const { status, json } = await post('/v1/check', body);
    assert.equal(status, 400);
    assert.equal(json.error.code, 'invalid_body');
  }
  const r = await fetch(`${apiBase}/v1/check`, { method: 'POST', body: '{not json' });
  assert.equal(r.status, 400);
  assert.equal((await fetch(`${apiBase}/nope`)).status, 404);
});

test('match endpoint is a pure deterministic probe', async () => {
  const body = { text: 'Pocket Network relays paid API calls.', quote: 'relays paid API calls' };
  const a = await post('/v1/match', body);
  const b = await post('/v1/match', body);
  assert.equal(a.json.match.kind, 'exact');
  assert.deepEqual(a.json, b.json);
});
