// HTTP API. Follows Pocket gateway rules: every response is a JSON object,
// all inputs arrive in the POST body, 4xx for bad input, 5xx only for real
// server faults.

import http from 'node:http';
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

function validateItems(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return 'Body must be {"items": [{"url": "...", "quote": "..."}]}.';
  if (body.items.length === 0 || body.items.length > MAX_ITEMS) return `items must hold 1 to ${MAX_ITEMS} entries.`;
  for (const [i, it] of body.items.entries()) {
    if (!it || typeof it.url !== 'string' || it.url.length > 2048) return `items[${i}].url must be a string up to 2048 characters.`;
    if (it.quote != null && (typeof it.quote !== 'string' || it.quote.length > MAX_QUOTE)) return `items[${i}].quote must be a string up to ${MAX_QUOTE} characters.`;
    if (it.cited_at != null && !/^\d{4}-\d{2}-\d{2}$/.test(it.cited_at)) return `items[${i}].cited_at must be YYYY-MM-DD.`;
  }
  if (body.archive != null && !['auto', 'always', 'never'].includes(body.archive)) return 'archive must be auto, always or never.';
  return null;
}

export function createServer({ fetcher = fetchPage } = {}) {
  return http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && route === '/v1/version') return send(res, 200, { service: SERVICE_ID, version: VERSION });
      if (req.method === 'GET' && route === '/v1/health') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && (route === '/' || route === '/v1')) {
        return send(res, 200, {
          service: SERVICE_ID,
          version: VERSION,
          summary: 'Citation integrity for agents: is the cited page alive, is the quote actually on it, and if not, did an archived copy say it?',
          endpoints: {
            'POST /v1/check': 'Body {items:[{url, quote?, cited_at?}], archive?: auto|always|never}. Up to 10 items.',
            'POST /v1/match': 'Body {text, quote}. Pure text match, no fetching.',
            'GET /v1/verdicts': 'Meaning of each verdict.',
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
        const problem = validateItems(body);
        if (problem) return bad(res, 400, 'invalid_body', problem);
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
