# Devnet miner — design

**Date:** 2026-07-31
**Status:** design

## Overview

Launch a single-node devnet where the VPS (blockhost.io) runs the DAGsocial
node without PoW computation, and the laptop mines ordering blocks with CPU
throttling. The mining API is open enough that other participants can point
miners at it later.

```
laptop (miner)                        VPS (notis.blockhost.io)
──────────────                        ─────────────────────────
systemd: node miner.mjs               NODE_ROLE=miner
                                      MINING_MODE=external
poll /testnet/mining/template ──────► nginx:443 → :3000
solvePoW (25% duty cycle)             assembles template
                                      waits for submission
POST /testnet/mining/submit ────────► verify PoW, sign, finalize
  Authorization: Bearer letmetest      broadcast to peers
```

## 1. Miner client

Single file, lives in the repo at `packages/node/scripts/miner.mjs`. Zero
dependencies, Node.js ≥ 22 built-ins. Deployed to the laptop at
`/opt/dagsocial-miner/miner.mjs`.

### 1.1 PoW solver

Vendored copy of `solvePoW()` from `block-creator.ts:322-341`. Same blake2b512,
same leading-zero-bits loop, same LE64 nonce encoding. The VPS verifier
(`verifyOrderingBlockPoW`) validates it — a mismatch is a rejected block
(submit returns 422), not a consensus hazard.

### 1.2 Mining loop

Polls `GET <node_url>/mining/template`, extracts `powPreimage` and
`powTargetBits`, feeds them to the throttled solver, submits nonce to
`POST <node_url>/mining/submit`.

| Response | Meaning | Action |
|---|---|---|
| 200 (template) | Template available | Mine it |
| 404 | No template yet | Retry after 5s |
| 201 (submit) | Block accepted | Log + return to idle, poll for next template |
| 422 (submit) | Stale or invalid | Repoll immediately |
| Error / ECONNREFUSED | VPS unreachable | Exponential backoff 5s → max 30s |

### 1.3 Configuration

Three env vars:

| Var | Default | Purpose |
|---|---|---|
| `NODE_URL` | `http://localhost:3000` | Base URL of the node |
| `MINER_PCT` | `25` | CPU duty cycle percentage (0-100) |
| `MINING_SECRET` | (empty) | Bearer token for mining API auth |

## 2. CPU throttling

Duty-cycle based. Per-second measurement window:

- `work_ms = DUTY_WINDOW_MS * MINER_PCT / 100`
- `sleep_ms = DUTY_WINDOW_MS - work_ms`

Within the work window the solver runs flat-out (tight loop, no internal
yields). When the window elapses, the process sleeps for `sleep_ms`, then
starts the next window. A window may overshoot by a few hash iterations
(mid-hash at boundary); negligible at realistic rates.

`MINER_PCT=0` means "no throttling" — the solver runs at full speed.

`DUTY_WINDOW_MS` defaults to 1000 (1 second) and is not exposed as a config
var. The 1s window keeps the duty cycle accurate without micro-scheduling
overhead.

## 3. VPS: node configuration

Node env vars:

```
NODE_ROLE=miner
MINING_MODE=external
MINING_SECRET=letmetest
```

`NODE_ROLE=miner` is required because the mining routes only mount when the
node is a miner (`server.ts:220-228`). `MINING_MODE=external` skips the
internal `solvePoW()` call — the node builds templates, stores them, and
waits for external submissions.

## 4. Mining API auth

When `MINING_SECRET` is set, the mining router requires
`Authorization: Bearer <secret>` on both `/mining/template` and
`/mining/submit`. Missing or mismatched header returns 401.

The miner client reads `MINING_SECRET` from env and attaches the header to
all requests.

Default is empty (no auth) — existing behavior preserved for local
development.

Implementation: middleware in `routes/mining.ts`. Config field added to
`config.ts`.

## 5. Path isolation (nginx)

- `notis.blockhost.io/` → 404
- `notis.blockhost.io/testnet/` → demo UI (static files)
- `notis.blockhost.io/testnet/api/` → Express API + mining routes
- Everything else → 404

Pure nginx config — Express stays at root, nginx strips the `/testnet`
prefix via `proxy_pass http://127.0.0.1:3000/;` (trailing slash). No
`ROUTE_PREFIX` env var in the node.

The miner client's `NODE_URL` points at the full path:
`https://notis.blockhost.io/testnet`.

## 6. systemd unit (laptop)

```
[Unit]
Description=DAGsocial miner

[Service]
Environment="NODE_URL=https://notis.blockhost.io/testnet"
Environment="MINER_PCT=25"
Environment="MINING_SECRET=letmetest"
ExecStart=/usr/bin/node /opt/dagsocial-miner/miner.mjs
Restart=always
RestartSec=5
```

`/opt/dagsocial-miner/miner.mjs` is the single script file.

## 7. What is NOT in scope

- Multiple VPS nodes / multi-miner coordination. Single-node devnet.
- IP allowlisting or advanced auth. Single shared secret is sufficient for
  devnet.
- Configurable `DUTY_WINDOW_MS`. Hardcoded at 1s.
- HTTPS on the laptop side (nginx terminates TLS on the VPS).
- Any change to the on-chain protocol, consensus rules, or block format.
