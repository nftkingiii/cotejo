// Citation check: is the page alive, is the quote on it, and if not, did an
// archived copy say it?

import { fetchPage } from './fetch.js';
import { findQuote, htmlToText } from './match.js';

const INPUT_REJECTIONS = new Set(['invalid_url', 'unsupported_scheme', 'credentials_in_url', 'unsupported_port', 'blocked_address']);

export function pageText(page) {
  const type = page.content_type;
  const raw = page.body.toString('utf8');
  if (type === 'text/html' || type === 'application/xhtml+xml' || type === '') return htmlToText(raw);
  if (type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type.endsWith('+xml') || type === 'application/xml') return raw;
  return null;
}

function describe(page, quote) {
  if (!page.ok) return { reachable: false, reason: page.reason, final_url: page.final_url, fetched_at: page.fetched_at };
  const reachable = page.status >= 200 && page.status < 300;
  const out = {
    reachable,
    http_status: page.status,
    final_url: page.final_url,
    content_type: page.content_type || null,
    bytes: page.bytes,
    truncated: page.truncated,
    sha256: page.sha256,
    fetched_at: page.fetched_at,
  };
  if (!reachable) out.reason = `http_${page.status}`;
  if (reachable && quote) {
    const text = pageText(page);
    out.match = text === null ? { kind: 'unreadable', score: null, excerpt: null } : findQuote(text, quote);
  }
  return out;
}

const found = (m) => m && (m.kind === 'exact' || m.kind === 'near');

// Pocket relays and gateways give up at 30 s, so one item must finish inside
// BUDGET_MS. The live fetch gets up to 10 s; archive calls share what is left.
const BUDGET_MS = 25_000;
const LIVE_MS = 10_000;
const MIN_CALL_MS = 1_500;

const remaining = (deadline) => deadline - Date.now();

async function lookupArchive(url, citedAt, fetcher, deadline) {
  const q = new URL('https://archive.org/wayback/available');
  q.searchParams.set('url', url);
  if (citedAt) q.searchParams.set('timestamp', citedAt.replaceAll('-', ''));
  if (remaining(deadline) < MIN_CALL_MS) return { available: null, reason: 'out_of_time' };
  const res = await fetcher(q.href, { deadlineMs: remaining(deadline) });
  if (!res.ok || res.status !== 200) return { available: null, reason: res.reason ?? `http_${res.status}` };
  let snap;
  try { snap = JSON.parse(res.body.toString('utf8'))?.archived_snapshots?.closest; } catch { snap = null; }
  if (!snap?.available || !snap.timestamp) return { available: false };
  return {
    available: true,
    timestamp: snap.timestamp,
    snapshot_url: `https://web.archive.org/web/${snap.timestamp}/${url}`,
    raw_url: `https://web.archive.org/web/${snap.timestamp}id_/${url}`,
  };
}

export async function checkItem(item, { fetcher = fetchPage, archive = 'auto', budgetMs = BUDGET_MS } = {}) {
  const { url, quote = null, cited_at: citedAt = null } = item;
  const deadline = Date.now() + budgetMs;
  const livePage = await fetcher(url, { deadlineMs: Math.min(LIVE_MS, budgetMs) });

  if (!livePage.ok && INPUT_REJECTIONS.has(livePage.reason)) {
    return { url, quote, verdict: 'rejected', reason: livePage.reason, archive_status: 'skipped', live: null, archive: null };
  }

  const live = describe(livePage, quote);
  const unreadable = live.match?.kind === 'unreadable';
  const needArchive = archive === 'always' || (archive === 'auto' && (!live.reachable || (quote && !found(live.match) && !unreadable)));

  let arch = null;
  if (needArchive) {
    arch = await lookupArchive(url, citedAt, fetcher, deadline);
    if (arch.available && quote && remaining(deadline) < MIN_CALL_MS) {
      arch.match = null;
      arch.reason = 'out_of_time';
    } else if (arch.available && quote) {
      const snap = await fetcher(arch.raw_url, { deadlineMs: remaining(deadline) });
      const d = describe(snap, quote);
      arch.http_status = d.http_status ?? null;
      arch.sha256 = d.sha256 ?? null;
      arch.match = d.match ?? null;
    }
    delete arch.raw_url;
  }

  let verdict;
  if (!quote) {
    verdict = live.reachable ? 'alive' : arch?.available ? 'dead_archived' : 'dead';
  } else if (unreadable) {
    verdict = 'unchecked';
  } else if (found(live.match)) {
    verdict = 'supported';
  } else if (found(arch?.match)) {
    verdict = live.reachable ? 'drifted' : 'dead_archived';
  } else if (live.reachable) {
    verdict = live.match?.kind === 'partial' ? 'weak' : 'not_found';
  } else {
    verdict = arch?.match ? 'dead_unverified' : 'dead';
  }

  const uncompared = arch?.available && quote && !arch.match;
  const archiveStatus = !needArchive ? 'skipped' : arch.available === null || uncompared ? 'unavailable' : arch.available ? 'checked' : 'none';
  return { url, quote, verdict, archive_status: archiveStatus, live, archive: arch };
}

export const VERDICTS = {
  supported: 'Quote found on the live page (exact, or near with score >= 0.9).',
  weak: 'Live page has a partial match only (score 0.6-0.9); read the excerpt before relying on it.',
  not_found: 'Live page reachable; quote not on it or in any archived copy checked.',
  drifted: 'Live page no longer contains the quote, but the archived copy did. The source changed after it was cited.',
  dead_archived: 'Live page unreachable; the archived copy exists (and contains the quote, when one was given).',
  dead_unverified: 'Live page unreachable; an archived copy exists but does not contain the quote.',
  dead: 'Live page unreachable and no archived copy found.',
  alive: 'No quote given; live page reachable.',
  unchecked: 'Content type not readable as text (e.g. PDF, image); quote not checked.',
  rejected: 'URL refused before fetching (bad scheme, port, credentials, or non-public address).',
};

export const ARCHIVE_STATUS = {
  checked: 'An archived copy was found and compared.',
  none: 'The Wayback Machine has no copy of this URL.',
  unavailable: 'The archive lookup did not answer in time or failed; drifted and dead_archived could not be tested, so treat not_found and dead as provisional.',
  skipped: 'Not needed: the live page already settled the verdict (or archive=never).',
};

export async function checkBatch(items, opts = {}) {
  const results = await Promise.all(items.map((it) => checkItem(it, opts)));
  const summary = { total: results.length };
  for (const r of results) summary[r.verdict] = (summary[r.verdict] ?? 0) + 1;
  return { summary, results };
}
