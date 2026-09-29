// Text normalisation and quote matching. Pure functions, no I/O.

const PUNCT_MAP = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '-', '—': '-', '−': '-', ' ': ' ', '…': '...',
};

export function tokenize(text) {
  const s = String(text)
    .normalize('NFKC')
    .replace(/[‘-‟–—− …]/g, (c) => PUNCT_MAP[c] ?? c)
    .toLowerCase();
  return s.match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Longest common subsequence length over token arrays.
function lcs(a, b) {
  const prev = new Array(b.length + 1).fill(0);
  const cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

const NEAR = 0.9;
const PARTIAL = 0.6;

// Find `quote` in `text`. Returns { kind, score, excerpt } where kind is
// exact | near | partial | absent. Score is the share of quote tokens found
// in order inside the best window of the page.
export function findQuote(text, quote) {
  const q = tokenize(quote);
  const t = tokenize(text);
  if (q.length === 0) return { kind: 'absent', score: 0, excerpt: null, quote_tokens: 0 };

  const qs = q.join(' ');
  const ts = ` ${t.join(' ')} `;
  const at = ts.indexOf(` ${qs} `);
  if (at !== -1) {
    const startTok = ts.slice(0, at).split(' ').filter(Boolean).length;
    return { kind: 'exact', score: 1, excerpt: excerpt(t, startTok, startTok + q.length), quote_tokens: q.length };
  }
  if (t.length === 0) return { kind: 'absent', score: 0, excerpt: null, quote_tokens: q.length };

  // Slide a window a little wider than the quote, keeping a running multiset
  // overlap; rescore the best few windows with an order-aware LCS.
  const n = q.length;
  const w = Math.min(t.length, Math.ceil(n * 1.25) + 2);
  const need = new Map();
  for (const tok of q) need.set(tok, (need.get(tok) ?? 0) + 1);
  const have = new Map();
  let overlap = 0;
  const add = (tok, d) => {
    if (!need.has(tok)) return;
    const before = Math.min(have.get(tok) ?? 0, need.get(tok));
    have.set(tok, (have.get(tok) ?? 0) + d);
    overlap += Math.min(have.get(tok), need.get(tok)) - before;
  };
  for (let i = 0; i < w; i++) add(t[i], 1);
  const candidates = [[overlap, 0]];
  for (let s = 1; s + w <= t.length; s++) {
    add(t[s - 1], -1);
    add(t[s + w - 1], 1);
    candidates.push([overlap, s]);
  }
  candidates.sort((x, y) => y[0] - x[0] || x[1] - y[1]);

  let best = { score: 0, start: 0 };
  for (const [ov, s] of candidates.slice(0, 8)) {
    if (ov / n <= best.score) break;
    const score = lcs(q, t.slice(s, s + w)) / n;
    if (score > best.score) best = { score, start: s };
  }
  const score = Math.round(best.score * 1000) / 1000;
  const kind = score >= NEAR ? 'near' : score >= PARTIAL ? 'partial' : 'absent';
  return {
    kind,
    score,
    excerpt: kind === 'absent' ? null : excerpt(t, best.start, best.start + w),
    quote_tokens: n,
  };
}

function excerpt(tokens, from, to) {
  return tokens.slice(Math.max(0, from - 6), Math.min(tokens.length, to + 6)).join(' ');
}

// HTML to readable text: drop non-content elements, turn block tags into
// line breaks, strip remaining tags and decode entities.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...' };

export function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|br|li|h[1-6]|tr|td|th|blockquote|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}
