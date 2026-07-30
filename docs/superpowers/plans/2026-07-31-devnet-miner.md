# Devnet miner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone CPU-throttled miner client, add bearer-token auth to the mining API, and configure the VPS for external mining behind nginx with path isolation.

**Architecture:** Standalone `miner.mjs` script (zero deps, vendored PoW solver) polls the VPS mining API, solves PoW with a configurable duty cycle, and submits nonces. The VPS node runs with `MINING_MODE=external` and `MINING_SECRET` to gate submission.

**Tech Stack:** Node.js ≥ 22, bash, nginx, systemd

## Global Constraints

- PoW solver MUST be byte-identical to `block-creator.ts:322-341` — blake2b512, LE64 nonce, leading-zero-bits check
- CPU throttling via duty cycle: work `MINER_PCT`% of each second, sleep the rest
- Mining auth: `Authorization: Bearer <secret>` header, 401 on mismatch
- Nginx path isolation: `/` → 404, `/testnet/` → demo UI, `/testnet/api/` → API
- Node.js ≥ 22 built-ins only for the miner script — no npm deps

---

### Task 1: Mining secret config + auth middleware

**Files:**
- Modify: `packages/node/src/config.ts`
- Modify: `packages/node/src/routes/mining.ts`
- Modify: `packages/node/src/server.ts:220-228`
- Modify: `packages/node/test/config.test.ts`

**Interfaces:**
- Consumes: `Config` interface, `MiningDeps` interface, `createRouter` factory
- Produces: `Config.miningSecret: string`, auth middleware on `/mining/*`

- [ ] **Step 1: Add `miningSecret` to Config interface and loadConfig**

In `packages/node/src/config.ts`, add to the `Config` interface after `miningMode`:

```typescript
  // Mining
  miningMode: 'internal' | 'external';
  miningSecret: string;          // bearer token for mining API, empty = no auth
  orderingBlockPowTargetBits: number;
```

In `loadConfig()`, add after the `miningMode` line:

```typescript
    miningMode: parseMiningMode(process.env['MINING_MODE'] ?? 'internal'),
    miningSecret: process.env['MINING_SECRET'] ?? '',
```

- [ ] **Step 2: Run typecheck to verify Config compiles**

Run: `pnpm typecheck`
Expected: clean

- [ ] **Step 3: Update config test for miningSecret**

In `packages/node/test/config.test.ts`, add `'MINING_SECRET'` to the `TEST_KEYS` array.

In the defaults test (`describe('1. defaults')`), add:

```typescript
      expect(cfg.miningSecret).toBe('');
```

In the env overrides test (`describe('2. env overrides')`), add:

```typescript
      process.env['MINING_SECRET'] = 'sekret';

      // ... in expectations:
      expect(cfg.miningSecret).toBe('sekret');
```

- [ ] **Step 4: Run config tests to verify**

Run: `npx vitest run packages/node/test/config.test.ts`
Expected: all 4 tests pass

- [ ] **Step 5: Add auth middleware to mining routes**

In `packages/node/src/routes/mining.ts`, update the `MiningDeps` interface:

```typescript
export interface MiningDeps {
  getCurrentTemplate(): OrderingBlock | null;
  submitMinedBlock(powNonce: number, height: number): string | null;
  miningSecret: string;
}
```

Add auth middleware function before `createRouter`:

```typescript
function authMiddleware(secret: string): import('express').RequestHandler {
  if (!secret) {
    // No auth configured — passthrough
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
```

In `createRouter`, extract `miningSecret` from deps and apply middleware:

```typescript
export function createRouter(deps: MiningDeps): Router {
  const router = Router();
  const { miningSecret } = deps;

  // Auth middleware on all mining routes
  router.use(authMiddleware(miningSecret));

  // GET /mining/template — return current block template
  router.get('/template', (_req, res) => {
```

- [ ] **Step 6: Run typecheck to verify mining routes compile**

Run: `pnpm typecheck`
Expected: clean

- [ ] **Step 7: Pass `miningSecret` through server.ts**

In `packages/node/src/server.ts`, update the mining route mount (line 223):

```typescript
      miningRoutes({
        getCurrentTemplate,
        submitMinedBlock,
        miningSecret: config.miningSecret,
      }),
```

- [ ] **Step 8: Run typecheck to verify server compiles**

Run: `pnpm typecheck`
Expected: clean

- [ ] **Step 9: Write mining auth tests**

Create `packages/node/test/routes/mining.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter, type MiningDeps } from '../../src/routes/mining.js';
import type { OrderingBlock } from '@dagsocial/types';

function makeDeps(overrides: Partial<MiningDeps> = {}): MiningDeps {
  return {
    getCurrentTemplate: () => null,
    submitMinedBlock: () => null,
    miningSecret: '',
    ...overrides,
  };
}

describe('mining routes', () => {
  describe('auth', () => {
    it('returns 200 from /template when no secret is configured', async () => {
      const app = express().use(createRouter(makeDeps()));
      const res = await request(app).get('/template');
      expect(res.status).toBe(404); // no template, not 401
    });

    it('returns 401 from /template when secret is set and no header sent', async () => {
      const app = express().use(createRouter(makeDeps({ miningSecret: 'sekret' })));
      const res = await request(app).get('/template');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 from /template when wrong secret is sent', async () => {
      const app = express().use(createRouter(makeDeps({ miningSecret: 'sekret' })));
      const res = await request(app)
        .get('/template')
        .set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('returns 404 from /template when correct secret is sent', async () => {
      const template = null; // no template, but auth passes
      const app = express().use(
        createRouter(makeDeps({ miningSecret: 'sekret', getCurrentTemplate: () => template })),
      );
      const res = await request(app)
        .get('/template')
        .set('Authorization', 'Bearer sekret');
      expect(res.status).toBe(404); // auth passed, no template
    });

    it('returns 401 from /submit when secret is set and no header sent', async () => {
      const app = express().use(createRouter(makeDeps({ miningSecret: 'sekret' })));
      const res = await request(app)
        .post('/submit')
        .send({ powNonce: 42, height: 1 });
      expect(res.status).toBe(401);
    });

    it('returns 201 from /submit when correct secret is sent and PoW is valid', async () => {
      const app = express().use(
        createRouter(
          makeDeps({
            miningSecret: 'sekret',
            submitMinedBlock: () => 'deadbeef',
          }),
        ),
      );
      const res = await request(app)
        .post('/submit')
        .set('Authorization', 'Bearer sekret')
        .send({ powNonce: 42, height: 1 });
      expect(res.status).toBe(201);
    });
  });
});
```

- [ ] **Step 10: Run mining auth tests**

Run: `npx vitest run packages/node/test/routes/mining.test.ts`
Expected: all 6 tests pass

- [ ] **Step 11: Run full test suite to check for regressions**

Run: `pnpm test`
Expected: all tests pass (1 known E2E flake acceptable)

- [ ] **Step 12: Commit**

```bash
git add packages/node/src/config.ts \
        packages/node/src/routes/mining.ts \
        packages/node/src/server.ts \
        packages/node/test/config.test.ts \
        packages/node/test/routes/mining.test.ts
git commit -m "feat(node): add MINING_SECRET bearer-token auth to mining API

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Standalone miner script

**Files:**
- Create: `packages/node/scripts/miner.mjs`

**Interfaces:**
- Consumes: `process.env.NODE_URL`, `process.env.MINER_PCT`, `process.env.MINING_SECRET`
- Produces: `solvePoW(preimage, targetBits)` → nonce, continuous mining loop
- External: polls `GET <NODE_URL>/mining/template`, submits to `POST <NODE_URL>/mining/submit`

- [ ] **Step 1: Create miner.mjs**

File: `packages/node/scripts/miner.mjs`

```javascript
#!/usr/bin/env node
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NODE_URL = (process.env.NODE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const MINER_PCT = Math.max(0, Math.min(100, parseInt(process.env.MINER_PCT ?? '25', 10)));
const MINING_SECRET = process.env.MINING_SECRET ?? '';
const DUTY_WINDOW_MS = 1000;

// ---------------------------------------------------------------------------
// PoW solver — byte-identical to block-creator.ts solvePoW()
// ---------------------------------------------------------------------------

function encodeLE64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function solvePoW(powPreimage, targetBits) {
  let nonce = 0;
  while (true) {
    const nonceBuf = encodeLE64(nonce);
    const hash = createHash('blake2b512')
      .update(powPreimage)
      .update(nonceBuf)
      .digest()
      .subarray(0, 32);
    let bits = 0;
    for (let i = 0; i < 32 && bits < targetBits; i++) {
      if (hash[i] === 0) { bits += 8; continue; }
      let mask = 0x80;
      while ((hash[i] & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= targetBits) return nonce;
    nonce++;
  }
}

// ---------------------------------------------------------------------------
// Throttled mining — async so we can yield the event loop between work windows
// ---------------------------------------------------------------------------

async function throttledSolvePoW(powPreimage, targetBits) {
  if (MINER_PCT === 0) {
    // No throttling — run full tilt synchronously
    return solvePoW(powPreimage, targetBits);
  }

  const workMs = DUTY_WINDOW_MS * MINER_PCT / 100;
  const sleepMs = DUTY_WINDOW_MS - workMs;
  let nonce = 0;

  while (true) {
    const deadline = Date.now() + workMs;

    // Work window: tight loop until deadline or solution
    while (Date.now() < deadline) {
      const nonceBuf = encodeLE64(nonce);
      const hash = createHash('blake2b512')
        .update(powPreimage)
        .update(nonceBuf)
        .digest()
        .subarray(0, 32);
      let bits = 0;
      for (let i = 0; i < 32 && bits < targetBits; i++) {
        if (hash[i] === 0) { bits += 8; continue; }
        let mask = 0x80;
        while ((hash[i] & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
        break;
      }
      if (bits >= targetBits) return nonce;
      nonce++;
    }

    // Yield event loop — other processes get the CPU during sleepMs
    await sleep(sleepMs);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const headers = {
  'Content-Type': 'application/json',
  ...(MINING_SECRET ? { 'Authorization': `Bearer ${MINING_SECRET}` } : {}),
};

async function fetchTemplate() {
  const res = await fetch(`${NODE_URL}/mining/template`, { headers });
  if (res.status === 401) {
    throw new Error('Mining API returned 401 — check MINING_SECRET');
  }
  if (res.status === 404) {
    return null; // no template available yet
  }
  if (!res.ok) {
    throw new Error(`Template fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function submitNonce(powNonce, height) {
  const res = await fetch(`${NODE_URL}/mining/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ powNonce, height }),
  });
  if (res.status === 401) {
    throw new Error('Mining API returned 401 — check MINING_SECRET');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Mining loop
// ---------------------------------------------------------------------------

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  log(`Miner starting — node=${NODE_URL} cpu=${MINER_PCT}%`);

  let backoff = 5000;

  while (true) {
    try {
      const tpl = await fetchTemplate();

      if (!tpl) {
        log('No template available, waiting 5s...');
        await sleep(5000);
        continue;
      }

      const { powPreimage, powTargetBits, header } = tpl;
      const preimageBuf = Buffer.from(powPreimage, 'hex');

      log(`Mining block ${header.height} at ${powTargetBits} bits...`);
      const start = Date.now();

      const nonce = await throttledSolvePoW(preimageBuf, powTargetBits);

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`Found nonce=${nonce} for height=${header.height} in ${elapsed}s`);

      const res = await submitNonce(nonce, header.height);

      if (res.status === 201) {
        const body = await res.json();
        log(`Block accepted: ${body.blockHash} height=${body.height}`);
        backoff = 5000; // reset on success
      } else if (res.status === 422) {
        log('Block rejected (stale or invalid PoW), repolling immediately');
        backoff = 1000;
      } else {
        log(`Unexpected submit response: ${res.status}`);
        backoff = 5000;
      }
    } catch (err) {
      log(`Error: ${err.message}`);
      backoff = Math.min(backoff * 2, 30000);
      log(`Retrying in ${backoff / 1000}s...`);
      await sleep(backoff);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
```

- [ ] **Step 2: Verify miner script parses without syntax errors**

Run: `node --check packages/node/scripts/miner.mjs`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add packages/node/scripts/miner.mjs
git commit -m "feat(node): add standalone CPU-throttled miner script

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Reference systemd unit

**Files:**
- Create: `packages/node/scripts/dagsocial-miner.service`

**Interfaces:**
- Produces: systemd service unit for the laptop miner

- [ ] **Step 1: Create service file**

File: `packages/node/scripts/dagsocial-miner.service`

```ini
[Unit]
Description=DAGsocial miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="NODE_URL=https://notis.blockhost.io/testnet"
Environment="MINER_PCT=25"
Environment="MINING_SECRET=letmetest"
ExecStart=/usr/bin/node /opt/dagsocial-miner/miner.mjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add packages/node/scripts/dagsocial-miner.service
git commit -m "feat(node): add reference systemd unit for devnet miner

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## VPS Deployment

These steps are manual — SSH into `linuxuser@blockhost.io` and apply.

### 1. Node environment file

Create `/etc/dagsocial/node.env`:

```sh
NODE_ROLE=miner
MINING_MODE=external
MINING_SECRET=letmetest
PORT=3000
ADMIN_PORT=3001
ADMIN_BIND_ADDRESS=127.0.0.1
DB_PATH=/var/lib/dagsocial/dagsocial.db
NETWORK_MODE=testnet
```

### 2. Node systemd unit

Create `/etc/systemd/system/dagsocial-node.service`:

```ini
[Unit]
Description=DAGsocial node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/dagsocial/node.env
WorkingDirectory=/opt/dagsocial
ExecStart=/usr/bin/node /opt/dagsocial/packages/node/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 3. Nginx site config

Modify the existing `notis.blockhost.io` server block:

```nginx
server {
    listen 443 ssl;
    server_name notis.blockhost.io;

    ssl_certificate     /etc/letsencrypt/live/notis.blockhost.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notis.blockhost.io/privkey.pem;

    # Root: 404 for scanners
    location = / {
        return 404;
    }

    # Demo UI
    location /testnet/ {
        root /opt/dagsocial/packages/node/public;
        try_files $uri $uri/ /testnet/index.html;
    }

    # API + mining
    location /testnet/api/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Everything else: 404
    location / {
        return 404;
    }
}
```

Note: `proxy_pass http://127.0.0.1:3000/;` has a trailing slash — nginx strips the `/testnet/api/` prefix, so `/testnet/api/mining/template` reaches Express as `/mining/template`.

### 4. Deploy

```bash
# On the VPS
sudo cp /etc/systemd/system/dagsocial-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dagsocial-node
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Deploy miner on laptop

```bash
# On the laptop
sudo mkdir -p /opt/dagsocial-miner
sudo cp packages/node/scripts/miner.mjs /opt/dagsocial-miner/
sudo cp packages/node/scripts/dagsocial-miner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dagsocial-miner
sudo journalctl -u dagsocial-miner -f  # watch logs
```
