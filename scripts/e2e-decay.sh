#!/usr/bin/env bash
# E2E: two miners, fast blocks, fast decay
# Usage: bash scripts/e2e-decay.sh
# Ctrl+C to stop.

set -euo pipefail

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
say() { echo -e "${G}[e2e]${N} $*"; }
warn() { echo -e "${Y}[warn]${N} $*"; }

P1=3001; P2=3002
D1=$(mktemp -d /tmp/dagsocial-e2e-n1-XXXXXX)
D2=$(mktemp -d /tmp/dagsocial-e2e-n2-XXXXXX)
A1="http://localhost:$P1"; A2="http://localhost:$P2"

export ORDERING_BLOCK_INTERVAL_MS=3000
export KARMA_STALE_THRESHOLD_BLOCKS=15
export KARMA_DECAY_INTERVAL_BLOCKS=5
export KARMA_DECAY_AMOUNT=5
export KARMA_MINIMUM=10

cleanup() { kill %1 %2 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$D1" "$D2"; }
trap cleanup EXIT

say "Building..."
pnpm build --silent 2>&1 | tail -1

say "Starting Node 1 on :$P1..."
DB_PATH="$D1/db.sqlite" PORT=$P1 NODE_ROLE=miner \
  LISTEN_ADDRS="/ip4/0.0.0.0/tcp/$((P1 + 100))" \
  node packages/node/dist/index.js > "$D1/log.txt" 2>&1 &

for i in $(seq 1 60); do
  PEER1=$(grep -o 'peer ID: [a-zA-Z0-9]\+' "$D1/log.txt" 2>/dev/null | tail -1 | awk '{print $3}') || true
  [ -n "${PEER1:-}" ] && break; sleep 1
done
say "  N1 peer: $PEER1"

say "Starting Node 2 on :$P2..."
BOOTSTRAP="/ip4/127.0.0.1/tcp/$((P1 + 100))/p2p/$PEER1"
DB_PATH="$D2/db.sqlite" PORT=$P2 NODE_ROLE=miner \
  LISTEN_ADDRS="/ip4/0.0.0.0/tcp/$((P2 + 100))" \
  BOOTSTRAP_PEERS="$BOOTSTRAP" \
  node packages/node/dist/index.js > "$D2/log.txt" 2>&1 &

for i in $(seq 1 60); do
  curl -s "$A1/status" >/dev/null 2>&1 && curl -s "$A2/status" >/dev/null 2>&1 && break
  sleep 1
done
say "Both nodes up"

# ---- Phase 1: Create identities ----
say ""
say "=== Phase 1: Identities ==="

U1=$(curl -s -X POST "$A1/identity" -H 'Content-Type: application/json' -d '{}' | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).userId")
say "N1 user: ${U1:0:16}..."
U2=$(curl -s -X POST "$A2/identity" -H 'Content-Type: application/json' -d '{}' | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).userId")
say "N2 user: ${U2:0:16}..."

say "Waiting for identity blocks to mine..."
sleep 10  # 3 blocks minimum

# ---- Phase 2: Faucet ----
say ""
say "=== Phase 2: Faucet ==="

FR=$(curl -s -X POST "$A1/faucet" -H 'Content-Type: application/json' -d "{\"userId\":\"$U1\"}")
TXID=$(echo "$FR" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).txId" 2>/dev/null || echo "")
if [ -n "$TXID" ]; then
  say "Faucet tx submitted: ${TXID:0:16}..."
else
  warn "Faucet response: $FR"
fi

say "Waiting for faucet tx to be mined..."
sleep 10

# Check karma
check_karma() {
  local node=$1 user=$2
  local r=$(curl -s "$node/karma/$user" 2>/dev/null || echo '{}')
  node -p "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); (d.total||0) + ' (boxes: ' + (d.boxes?d.boxes.length:0) + ')'" <<< "$r" 2>/dev/null || echo "?"
}

K1=$(check_karma "$A1" "$U1")
say "N1 karma after faucet: $K1"
K2=$(check_karma "$A2" "$U1")
say "N2 karma for same user: $K2"

# ---- Phase 3: Interactive period ----
say ""
say "=== Phase 3: Interactive testing ==="
say "Open these in browser to create posts, likes, invites:"
say "  ${G}http://localhost:$P1${N}"
say "  ${G}http://localhost:$P2${N}"
say ""
say "Then stop activity and watch decay in the live monitor."
say "Starting monitor in 5s..."
sleep 5

# ---- Phase 4: Live monitor ----
say ""
say "=== Phase 4: Live Monitor ==="
say "Watching heights, karma, decay events, fork detection"
say ""

prev_k1=0
prev_msg=""
while true; do
  H1=$(curl -s "$A1/status" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).currentHeight" 2>/dev/null || echo "?")
  H2=$(curl -s "$A2/status" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).currentHeight" 2>/dev/null || echo "?")
  K1=$(curl -s "$A1/karma/$U1" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).total" 2>/dev/null || echo "0")
  K2=$(curl -s "$A2/karma/$U1" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).total" 2>/dev/null || echo "0")

  flags=""
  if [ "$K1" != "0" ] && [ "$prev_k1" != "0" ] && [ "$K1" -lt "$prev_k1" ] 2>/dev/null; then
    flags="${flags} ${Y}DECAY:${prev_k1}->${K1}${N}"
  fi
  prev_k1=$K1

  if grep -qi "fork\|heavier\|reorg" "$D1/log.txt" 2>/dev/null; then
    local_hits=$(grep -ci "fork\|heavier\|reorg" "$D1/log.txt" 2>/dev/null || echo "0")
    flags="${flags} ${R}FORK(N1:${local_hits})${N}"
  fi
  if grep -qi "fork\|heavier\|reorg" "$D2/log.txt" 2>/dev/null; then
    local_hits2=$(grep -ci "fork\|heavier\|reorg" "$D2/log.txt" 2>/dev/null || echo "0")
    flags="${flags} ${R}FORK(N2:${local_hits2})${N}"
  fi

  printf "\r  N1 H=%-4s K=%-5s  N2 H=%-4s K=%-5s %s  " "$H1" "$K1" "$H2" "$K2" "$flags"

  sleep 3
done
