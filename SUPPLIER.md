# Serving citation-check on Pocket mainnet

For node runners adding Cotejo's `citation-check` service to a supplier.

| | |
|---|---|
| Service id | `citation-check` ("Cotejo Citation Check") |
| Compute units per relay | 50,000 |
| Owner | `pokt17x658hzprsy9zuksrel852rj7xhd07330wepqj` |
| Registered | tx `3663190C9AAD1880D79FCBB4A373E2EEEFCDAE4B6F4CE9CDE0FE9F3AAA01A399`, height 985706 |
| RPC type | REST |
| Extra stake | none: `stake_per_additional_service` is 0 on mainnet |

Three steps: run the backend, add the service to your RelayMiner, then add it to your supplier's stake.

## 1. Run the backend

One Node 24 LTS container with no dependencies. It needs about 1 GB of RAM, 1 GB of disk and outbound HTTPS: every check fetches the cited public pages and, when needed, the Wayback Machine.

```bash
git clone https://github.com/nftkingiii/cotejo && cd cotejo
docker build -t cotejo .
docker network create pocket 2>/dev/null || true
docker run -d --name cotejo --network pocket --restart unless-stopped cotejo
docker run --rm --network pocket curlimages/curl -fsS http://cotejo:8080/v1/health   # {"status":"ok"}
```

The backend only fetches public http(s) addresses on ports 80 and 443. Private, loopback, link-local and metadata ranges are refused on every DNS answer and redirect, so it can sit next to other services. It never needs inbound access from the internet: only your RelayMiner calls it.

## 2. Add the service to your RelayMiner

Use pocket-relay-miner **v0.1.6 or later**. Mainnet applied poktroll v0.1.36 at height 982867, and releases before v0.1.5 build proofs that it refuses.

**Already running a RelayMiner:** add this entry under `relayer.services` (standalone mode) or `services` (the high-availability relayer), next to your existing services, and restart:

```yaml
citation-check:
  validation_mode: eager
  timeout_profile: fast
  max_body_size_bytes: 1048576
  default_backend: rest
  backends:
    rest:
      url: "http://cotejo:8080"
      health_check:
        enabled: true
        endpoint: "/v1/health"
        method: "GET"
        expected_body: '"ok"'
        interval_seconds: 10
        timeout_seconds: 5
        unhealthy_threshold: 3
        healthy_threshold: 2
```

A check keeps itself inside a 25 s budget, so it finishes within the 30 s gateway limit under the `fast` profile.

**Starting fresh:** [`pocket/mainnet/standalone.yaml`](pocket/mainnet/standalone.yaml) is a complete standalone config (relayer and miner in one process, no Redis) with the mainnet endpoints, chain id `pocket` and the 60 s block time. Validate it, then run it on the same Docker network as the backend:

```bash
docker run --rm -v "$PWD/pocket/mainnet/standalone.yaml:/config/standalone.yaml:ro" \
  -v "$PWD/supplier-keys.yaml:/keys/supplier-keys.yaml:ro" \
  ghcr.io/pokt-network/pocket-relay-miner:v0.1.6 standalone validate --config /config/standalone.yaml
docker run -d --name relayminer --network pocket --restart unless-stopped -p 8080:8080 \
  -v "$PWD/pocket/mainnet/standalone.yaml:/config/standalone.yaml:ro" \
  -v "$PWD/supplier-keys.yaml:/keys/supplier-keys.yaml:ro" \
  -v relayminer-data:/home/pocket/.pocket-relay-miner/data \
  ghcr.io/pokt-network/pocket-relay-miner:v0.1.6 standalone --config /config/standalone.yaml
```

`supplier-keys.yaml` holds your operator key (`keys:` followed by a list of hex keys), mode 0600, owned by uid 1000. Put port 8080 behind your TLS proxy; that public URL is what goes on-chain in step 3. The project's own runbook is [DOCKER_COMPOSE_STANDALONE.md](https://github.com/pokt-network/pocket-relay-miner/blob/v0.1.6/docs/deploy/DOCKER_COMPOSE_STANDALONE.md).

The high-availability image in [`pocket/relayminer/`](pocket/relayminer/) (relayer and miner with Redis) also works: set `POCKET_NETWORK=main`, `ROLE`, `REDIS_URL`, `SUPPLIER_OPERATOR_KEY_HEX` and `BACKEND_URL`. Build it with BuildKit (`docker buildx build -f pocket/relayminer/Dockerfile .`); the legacy builder refuses its `COPY --chmod`.

## 3. Add the service to your supplier's stake

Fill in [`pocket/mainnet/services_update.yaml`](pocket/mainnet/services_update.yaml) with your owner and operator addresses, your RelayMiner's public URL, and **every service the supplier should keep serving**, not only `citation-check`. Then, signed by the operator:

```bash
pocketd tx supplier stake-supplier --config ./services_update.yaml --services-only \
  --from <operator> --network=main --gas auto --gas-prices 1upokt --gas-adjustment 1.5
```

`--services-only` leaves the stake unchanged. The new service takes effect at the start of the next session (20 blocks, about 20 minutes).

## 4. Check it

```bash
pocketd query supplier show-supplier <operator> --network=main   # citation-check is listed
curl -s https://sauron-api.infra.pocket.network/pokt-network/poktroll/service/service/citation-check
```

Paid relays start once an application is staked for `citation-check`. Questions or a test relay: open an issue on this repo.
