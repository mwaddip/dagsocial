#!/usr/bin/env bash
# =============================================================================
# cluster.sh — Start N DAGsocial miner nodes for local testing
# =============================================================================
# Usage:
#   ./scripts/cluster.sh [num_nodes] [--persist] [--interval-ms <ms>]
#
#   num_nodes     Number of nodes (default: 3)
#   --persist     Keep DBs between runs (default: fresh DBs each start)
#   --interval-ms Block creation interval in ms (default: 60000 = 1 minute)
#   --base-http   Starting HTTP port (default: 3100)
#   --base-p2p    Starting libp2p port (default: 9876)
#
# Examples:
#   ./scripts/cluster.sh                    # 3 nodes, fresh DBs, 60s blocks
#   ./scripts/cluster.sh 5                  # 5 nodes
#   ./scripts/cluster.sh 3 --interval-ms 30000  # 3 nodes, 30s blocks
#   ./scripts/cluster.sh 4 --persist        # 4 nodes, keep DBs
#
# Node 1 is the bootstrap seed. All other nodes connect to it.
# Each node runs as a miner on testnet with its own HTTP port, libp2p port,
# and SQLite database.
# =============================================================================

set -e

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

N=3
PERSIST=false
INTERVAL_MS=60000
HTTP_BASE=3100
LIBP2P_BASE=9876

while [[ $# -gt 0 ]]; do
  case "$1" in
    --persist)
      PERSIST=true
      shift
      ;;
    --interval-ms)
      INTERVAL_MS="$2"
      shift 2
      ;;
    --base-http)
      HTTP_BASE="$2"
      shift 2
      ;;
    --base-p2p)
      LIBP2P_BASE="$2"
      shift 2
      ;;
    --help|-h)
      head -30 "$0" | grep -A100 '^#!/' | tail -n +3
      exit 0
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        N="$1"
        shift
      else
        echo "Unknown argument: $1"
        echo "Usage: $0 [num_nodes] [--persist] [--interval-ms <ms>]"
        exit 1
      fi
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="/tmp/dagsocial-cluster"
RUNFILE="/tmp/dagsocial-cluster/pids"

mkdir -p "$LOG_DIR"

# Kill any previous cluster
if [ -f "$RUNFILE" ]; then
  echo "=== Stopping previous cluster ==="
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$RUNFILE"
  rm -f "$RUNFILE"
  sleep 1
fi

# Build if needed
if [ ! -f "$ROOT_DIR/packages/node/dist/index.js" ]; then
  echo "=== Building ==="
  cd "$ROOT_DIR" && pnpm build
fi

# ---------------------------------------------------------------------------
# Launch nodes
# ---------------------------------------------------------------------------

echo "=== DAGsocial Cluster: $N miner node(s) ==="
echo "  HTTP ports:      $HTTP_BASE – $((HTTP_BASE + N - 1))"
echo "  libp2p ports:    $LIBP2P_BASE – $((LIBP2P_BASE + N - 1))"
echo "  Block interval:  ${INTERVAL_MS}ms ($((INTERVAL_MS / 1000))s)"
echo "  Persist DBs:     $PERSIST"
echo "  Logs:            $LOG_DIR/node-*.log"
echo ""

BOOTSTRAP_ADDR="/ip4/127.0.0.1/tcp/$LIBP2P_BASE"
> "$RUNFILE"  # truncate

for i in $(seq 1 "$N"); do
  PORT=$((HTTP_BASE + i - 1))
  LIBP2P=$((LIBP2P_BASE + i - 1))
  DB="$LOG_DIR/node-$i.db"
  LOG="$LOG_DIR/node-$i.log"

  # Fresh DB unless --persist
  if [ "$PERSIST" = false ]; then
    rm -f "$DB" "$DB-wal" "$DB-shm"
  fi

  if [ "$i" -eq 1 ]; then
    BOOTSTRAP=""
    LABEL="bootstrap"
  else
    BOOTSTRAP="$BOOTSTRAP_ADDR"
    LABEL="peer"
  fi

  echo -n "  Node $i ($LABEL): HTTP :$PORT, libp2p :$LIBP2P ... "

  cd "$ROOT_DIR"
  ORDERING_BLOCK_INTERVAL_MS="$INTERVAL_MS" \
  NODE_ROLE=miner \
  NETWORK_MODE=testnet \
  PORT="$PORT" \
  DB_PATH="$DB" \
  LISTEN_ADDRS="/ip4/127.0.0.1/tcp/$LIBP2P" \
  BOOTSTRAP_PEERS="$BOOTSTRAP" \
  node packages/node/dist/index.js > "$LOG" 2>&1 &

  PID=$!
  echo "$PID" >> "$RUNFILE"
  echo "PID $PID"

  # Bootstrap needs a moment before peers dial it
  if [ "$i" -eq 1 ]; then
    echo "  Waiting for bootstrap to come up..."
    # Poll until HTTP responds or timeout
    for _ in $(seq 1 20); do
      if curl -s "http://127.0.0.1:$PORT/status" > /dev/null 2>&1; then
        echo "  Bootstrap ready."
        break
      fi
      sleep 1
    done
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Cluster running: $N node(s) ==="
echo "  Bootstrap UI:  http://localhost:$HTTP_BASE"
if [ "$N" -ge 2 ]; then
  echo "  Peer 2 UI:     http://localhost:$((HTTP_BASE + 1))"
fi
echo "  PIDs saved to:  $RUNFILE"
echo ""
echo "  Tail all logs:  tail -f $LOG_DIR/node-*.log"
echo "  Stop cluster:   kill \$(cat $RUNFILE)"
echo "  Status check:   curl -s http://localhost:$HTTP_BASE/status | jq ."
echo ""
