import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchPage, isPublicAddress } from '../src/fetch.js';

test('non-public addresses are classified as blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});

test('literal private and metadata targets are refused before any request', async () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.5/']) {
    const r = await fetchPage(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.reason, 'blocked_address', url);
  }
});

test('hostnames resolving to loopback are refused', async () => {
  const r = await fetchPage('http://localhost/');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked_address');
});

test('bad schemes, ports and embedded credentials are refused', async () => {
  assert.equal((await fetchPage('file:///etc/passwd')).reason, 'unsupported_scheme');
  assert.equal((await fetchPage('ftp://example.com/')).reason, 'unsupported_scheme');
  assert.equal((await fetchPage('http://example.com:6379/')).reason, 'unsupported_port');
  assert.equal((await fetchPage('http://user:pw@example.com/')).reason, 'credentials_in_url');
  assert.equal((await fetchPage('not a url')).reason, 'invalid_url');
});

test('a redirect to a private address is refused', async () => {
  // Treat the loopback fixture as if it were public; its redirect to the
  // cloud metadata address must still be blocked.
  const srv = http.createServer((req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const r = await fetchPage(`http://127.0.0.1:${port}/`, { allowAddress: (ip) => ip === '127.0.0.1' || isPublicAddress(ip), ports: [String(port), ''] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'blocked_address');
  } finally { srv.close(); }
});
