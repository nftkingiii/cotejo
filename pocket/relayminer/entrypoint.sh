#!/bin/sh
# Renders the config for ROLE (relayer | miner) from environment variables and
# writes the operator key file from SUPPLIER_OPERATOR_KEY_HEX. The key only
# ever lives in the Railway variable and in this container's tmpfs-backed file.
set -eu

: "${ROLE:?ROLE must be relayer or miner}"
: "${REDIS_URL:?}"
: "${SUPPLIER_OPERATOR_KEY_HEX:?set this Railway variable to the operator key (64 hex chars)}"
export POCKET_RPC_URL="${POCKET_RPC_URL:-https://sauron-rpc.beta.infra.pocket.network}"
export POCKET_GRPC_URL="${POCKET_GRPC_URL:-sauron-grpc.beta.infra.pocket.network:443}"
export POCKET_CHAIN_ID="${POCKET_CHAIN_ID:-pocket-lego-testnet}"
export BLOCK_TIME_SECONDS="${BLOCK_TIME_SECONDS:-30}"
export BACKEND_URL="${BACKEND_URL:-http://cotejo.railway.internal:8080}"

case "$ROLE" in relayer|miner) ;; *) echo "ROLE must be relayer or miner" >&2; exit 64;; esac
case "$SUPPLIER_OPERATOR_KEY_HEX" in
  *[!0-9a-fA-F]*) echo "SUPPLIER_OPERATOR_KEY_HEX must be hex" >&2; exit 64;;
esac
[ "${#SUPPLIER_OPERATOR_KEY_HEX}" -eq 64 ] || { echo "SUPPLIER_OPERATOR_KEY_HEX must be 64 hex chars" >&2; exit 64; }

umask 077
mkdir -p /keys /home/pocket/config
printf 'keys:\n  - "%s"\n' "$SUPPLIER_OPERATOR_KEY_HEX" > /keys/supplier-keys.yaml
unset SUPPLIER_OPERATOR_KEY_HEX

render() {
  sed -e "s|\${REDIS_URL}|$REDIS_URL|g" \
      -e "s|\${POCKET_RPC_URL}|$POCKET_RPC_URL|g" \
      -e "s|\${POCKET_GRPC_URL}|$POCKET_GRPC_URL|g" \
      -e "s|\${POCKET_CHAIN_ID}|$POCKET_CHAIN_ID|g" \
      -e "s|\${BLOCK_TIME_SECONDS}|$BLOCK_TIME_SECONDS|g" \
      -e "s|\${BACKEND_URL}|$BACKEND_URL|g" "$1"
}
render "/opt/cotejo/$ROLE.yaml" > "/home/pocket/config/$ROLE.yaml"

exec /sbin/tini -- pocket-relay-miner "$ROLE" --config "/home/pocket/config/$ROLE.yaml"
