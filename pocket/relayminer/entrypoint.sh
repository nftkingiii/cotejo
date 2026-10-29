#!/bin/sh
# Renders the config for ROLE (relayer | miner) from environment variables and
# writes the operator key file from SUPPLIER_OPERATOR_KEY_HEX. The key only
# ever lives in the Railway variable and in this container's tmpfs-backed file.
set -eu

: "${ROLE:?ROLE must be relayer or miner}"
: "${REDIS_URL:?}"
: "${SUPPLIER_OPERATOR_KEY_HEX:?set this Railway variable to the operator key (64 hex chars)}"
# POCKET_NETWORK picks the endpoint, chain id and block time defaults; each can still be set on its own.
case "${POCKET_NETWORK:-beta}" in
  beta) d_rpc=https://sauron-rpc.beta.infra.pocket.network d_grpc=sauron-grpc.beta.infra.pocket.network:443 d_chain=pocket-lego-testnet d_block=30 ;;
  main) d_rpc=https://sauron-rpc.infra.pocket.network d_grpc=sauron-grpc.infra.pocket.network:443 d_chain=pocket d_block=60 ;;
  *) echo "POCKET_NETWORK must be beta or main" >&2; exit 64 ;;
esac
export POCKET_RPC_URL="${POCKET_RPC_URL:-$d_rpc}"
export POCKET_GRPC_URL="${POCKET_GRPC_URL:-$d_grpc}"
export POCKET_CHAIN_ID="${POCKET_CHAIN_ID:-$d_chain}"
export BLOCK_TIME_SECONDS="${BLOCK_TIME_SECONDS:-$d_block}"
export BACKEND_URL="${BACKEND_URL:-http://cotejo.railway.internal:8080}"

case "$ROLE" in relayer|miner) ;; *) echo "ROLE must be relayer or miner" >&2; exit 64;; esac
# Tolerate whitespace, CRLF and a 0x prefix from pasting or piping.
SUPPLIER_OPERATOR_KEY_HEX=$(printf %s "$SUPPLIER_OPERATOR_KEY_HEX" | tr -d '[:space:]')
SUPPLIER_OPERATOR_KEY_HEX=${SUPPLIER_OPERATOR_KEY_HEX#0x}
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
