// HTTP API. Follows Pocket gateway rules: every response is a JSON object,
// all inputs arrive in the POST body, 4xx for bad input, 5xx only for real
// server faults.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBatch, VERDICTS, ARCHIVE_STATUS } from './check.js';
import { findQuote } from './match.js';
import { fetchPage } from './fetch.js';

export const SERVICE_ID = 'citation-check';
export const VERSION = '0.1.0';
const MAX_ITEMS = 10;
const MAX_BODY = 64 * 1024;
const MAX_QUOTE = 2000;
const MAX_TEXT = 200_000;

const OPENAPI_PATH = fileURLToPath(new URL('../pocket/openapi.json', import.meta.url));

// Public demo mode (PUBLIC_DEMO=1): a separate, unpaid deployment for people
// trying the API without a Pocket app. Paid relays go to a deployment with
// demo mode off, so these limits never apply to them.
export const DEMO_LIMITS = { perIpPerHour: 10, perDay: 300, maxItems: 3 };

function makeLimiter({ perIpPerHour, perDay }) {
  const ips = new Map();
  let day = { start: Date.now(), count: 0 };
  return (ip, now = Date.now()) => {
    if (now - day.start >= 86_400_000) day = { start: now, count: 0 };
    let w = ips.get(ip);
    if (!w || now - w.start >= 3_600_000) { w = { start: now, count: 0 }; ips.set(ip, w); }
    if (ips.size > 10_000) for (const [k, v] of ips) if (now - v.start >= 3_600_000) ips.delete(k);
    if (day.count >= perDay) return { ok: false, scope: 'daily', remaining: 0 };
    if (w.count >= perIpPerHour) return { ok: false, scope: 'hourly', remaining: 0 };
    w.count++; day.count++;
    return { ok: true, remaining: perIpPerHour - w.count };
  };
}

// Railway's edge sets X-Real-IP to the caller's address (documented under
// public networking specs). Elsewhere, fall back to the last forwarded hop,
// which a client cannot forge behind an appending proxy.
function clientIp(req) {
  const real = String(req.headers['x-real-ip'] ?? '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || req.socket.remoteAddress || 'unknown';
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const bad = (res, status, code, detail) => send(res, status, { error: { code, detail } });

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body_too_large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { reject(Object.assign(new Error('invalid_json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validateItems(body, maxItems) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return 'Body must be {"items": [{"url": "...", "quote": "..."}]}.';
  if (body.items.length === 0 || body.items.length > maxItems) return `items must hold 1 to ${maxItems} entries.`;
  for (const [i, it] of body.items.entries()) {
    if (!it || typeof it.url !== 'string' || it.url.length > 2048) return `items[${i}].url must be a string up to 2048 characters.`;
    if (it.quote != null && (typeof it.quote !== 'string' || it.quote.length > MAX_QUOTE)) return `items[${i}].quote must be a string up to ${MAX_QUOTE} characters.`;
    if (it.cited_at != null && !/^\d{4}-\d{2}-\d{2}$/.test(it.cited_at)) return `items[${i}].cited_at must be YYYY-MM-DD.`;
  }
  if (body.archive != null && !['auto', 'always', 'never'].includes(body.archive)) return 'archive must be auto, always or never.';
  return null;
}

export function createServer({ fetcher = fetchPage, demo = process.env.PUBLIC_DEMO === '1', limits = DEMO_LIMITS } = {}) {
  const limit = demo ? makeLimiter(limits) : null;
  const maxItems = demo ? limits.maxItems : MAX_ITEMS;
  let openapi = null;
  return http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && route === '/v1/version') return send(res, 200, { service: SERVICE_ID, version: VERSION });
      if (req.method === 'GET' && route === '/v1/health') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && (route === '/openapi.json' || route === '/v1/openapi')) {
        openapi ??= JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
        return send(res, 200, openapi);
      }
      if (req.method === 'GET' && (route === '/' || route === '/v1')) {
        return send(res, 200, {
          service: SERVICE_ID,
          version: VERSION,
          ...(demo && {
            mode: 'public-demo',
            demo_limits: `${limits.perIpPerHour} checks per hour per IP, ${limits.maxItems} items per check, ${limits.perDay} checks per day in total`,
            paid_access: 'Pocket Network service citation-check (REST): unmetered by these limits, up to 10 items per check.',
          }),
          summary: 'Citation integrity for agents: is the cited page alive, is the quote actually on it, and if not, did an archived copy say it?',
          endpoints: {
            'POST /v1/check': `Body {items:[{url, quote?, cited_at?}], archive?: auto|always|never}. Up to ${maxItems} items.`,
            'POST /v1/match': 'Body {text, quote}. Pure text match, no fetching.',
            'GET /v1/verdicts': 'Meaning of each verdict.',
            'GET /openapi.json': 'OpenAPI 3 contract.',
          },
        });
      }
      if (req.method === 'GET' && route === '/v1/verdicts') return send(res, 200, { verdicts: VERDICTS, archive_status: ARCHIVE_STATUS });

      if (req.method === 'POST' && route === '/v1/match') {
        const body = await readJson(req);
        if (!body || typeof body.text !== 'string' || typeof body.quote !== 'string') return bad(res, 400, 'invalid_body', 'Body must be {"text": "...", "quote": "..."}.');
        if (body.text.length > MAX_TEXT || body.quote.length > MAX_QUOTE) return bad(res, 413, 'too_large', `text up to ${MAX_TEXT} and quote up to ${MAX_QUOTE} characters.`);
        return send(res, 200, { service: SERVICE_ID, match: findQuote(body.text, body.quote) });
      }

      if (req.method === 'POST' && route === '/v1/check') {
        const body = await readJson(req);
        const problem = validateItems(body, maxItems);
        if (problem) return bad(res, 400, 'invalid_body', problem);
        if (limit) {
          const verdict = limit(clientIp(req));
          if (!verdict.ok) {
            return bad(res, 429, 'demo_limit_reached', verdict.scope === 'daily'
              ? 'The public demo has used its daily allowance. Call citation-check through Pocket Network instead.'
              : `The public demo allows ${limits.perIpPerHour} checks per hour per IP. Call citation-check through Pocket Network for more.`);
          }
          res.setHeader('x-demo-remaining', String(verdict.remaining));
        }
        const checkedAt = new Date().toISOString();
        const { summary, results } = await checkBatch(body.items, { fetcher, archive: body.archive ?? 'auto' });
        return send(res, 200, { service: SERVICE_ID, version: VERSION, checked_at: checkedAt, summary, results });
      }

      if (req.method !== 'GET' && req.method !== 'POST') return bad(res, 405, 'method_not_allowed', 'Use GET or POST.');
      return bad(res, 404, 'not_found', 'See GET /v1 for endpoints.');
    } catch (err) {
      if (err.status) return bad(res, err.status, err.message, null);
      console.error(err);
      return bad(res, 500, 'internal', null);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createServer().listen(port, '::', () => console.log(JSON.stringify({ msg: 'listening', service: SERVICE_ID, version: VERSION, port })));
}
