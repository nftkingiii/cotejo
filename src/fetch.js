// Outbound page fetcher with SSRF protection. Every hop (including
// redirects) is resolved and checked against non-public address ranges, and
// the checked address is the one the socket connects to.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEADLINE_MS = 10_000;
export const USER_AGENT = 'CotejoBot/0.1 (+https://github.com/nftkingiii/cotejo)';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, bits, 'ipv6');

export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(ip)) return false; // hex-form mapped addresses
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

class FetchFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

// dns.lookup-compatible function that refuses non-public answers.
function guardedLookup(allowAddress) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(new FetchFailure('dns_not_found'));
      if (addrs.some((a) => !allowAddress(a.address))) {
        return cb(new FetchFailure('blocked_address'));
      }
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function reasonFor(err) {
  if (err instanceof FetchFailure) return err.code;
  const c = err?.code ?? '';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'dns_not_found';
  if (c === 'ECONNREFUSED') return 'refused';
  if (c === 'ECONNRESET' || c === 'EPIPE') return 'dropped';
  if (c.startsWith('ERR_TLS') || c.includes('CERT') || c === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'tls_invalid';
  return 'fetch_failed';
}

function oneRequest(url, { allowAddress, signal }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      agent: false,
      lookup: guardedLookup(allowAddress),
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location, status: res.statusCode });
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { truncated = true; req.destroy(); stream.destroy?.(); return; }
        chunks.push(c);
      });
      const done = () => resolve({
        status: res.statusCode,
        contentType: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks),
        truncated,
      });
      stream.on('end', done);
      stream.on('close', () => { if (truncated) done(); });
      stream.on('error', (e) => (truncated ? done() : reject(e)));
    });
    req.on('error', reject);
    req.end();
  });
}

// Validates a caller-supplied URL. Returns URL or throws FetchFailure.
const DEFAULT_PORTS = ['', '80', '443'];

export function parseTarget(raw, ports = DEFAULT_PORTS) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchFailure('invalid_url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchFailure('unsupported_scheme');
  if (url.username || url.password) throw new FetchFailure('credentials_in_url');
  if (!ports.includes(url.port)) throw new FetchFailure('unsupported_port');
  return url;
}

// Fetch a page. Never throws: returns { ok, reason?, status, final_url, ... }.
// allowAddress and ports exist so tests can reach a loopback fixture; the
// server always uses the defaults.
export async function fetchPage(rawUrl, { allowAddress = isPublicAddress, ports = DEFAULT_PORTS, deadlineMs = DEADLINE_MS } = {}) {
  const fetchedAt = new Date().toISOString();
  const signal = AbortSignal.timeout(deadlineMs);
  let url;
  try {
    url = parseTarget(rawUrl, ports);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && !allowAddress(host)) throw new FetchFailure('blocked_address');
      const res = await oneRequest(url, { allowAddress, signal });
      if (res.redirect) {
        const next = new URL(res.redirect, url);
        url = parseTarget(next.href, ports);
        continue;
      }
      return {
        ok: true,
        status: res.status,
        final_url: url.href,
        content_type: res.contentType.split(';')[0].trim().toLowerCase(),
        truncated: res.truncated,
        sha256: crypto.createHash('sha256').update(res.body).digest('hex'),
        bytes: res.body.length,
        body: res.body,
        fetched_at: fetchedAt,
      };
    }
    throw new FetchFailure('too_many_redirects');
  } catch (err) {
    const reason = signal.aborted ? 'no_response_in_time' : reasonFor(err);
    return { ok: false, reason, final_url: url?.href ?? null, fetched_at: fetchedAt };
  }
}
