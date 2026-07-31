#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-deb.sh — package dagsocial-node as a .deb
#
# Requires: node (>=22), pnpm, dpkg-deb, rsync
# Output:   dagsocial-node_<version>_amd64.deb in the repo root
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
PKG="dagsocial-node"
DEB="${PKG}_${VERSION}_amd64.deb"
STAGING=$(mktemp -d)
APP_DIR="$STAGING/opt/dagsocial"

echo "==> Building $DEB"

# ---------------------------------------------------------------------------
# 1. Build all workspace packages
# ---------------------------------------------------------------------------
echo "==> Building workspace packages..."
pnpm build

# ---------------------------------------------------------------------------
# 2. Create staging directory tree
# ---------------------------------------------------------------------------
echo "==> Assembling staging tree in $STAGING"
mkdir -p "$APP_DIR"
mkdir -p "$STAGING/etc/dagsocial"
mkdir -p "$STAGING/usr/lib/systemd/system"
mkdir -p "$STAGING/DEBIAN"

# ---------------------------------------------------------------------------
# 3. Copy project files (exclude git, node_modules, temp files)
# ---------------------------------------------------------------------------
rsync -a \
  --exclude '.git' \
  --exclude '.github' \
  --exclude '.claude' \
  --exclude 'node_modules' \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude '*.deb' \
  --exclude 'prompts' \
  --exclude 'CLAUDE.md' \
  --exclude 'SESSION_CONTEXT.md' \
  --exclude 'dagsocial.md' \
  --exclude 'HOW_IT_WORKS.md' \
  --exclude 'docs/superpowers' \
  --exclude 'scripts/build-deb.sh' \
  "$REPO_ROOT/" "$APP_DIR/"

# ---------------------------------------------------------------------------
# 4. Install production dependencies only
# ---------------------------------------------------------------------------
echo "==> Installing production dependencies..."
cd "$APP_DIR"
pnpm install --prod --frozen-lockfile 2>&1 | tail -5
pnpm rebuild 2>&1 | tail -3

# pnpm workspaces link local packages via symlinks — ensure they resolve
for pkg in types validation wire net node; do
  if [ -d "$APP_DIR/packages/$pkg/dist" ]; then
    echo "  ✓ packages/$pkg"
  else
    echo "  ✗ packages/$pkg missing dist/ — build may have failed"
    exit 1
  fi
done

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 5. Systemd unit
# ---------------------------------------------------------------------------
cp "$REPO_ROOT/packages/node/scripts/dagsocial-node.service" \
   "$STAGING/usr/lib/systemd/system/dagsocial-node.service"

# ---------------------------------------------------------------------------
# 6. Default environment file
# ---------------------------------------------------------------------------
cat > "$STAGING/etc/dagsocial/node.env" <<'ENVEOF'
# DAGsocial node environment — edit after install
NODE_ROLE=server
MINING_MODE=internal
MINING_SECRET=
PORT=3000
ADMIN_PORT=3001
ADMIN_BIND_ADDRESS=127.0.0.1
DB_PATH=/var/lib/dagsocial/dagsocial.db
NETWORK_MODE=testnet
LISTEN_ADDRS=/ip4/0.0.0.0/tcp/9733
ENVEOF

# ---------------------------------------------------------------------------
# 7. DEBIAN control files
# ---------------------------------------------------------------------------

# control
cat > "$STAGING/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: net
Priority: optional
Architecture: amd64
Depends: nodejs (>= 22)
Maintainer: DAGsocial
Description: DAGsocial node — decentralized social network
 DAGsocial is a decentralized social network with a prunable content DAG
 and a UTXO-based karma/credit ledger. This package provides the node
 daemon (Express API, libp2p networking, SQLite store, AVL+ state proofs).
EOF

# postinst
cat > "$STAGING/DEBIAN/postinst" <<'POSTINST'
#!/bin/bash
set -e

# Create data directory
mkdir -p /var/lib/dagsocial
chown -R root:root /var/lib/dagsocial

# Enable and start the service if this is an install (not upgrade)
if [ "$1" = "configure" ] && [ -z "${2:-}" ]; then
  systemctl daemon-reload
  systemctl enable dagsocial-node
  systemctl start dagsocial-node || true
  echo "dagsocial-node installed and started."
  echo "Edit /etc/dagsocial/node.env to configure, then: systemctl restart dagsocial-node"
fi

exit 0
POSTINST
chmod 755 "$STAGING/DEBIAN/postinst"

# prerm
cat > "$STAGING/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  systemctl stop dagsocial-node 2>/dev/null || true
  systemctl disable dagsocial-node 2>/dev/null || true
fi
exit 0
PRERM
chmod 755 "$STAGING/DEBIAN/prerm"

# ---------------------------------------------------------------------------
# 8. Build the .deb
# ---------------------------------------------------------------------------
echo "==> Building .deb package..."
dpkg-deb --root-owner-group --build "$STAGING" "$REPO_ROOT/$DEB"

# ---------------------------------------------------------------------------
# 9. Cleanup
# ---------------------------------------------------------------------------
rm -rf "$STAGING"

echo "==> Done: $DEB"
du -h "$REPO_ROOT/$DEB"
