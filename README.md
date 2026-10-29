# Cotejo

Citation checks for AI agents, served on [Pocket Network](https://pocket.network).

An agent that cites a web page is making three claims: the page exists, it says what was quoted, and it said so when cited. Cotejo checks all three in one call, and when the live page no longer says it, looks at the Wayback Machine copy closest to the citation date to tell *drifted* sources from quotes that were never there.

- No LLM. Matching is token-normalised text comparison, so the same page and quote always give the same answer.
- Every fetched page is fingerprinted (SHA-256), so a verdict can be tied to exact bytes.
- Service ID on Pocket: `citation-check`. Registered on **mainnet** by `pokt17x658hzprsy9zuksrel852rj7xhd07330wepqj` in transaction `3663190C9AAD1880D79FCBB4A373E2EEEFCDAE4B6F4CE9CDE0FE9F3AAA01A399` (height 985706). Node runners: [SUPPLIER.md](SUPPLIER.md).

## Try it

### 1. Public demo (one command, no wallet)

A separate deployment of the same code, rate limited to 10 checks per hour per IP, 3 URLs per check and 300 checks per day in total. It exists so anyone can see the output; paid use goes through Pocket.

```bash
curl -s https://cotejo-demo.up.railway.app/v1/check \
  -d '{"items":[{"url":"https://example.com","quote":"This domain is for use in illustrative examples in documents","cited_at":"2023-01-01"}]}'
```

example.com has since reworded that sentence, so the answer is `drifted`: the live page scores a partial match, and the Wayback copy from January 2023 matches exactly. Drop `cited_at` or change the quote to see `supported`, `weak` or `not_found`; point it at a missing page for `dead` or `dead_archived`.

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri https://cotejo-demo.up.railway.app/v1/check -Body '{"items":[{"url":"https://example.com","quote":"This domain is for use in illustrative examples in documents","cited_at":"2023-01-01"}]}' | ConvertTo-Json -Depth 8
```

### 2. Paid relays through Pocket Network

**Mainnet:** `citation-check` is registered and waiting for its first supplier. Any staked supplier can add it at no extra stake; [SUPPLIER.md](SUPPLIER.md) covers the backend, the RelayMiner config and the services-only stake update. Paid relays open once a supplier serves it and an application is staked for it.

**Beta TestNet (retired):** the service ran end to end on Beta in September 2026. A relay signed by a staked application was served by supplier `pokt1ad55hvdg6ytvn6h9c8tfazyez33nq6x54t5428` and claimed in transaction `18562D18D7FF7539F17767BDFF9D63C817C311B981F1998EC42D71F64595B850` (height 688533). That supplier has since been retired, so Beta relays no longer reach it; the app and relay configs used then are kept in `pocket/beta/`.

## API

All inputs go in the POST body. Every response is a JSON object.

### `POST /v1/check`

```json
{
  "items": [
    { "url": "https://example.com", "quote": "This domain is for use in illustrative examples in documents", "cited_at": "2023-01-01" }
  ],
  "archive": "auto"
}
```

| Field | Required | Notes |
|---|---|---|
| `items` | yes | 1 to 10 entries |
| `items[].url` | yes | http or https, ports 80/443, public addresses only |
| `items[].quote` | no | Up to 2,000 characters. Omit to check liveness only |
| `items[].cited_at` | no | `YYYY-MM-DD`. The archive copy closest to this date is used; without it, the most recent copy |
| `archive` | no | `auto` (default: only when the live page does not settle it), `always`, `never` |

Response (trimmed):

```json
{
  "service": "citation-check",
  "checked_at": "2026-09-29T10:12:03.114Z",
  "summary": { "total": 1, "drifted": 1 },
  "results": [{
    "url": "https://example.com",
    "verdict": "drifted",
    "archive_status": "checked",
    "live": { "reachable": true, "http_status": 200, "sha256": "…", "match": { "kind": "partial", "score": 0.7 } },
    "archive": { "timestamp": "20230102000500", "snapshot_url": "https://web.archive.org/web/20230102000500/https://example.com", "match": { "kind": "exact", "score": 1 } }
  }]
}
```

### Verdicts

| Verdict | Meaning |
|---|---|
| `supported` | Quote on the live page (exact, or near with score ≥ 0.9) |
| `weak` | Partial match only (0.6 to 0.9); read the excerpt |
| `not_found` | Page reachable; quote not on it or in the archived copy |
| `drifted` | Live page no longer has the quote; the archived copy did |
| `dead_archived` | Page unreachable; archived copy exists (and has the quote, if one was given) |
| `dead_unverified` | Page unreachable; archived copy lacks the quote |
| `dead` | Page unreachable; no archived copy |
| `alive` | No quote given; page reachable |
| `unchecked` | Not readable as text (PDF, image) |
| `rejected` | Refused before fetching: bad scheme or port, credentials in URL, or a non-public address |

`archive_status` says whether the archive was `checked`, has `none`, was `unavailable` (lookup failed, so `not_found` and `dead` are provisional), or was `skipped`.

### `POST /v1/match`

`{"text": "...", "quote": "..."}` → `{"match": {"kind", "score", "excerpt"}}`. Pure function, no fetching.

### `GET /v1/health`, `GET /v1/version`, `GET /v1/verdicts`

## Run

```bash
npm test
npm start            # PORT=8080 by default
PUBLIC_DEMO=1 npm start   # rate-limited public demo mode
docker build -t cotejo . && docker run -p 8080:8080 cotejo
```

The image runs Node 24 LTS (pinned to 24.22.2); the code also runs on Node 22 or later. The supplier image in `pocket/relayminer` uses `pocket-relay-miner` v0.1.6, which builds the weighted proofs mainnet requires since poktroll v0.1.36. Set `POCKET_NETWORK=main` for mainnet endpoints, chain id `pocket` and a 60 s block time (default `beta`).

## Safety

Cotejo fetches URLs supplied by callers, so outbound requests are restricted: only http/https on ports 80 and 443, no credentials in URLs, at most 5 redirects, 3 MB per page, 10 s per fetch. Every DNS answer and every redirect target is checked against private, loopback, link-local, carrier-grade NAT, documentation and cloud-metadata ranges, and the socket connects to the address that was checked.

## Limits

- Pages are decoded as UTF-8; PDFs and images are `unchecked`.
- Pages that render their text with JavaScript may look empty.
- The archive is one snapshot (closest to `cited_at`, or latest). A quote that was on the page only between snapshots can read as `not_found`.

## License

MIT
