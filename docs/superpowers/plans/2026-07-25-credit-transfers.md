# Credit Transfers & Faucet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add credit transfer API, faucet endpoint, and demo UI so miners can send their coinbase credits to other users.

**Architecture:** New `sendCredits()` service in `credits.ts` builds Bitcoin-style UTXO transfers (select unlocked boxes, produce recipient + change outputs, verify Ed25519 sig). New `getUnlockedCreditBoxes` store query filters out locked boxes. `POST /credits/transfer` and `POST /credits/faucet` (testnet-only) routes. `GET /credits/:userId` updated to multi-box format matching karma.

**Tech Stack:** TypeScript, Express, better-sqlite3, Ed25519 signatures, CBOR (cbor-x)

## Global Constraints

- Node.js ≥ 22 — `createHash('blake2b512').subarray(0, 32)` for all 32-byte hashes
- Secret keys never in API responses or DTOs
- Protocol version on every transaction (`PROTOCOL_VERSION = 1`)
- Face-value conservation enforced by UTXO engine (CreditBox inputs == CreditBox outputs)
- Locked credits (`lockedUntilBlock > currentHeight`) are unspendable
- Faucet active only when `config.networkMode === 'testnet'`
- ESM project (`"type": "module"`) — no `require()`, use `import` everywhere
- No circular dependencies exist in the import graph for these changes

---

### Task 1: Store — `getUnlockedCreditBoxes` query

**Files:**
- Modify: `packages/node/src/store/utxo.ts`
- Modify: `packages/node/src/store/index.ts`
- Modify: `packages/node/test/store/utxo.test.ts`

**Interfaces:**
- Produces: `getUnlockedCreditBoxes(owner: Uint8Array, blockHeight: number): CreditBox[]`

- [ ] **Step 1: Add `getUnlockedCreditBoxes` function to store/utxo.ts**

After the `getCreditBoxes` function (after line 279), add:

```typescript
/**
 * Return all unspent credit boxes for the given owner whose lockedUntilBlock
 * has passed (or is unset), sorted by value descending. Excludes boxes that
 * are still locked at the given block height.
 */
export function getUnlockedCreditBoxes(
  owner: Uint8Array,
  blockHeight: number,
): CreditBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
         AND (json_extract(extra_data, '$.lockedUntilBlock') IS NULL
              OR json_extract(extra_data, '$.lockedUntilBlock') <= ?)
       ORDER BY value DESC`,
    )
    .all(Buffer.from(owner), blockHeight) as UtxoRow[];
  return rows.map(rowToBox) as CreditBox[];
}
```

- [ ] **Step 2: Export from store/index.ts**

After the `getCreditBoxes` export line (line 26), add:

```typescript
  getUnlockedCreditBoxes,
```

- [ ] **Step 3: Add store tests**

In `packages/node/test/store/utxo.test.ts`, after the last test in that file, add inside the `describe` block:

```typescript
  // --- getUnlockedCreditBoxes filters out locked boxes ------------------------

  it('getUnlockedCreditBoxes excludes locked boxes', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnlockedCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const currentHeight = 100;

    const box1 = makeCreditBox({ value: 300, owner, proofSource: 1 });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeCreditBox({ value: 500, owner, proofSource: 2 });
    box2.lockedUntilBlock = 150;
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const box3 = makeCreditBox({ value: 200, owner, proofSource: 3 });
    box3.lockedUntilBlock = 50;
    box3.id = computeBoxId(box3);
    insertBox(box3);

    const box4 = makeCreditBox({ value: 100, owner, proofSource: 4 });
    box4.id = computeBoxId(box4);
    insertBox(box4);

    const results = getUnlockedCreditBoxes(owner, currentHeight);
    expect(results).toHaveLength(3);
    expect(results[0]!.value).toBe(300);
    expect(results[1]!.value).toBe(200);
    expect(results[2]!.value).toBe(100);
  });

  it('getUnlockedCreditBoxes returns empty array when all boxes are locked', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnlockedCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box = makeCreditBox({ value: 500, owner, proofSource: 2 });
    box.lockedUntilBlock = 200;
    box.id = computeBoxId(box);
    insertBox(box);

    const results = getUnlockedCreditBoxes(owner, 100);
    expect(results).toEqual([]);
  });

  it('getUnlockedCreditBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getUnlockedCreditBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getUnlockedCreditBoxes(bytes(32), 100);
    expect(results).toEqual([]);
  });
```

- [ ] **Step 4: Run store tests**

```bash
pnpm --filter @dagsocial/node vitest run test/store/utxo.test.ts
```
Expected: new tests pass (3 new), all existing store tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/store/utxo.ts packages/node/src/store/index.ts packages/node/test/store/utxo.test.ts
git commit -m "feat(store): add getUnlockedCreditBoxes query"
```

---

### Task 2: Service — `sendCredits()` function

**Files:**
- Modify: `packages/node/src/services/credits.ts`
- Create: `packages/node/test/services/credits.test.ts`

**Interfaces:**
- Consumes: `getUnlockedCreditBoxes` from store, `selectBoxes` and `computeTxId` from types
- Produces: `sendCredits(from, to, amount, signature, currentHeight): CreditTransferResult`
- Produces: `CreditTransferResult` type (exported)

- [ ] **Step 1: Add `sendCredits()` to services/credits.ts**

Replace the entire file with:

```typescript
import {
  computeBoxId,
  computeTxId,
  selectBoxes,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  getCreditBoxes,
  getUnlockedCreditBoxes,
  insertBox,
  consumeBox,
} from '../store/index.js';

// Ed25519 SPKI DER prefix — prepended to raw 32-byte public key for createPublicKey
const ED25519_SPKI_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);

function publicKeyToKeyObject(pubKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKey)]),
    format: 'der',
    type: 'spki',
  });
}

// ---------------------------------------------------------------------------
// Mint (coinbase emission)
// ---------------------------------------------------------------------------

/**
 * Mint (or increase) credits for a given owner.
 *
 * Consumes ALL existing unspent credit boxes and creates a single new one
 * with the combined value + amount. Same pattern as mintKarma.
 */
export function mintCredits(
  owner: Uint8Array,
  amount: number,
  blockHeight: number,
  lockedUntilBlock?: number,
): string {
  if (amount <= 0) return '';

  const existingBoxes = getCreditBoxes(owner);
  const existingTotal = existingBoxes.reduce((sum, b) => sum + b.value, 0);
  const newValue = existingTotal + amount;

  for (const box of existingBoxes) {
    if (box.id) consumeBox(box.id, blockHeight);
  }

  let mergedLockedUntilBlock = lockedUntilBlock;
  for (const box of existingBoxes) {
    if (box.lockedUntilBlock !== undefined) {
      mergedLockedUntilBlock = Math.max(
        mergedLockedUntilBlock ?? 0,
        box.lockedUntilBlock,
      );
    }
  }

  const newBox: CreditBox = {
    boxType: 'credit',
    value: newValue,
    createdAtBlock: blockHeight,
    owner,
    guard: 'owner_signature',
    proofSource: blockHeight,
  };
  if (mergedLockedUntilBlock !== undefined) {
    newBox.lockedUntilBlock = mergedLockedUntilBlock;
  }
  newBox.id = computeBoxId(newBox);

  insertBox(newBox);
  return newBox.id!;
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface CreditTransferResult {
  txId: string;
  sent: number;
  change: number;
  boxesConsumed: number;
}

/**
 * Transfer credits from one identity to another. Bitcoin-style UTXO selection:
 * largest-first from unlocked boxes, remainder back as change.
 *
 * Verifies the provided Ed25519 signature over the transaction ID against the
 * sender's public key. Throws on insufficient balance or bad signature.
 */
export function sendCredits(
  from: Uint8Array,
  to: Uint8Array,
  amount: number,
  signature: Uint8Array,
  currentHeight: number,
): CreditTransferResult {
  if (amount <= 0) {
    throw new Error('amount must be positive');
  }

  // 1. Select unlocked boxes
  const unlocked = getUnlockedCreditBoxes(from, currentHeight);
  const selected = selectBoxes(unlocked, amount);
  const totalSelected = selected.reduce((sum, b) => sum + b.value, 0);
  const change = totalSelected - amount;

  // 2. Build outputs
  const outputs: CreditBox[] = [];

  const recipientBox: CreditBox = {
    boxType: 'credit',
    value: amount,
    createdAtBlock: currentHeight,
    owner: to,
    guard: 'owner_signature',
    proofSource: -1, // transfer (not coinbase)
  };
  outputs.push(recipientBox);

  if (change > 0) {
    const changeBox: CreditBox = {
      boxType: 'credit',
      value: change,
      createdAtBlock: currentHeight,
      owner: from,
      guard: 'owner_signature',
      proofSource: -1,
    };
    outputs.push(changeBox);
  }

  // 3. Build transaction
  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.id!),
    outputs: outputs.map((b) => ({ ...b, id: computeBoxId(b) })),
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  const txId = computeTxId(tx);

  // 4. Verify signature
  const keyObj = publicKeyToKeyObject(from);
  const txIdBytes = Buffer.from(txId, 'hex');
  const ok = cryptoVerify(null, txIdBytes, keyObj, Buffer.from(signature));
  if (!ok) {
    throw new Error('invalid signature');
  }

  // 5. Apply to UTXO set
  for (const box of selected) {
    consumeBox(box.id!, currentHeight);
  }
  for (const output of tx.outputs) {
    insertBox(output);
  }

  return {
    txId,
    sent: amount,
    change,
    boxesConsumed: selected.length,
  };
}
```

- [ ] **Step 2: Write the service test**

Create `packages/node/test/services/credits.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { computeBoxId, computeTxId, selectBoxes, PROTOCOL_VERSION } from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity } from '../../src/store/identities.js';
import { insertBox, getCreditBoxes, getUnlockedCreditBoxes } from '../../src/store/utxo.js';
import { sendCredits } from '../../src/services/credits.js';

function rawPublicKey(keyObj: ReturnType<typeof generateKeyPairSync>['publicKey']): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function signTxId(
  tx: UtxoTransaction,
  privKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): Uint8Array {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  return new Uint8Array(sig);
}

describe('sendCredits', () => {
  let alice: ReturnType<typeof generateKeyPairSync>;
  let bob: ReturnType<typeof generateKeyPairSync>;
  let alicePubKey: Uint8Array;
  let bobPubKey: Uint8Array;
  const HEIGHT = 100;

  beforeAll(() => {
    initDb(':memory:');
    alice = generateKeyPairSync('ed25519');
    bob = generateKeyPairSync('ed25519');
    alicePubKey = rawPublicKey(alice.publicKey);
    bobPubKey = rawPublicKey(bob.publicKey);
    insertIdentity(alicePubKey, alicePubKey);
    insertIdentity(bobPubKey, bobPubKey);
  });

  afterAll(() => {
    closeDb();
  });

  function seedCredits(value: number, lockedUntilBlock?: number): CreditBox {
    const box: CreditBox = {
      boxType: 'credit',
      value,
      createdAtBlock: HEIGHT - 10,
      owner: alicePubKey,
      guard: 'owner_signature',
      proofSource: HEIGHT - 10,
    };
    if (lockedUntilBlock !== undefined) {
      box.lockedUntilBlock = lockedUntilBlock;
    }
    box.id = computeBoxId(box);
    insertBox(box);
    return box;
  }

  /** Build and sign a transfer tx the same way sendCredits will internally. */
  function buildSignedTransfer(amount: number): { signature: Uint8Array } {
    const boxes = getUnlockedCreditBoxes(alicePubKey, HEIGHT);
    const selected = selectBoxes(boxes, amount);
    const total = selected.reduce((s, b) => s + b.value, 0);
    const change = total - amount;

    const outputs: CreditBox[] = [{
      boxType: 'credit',
      value: amount,
      createdAtBlock: HEIGHT,
      owner: bobPubKey,
      guard: 'owner_signature',
      proofSource: -1,
    }];
    if (change > 0) {
      outputs.push({
        boxType: 'credit',
        value: change,
        createdAtBlock: HEIGHT,
        owner: alicePubKey,
        guard: 'owner_signature',
        proofSource: -1,
      });
    }

    const tx: UtxoTransaction = {
      inputs: selected.map((b) => b.id!),
      outputs: outputs.map((b) => ({ ...b, id: computeBoxId(b) })),
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const signature = signTxId(tx, alice.privateKey);
    return { signature };
  }

  it('transfers credits from alice to bob', () => {
    seedCredits(500);
    seedCredits(300);

    const { signature } = buildSignedTransfer(400);
    const result = sendCredits(alicePubKey, bobPubKey, 400, signature, HEIGHT);

    expect(result.sent).toBe(400);
    expect(result.change).toBe(400);
    expect(result.boxesConsumed).toBe(2);
    expect(typeof result.txId).toBe('string');

    const aliceBoxes = getCreditBoxes(alicePubKey);
    expect(aliceBoxes).toHaveLength(1);
    expect(aliceBoxes[0]!.value).toBe(400);

    const bobBoxes = getCreditBoxes(bobPubKey);
    expect(bobBoxes).toHaveLength(1);
    expect(bobBoxes[0]!.value).toBe(400);
  });

  it('exact-amount transfer produces no change', () => {
    seedCredits(500);
    const { signature } = buildSignedTransfer(500);
    const result = sendCredits(alicePubKey, bobPubKey, 500, signature, HEIGHT);

    expect(result.sent).toBe(500);
    expect(result.change).toBe(0);
    expect(result.boxesConsumed).toBe(1);
    expect(getCreditBoxes(alicePubKey)).toHaveLength(0);
    expect(getCreditBoxes(bobPubKey)[0]!.value).toBe(500);
  });

  it('skips locked boxes', () => {
    seedCredits(200, 200);
    seedCredits(300);

    const { signature } = buildSignedTransfer(100);
    const result = sendCredits(alicePubKey, bobPubKey, 100, signature, HEIGHT);

    expect(result.boxesConsumed).toBe(1);
    expect(result.change).toBe(200);

    const aliceBoxes = getCreditBoxes(alicePubKey);
    const lockedBox = aliceBoxes.find(b => b.lockedUntilBlock === 200);
    expect(lockedBox).toBeDefined();
    expect(lockedBox!.value).toBe(200);
  });

  it('rejects insufficient balance', () => {
    seedCredits(50);
    const { signature } = buildSignedTransfer(100);
    expect(() => sendCredits(alicePubKey, bobPubKey, 100, signature, HEIGHT))
      .toThrow('Insufficient total value');
  });

  it('rejects bad signature', () => {
    seedCredits(500);
    const badSig = new Uint8Array(64);
    expect(() => sendCredits(alicePubKey, bobPubKey, 100, badSig, HEIGHT))
      .toThrow('invalid signature');
  });

  it('rejects zero or negative amount', () => {
    expect(() => sendCredits(alicePubKey, bobPubKey, 0, new Uint8Array(64), HEIGHT))
      .toThrow('amount must be positive');
    expect(() => sendCredits(alicePubKey, bobPubKey, -5, new Uint8Array(64), HEIGHT))
      .toThrow('amount must be positive');
  });

  it('transfer from multi-box wallet selects correctly', () => {
    seedCredits(100);
    seedCredits(50);
    seedCredits(20);
    seedCredits(10);

    const { signature } = buildSignedTransfer(155);
    const result = sendCredits(alicePubKey, bobPubKey, 155, signature, HEIGHT);

    expect(result.sent).toBe(155);
    expect(result.change).toBe(15);
    expect(result.boxesConsumed).toBe(3);
  });
});
```

- [ ] **Step 3: Run service tests**

```bash
pnpm --filter @dagsocial/node vitest run test/services/credits.test.ts
```
Expected: all 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/credits.ts packages/node/test/services/credits.test.ts
git commit -m "feat(credits): add sendCredits() transfer service"
```

---

### Task 3: Routes — balance update, transfer endpoint, faucet endpoint

**Files:**
- Modify: `packages/node/src/routes/utxo.ts`
- Modify: `packages/node/src/server.ts`
- Modify: `packages/node/src/store/system.ts`
- Modify: `packages/node/src/store/index.ts`
- Modify: `packages/node/test/routes/utxo.test.ts`

**Interfaces:**
- Consumes: `sendCredits` from services/credits.ts, `getUnlockedCreditBoxes` from store
- Produces: `POST /credits/transfer`, `POST /credits/faucet`, updated `GET /credits/:userId`

- [ ] **Step 1: Add `ensureFaucetCreditBox` to store/system.ts**

In `packages/node/src/store/system.ts`, add `getCreditBoxes` to the existing import from `./utxo.js` (line 4 currently imports `insertBox, getKarmaBox`):

```typescript
import { insertBox, getKarmaBox, getCreditBoxes } from './utxo.js';
```

Add `computeBoxId` to the import from `@dagsocial/types` (line 2):

```typescript
import { computeBoxId } from '@dagsocial/types';
```

After the `ensureSystemKarmaBox` function (after line 92), add:

```typescript
const FAUCET_CREDITS_INITIAL = 100_000;

/**
 * Ensure the system keypair has a credit box with FAUCET_CREDITS_INITIAL
 * credits for the testnet faucet. Idempotent — if the system already has
 * unspent credit boxes, does nothing.
 */
export function ensureFaucetCreditBox(
  systemPubKey: Uint8Array,
  currentHeight: number,
): void {
  const existing = getCreditBoxes(systemPubKey);
  if (existing.length > 0) return;

  const box: CreditBox = {
    boxType: 'credit',
    value: FAUCET_CREDITS_INITIAL,
    createdAtBlock: currentHeight > 0 ? currentHeight : 1,
    owner: systemPubKey,
    guard: 'owner_signature',
    proofSource: currentHeight > 0 ? currentHeight : 1,
  };
  box.id = computeBoxId(box);
  insertBox(box);
}
```

The `CreditBox` type needs to be imported — add to the existing type import or add:

```typescript
import type { KarmaBox, CreditBox } from '@dagsocial/types';
```

(Currently line 2 imports `KarmaBox` only — extend to include `CreditBox`.)

Export from `packages/node/src/store/index.ts` — add after `ensureSystemKarmaBox` (line 84):

```typescript
  ensureFaucetCreditBox,
```

- [ ] **Step 2: Update `GET /credits/:userId` to multi-box format**

In `packages/node/src/routes/utxo.ts`:

a) Add `getCreditBoxes` to the `UtxoDeps` interface (after `getCreditBox` on line 14):

```typescript
  getCreditBoxes(owner: Uint8Array): CreditBox[];
```

b) Replace the `GET /credits/:userId` handler (lines 71-91) with:

```typescript
  // GET /credits/:userId — get credit balance for a user (multi-box)
  router.get('/credits/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const identity = deps.getIdentity(userIdBytes);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const creditBoxes = deps.getCreditBoxes(identity.publicKey);
    if (creditBoxes.length === 0) {
      res.status(404).json({ error: 'No credit box found' });
      return;
    }

    const total = creditBoxes.reduce((sum, b) => sum + b.value, 0);
    const boxes = creditBoxes.map(b => ({
      boxId: b.id!,
      value: b.value,
      ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
    }));

    res.json({
      userId: req.params['userId'],
      total,
      boxes,
    });
  });
```

- [ ] **Step 3: Add imports and `POST /credits/transfer` handler**

At the top of `packages/node/src/routes/utxo.ts`, add these imports (the file already imports from express and types — add the new ones):

```typescript
import { sendCredits } from '../services/credits.js';
```

In the route factory function (after `createRouter`), add the handler after the updated `GET /credits/:userId`:

```typescript
  // POST /credits/transfer — transfer credits to another identity
  router.post('/credits/transfer', (req, res) => {
    const body = req.body as {
      from?: string;
      to?: string;
      amount?: number;
      signature?: string;
    };

    if (!body.from || typeof body.from !== 'string' || body.from.length !== 64) {
      res.status(400).json({ error: 'from must be a 64-character hex string' });
      return;
    }
    if (!body.to || typeof body.to !== 'string' || body.to.length !== 64) {
      res.status(400).json({ error: 'to must be a 64-character hex string' });
      return;
    }
    if (!body.amount || typeof body.amount !== 'number' || body.amount < 1) {
      res.status(400).json({ error: 'amount must be a positive integer' });
      return;
    }
    if (!body.signature || typeof body.signature !== 'string') {
      res.status(400).json({ error: 'signature required (base64)' });
      return;
    }

    let fromBytes: Uint8Array;
    let toBytes: Uint8Array;
    let sigBytes: Uint8Array;
    try {
      fromBytes = new Uint8Array(Buffer.from(body.from, 'hex'));
      toBytes = new Uint8Array(Buffer.from(body.to, 'hex'));
      sigBytes = new Uint8Array(Buffer.from(body.signature, 'base64'));
    } catch {
      res.status(400).json({ error: 'invalid encoding' });
      return;
    }

    if (!deps.getIdentity(fromBytes)) {
      res.status(404).json({ error: 'Sender identity not found' });
      return;
    }
    if (!deps.getIdentity(toBytes)) {
      res.status(404).json({ error: 'Recipient identity not found' });
      return;
    }

    const currentHeight = deps.getCurrentHeight();

    try {
      const result = sendCredits(fromBytes, toBytes, body.amount, sigBytes, currentHeight);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'transfer failed';
      if (msg === 'invalid signature') {
        res.status(401).json({ error: msg });
      } else if (msg.includes('Insufficient')) {
        res.status(400).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });
```

Note: The route needs `deps.getCurrentHeight()`. Add to the `UtxoDeps` interface:

```typescript
  getCurrentHeight(): number;
```

- [ ] **Step 4: Add `POST /credits/faucet` handler**

Add imports at the top of `routes/utxo.ts`:

```typescript
import {
  getSystemKeypair,
  signWithSystemKey,
  ensureFaucetCreditBox,
} from '../store/system.js';
import { getUnlockedCreditBoxes } from '../store/utxo.js';
import {
  selectBoxes,
  computeBoxId,
  computeTxId,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import { validateTx } from '../services/utxo-engine.js';
import { insertUtxoTx } from '../store/mempool.js';
import { getNet } from '../services/net-instance.js';
```

Add the handler after the transfer handler:

```typescript
  // POST /credits/faucet — testnet-only credit faucet
  router.post('/credits/faucet', (req, res) => {
    const body = req.body as { to?: string };

    if (!body.to || typeof body.to !== 'string' || body.to.length !== 64) {
      res.status(400).json({ error: 'to must be a 64-character hex string' });
      return;
    }

    let toBytes: Uint8Array;
    try {
      toBytes = new Uint8Array(Buffer.from(body.to, 'hex'));
    } catch {
      res.status(400).json({ error: 'invalid to encoding' });
      return;
    }

    if (!deps.getIdentity(toBytes)) {
      res.status(404).json({ error: 'Recipient identity not found' });
      return;
    }

    const currentHeight = deps.getCurrentHeight();
    const sysKeypair = getSystemKeypair();
    if (!sysKeypair) {
      res.status(500).json({ error: 'Faucet keypair not initialized' });
      return;
    }

    ensureFaucetCreditBox(sysKeypair.publicKey, currentHeight);

    const FAUCET_AMOUNT = 1000;
    const unlocked = getUnlockedCreditBoxes(sysKeypair.publicKey, currentHeight);
    const selected = selectBoxes(unlocked, FAUCET_AMOUNT);
    const totalSelected = selected.reduce((s, b) => s + b.value, 0);
    const change = totalSelected - FAUCET_AMOUNT;

    const outputs: CreditBox[] = [{
      boxType: 'credit',
      value: FAUCET_AMOUNT,
      createdAtBlock: currentHeight,
      owner: toBytes,
      guard: 'owner_signature',
      proofSource: -1,
    }];
    if (change > 0) {
      outputs.push({
        boxType: 'credit',
        value: change,
        createdAtBlock: currentHeight,
        owner: sysKeypair.publicKey,
        guard: 'owner_signature',
        proofSource: -1,
      });
    }

    const tx: UtxoTransaction = {
      inputs: selected.map(b => b.id!),
      outputs: outputs.map(b => ({ ...b, id: computeBoxId(b) })),
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const txId = computeTxId(tx);
    const sysPubKeyHex = Buffer.from(sysKeypair.publicKey).toString('hex');
    const sig = signWithSystemKey(txId, sysKeypair.secretKey);
    tx.signatures[sysPubKeyHex] = sig;

    // Validate via UTXO engine
    const engineDeps = deps.getUtxoEngineDeps();
    const validation = validateTx(engineDeps, tx, currentHeight);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Insert into mempool
    const expiresAtHeight = currentHeight + 720;
    insertUtxoTx(tx, null, expiresAtHeight);

    // Broadcast (best-effort)
    try {
      const net = getNet();
      if (net) {
        net.broadcastTx(tx).catch((err: Error) => {
          console.warn(`Failed to broadcast credit faucet tx: ${err.message}`);
        });
      }
    } catch { /* net not available */ }

    res.json({ txId, amount: FAUCET_AMOUNT });
  });
```

Note: `getNet` is imported statically at the top of the file via `import { getNet } from '../services/net-instance.js'`.

The `deps.getUtxoEngineDeps()` needs to be added to `UtxoDeps`:

```typescript
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
// in the interface:
  getUtxoEngineDeps(): UtxoEngineDeps;
```

- [ ] **Step 5: Update server.ts wiring**

In `packages/node/src/server.ts`:

a) Add `getCreditBoxes` to the UTXO deps (line 174-184):

```typescript
  app.use(
    '/',
    utxoRoutes({
      getIdentity: store.getIdentity,
      getKarmaBox: store.getKarmaBox,
      getKarmaBoxes: store.getKarmaBoxes,
      getCreditBox: store.getCreditBox,
      getCreditBoxes: store.getCreditBoxes,
      getPendingInvites: store.getPendingInvites,
      getBondBoxes: store.getBondBoxes,
      getCurrentHeight: store.getCurrentHeight,
      getUtxoEngineDeps: () => utxoEngineDeps,
    }),
  );
```

b) Add faucet credit boot in `createApp()`. The system keypair is initialized in `packages/node/src/index.ts`. Find where `initSystemKeypair()` and `ensureSystemKarmaBox()` are called, and add after them:

```typescript
  // Seed faucet credits on testnet
  if (config.networkMode === 'testnet') {
    const sysKey = getSystemKeypair();
    if (sysKey) {
      store.ensureFaucetCreditBox(sysKey.publicKey, store.getCurrentHeight());
    }
  }
```

Check `packages/node/src/index.ts` for the exact initialization sequence.

- [ ] **Step 6: Update route tests**

In `packages/node/test/routes/utxo.test.ts`:

a) Update the `request()` helper to support POST. Replace the helper (lines 29-70) with:

```typescript
async function request(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      getIdentity,
      getKarmaBox,
      getKarmaBoxes,
      getCreditBox,
      getCreditBoxes,
      getPendingInvites,
      getBondBoxes,
      getCurrentHeight: () => 100,
      getUtxoEngineDeps: () => ({
        getBox: () => null,
        insertBox: () => {},
        consumeBox: () => {},
        getKarmaBox: () => null,
        getKarmaBoxes: () => [],
        getIdentity: () => null,
        runInTransaction: (fn: () => void) => fn(),
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path,
          method,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: d });
            }
          });
        },
      );
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}
```

b) Update the `GET /credits/:userId` test to match new response shape:

```typescript
  it('GET /credits/:userId returns credit balance (multi-box)', async () => {
    const res = await request(`/credits/${creditUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(creditUserIdHex);
    expect(body.total).toBe(99);
    expect(Array.isArray(body.boxes)).toBe(true);
    expect(body.boxes).toHaveLength(1);
    const b0 = (body.boxes as unknown[])[0] as Record<string, unknown>;
    expect(typeof b0.boxId).toBe('string');
    expect(b0.value).toBe(99);
  });
```

c) Add transfer and faucet tests. These tests need a real DB with seeded credit boxes, and the system keypair initialized. The test setup in `beforeAll` already initializes the DB — add seeding for these tests.

- [ ] **Step 7: Run route tests**

```bash
pnpm --filter @dagsocial/node vitest run test/routes/utxo.test.ts
```
Expected: all tests pass.

- [ ] **Step 8: Run full test suite**

```bash
pnpm test
pnpm typecheck
```
Expected: all 460+ tests pass, zero type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/node/src/routes/utxo.ts packages/node/src/server.ts packages/node/src/store/system.ts packages/node/src/store/index.ts packages/node/test/routes/utxo.test.ts
git commit -m "feat(credits): add transfer and faucet routes, multi-box balance"
```

---

### Task 4: Demo UI — transfer form and faucet button

**Files:**
- Modify: `packages/node/public/index.html`

**Interfaces:**
- Consumes: `GET /credits/:userId` (new multi-box format), `POST /credits/transfer`, `POST /credits/faucet`

- [ ] **Step 1: Update credit balance display and add fetchCreditBoxes helper**

In `loadIdentityStatus()` (around line 1295-1308), change `data.balance` to `data.total`:

```javascript
      creditsEl.textContent = data.total;
      creditsEl.style.color = data.total > 0 ? '#3fb950' : '#8b949e';
```

Add `fetchCreditBoxes()` helper near `fetchKarmaBox()` (around line 420):

```javascript
async function fetchCreditBoxes() {
  if (!userId) return null;
  try {
    const res = await fetch(API + '/credits/' + encodeURIComponent(userId));
    if (!res.ok) return null;
    return await res.json(); // { userId, total, boxes: [{ boxId, value, lockedUntilBlock? }] }
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Add HTML for credit faucet and transfer**

In the admin section (`<div id="adminSection">`), after the karma faucet section (after `</div>` closing `faucetResult` around line 91):

```html
    <h3>Credit Faucet</h3>
    <div class="row">
      <button id="creditFaucetBtn" class="small">Get 1000 credits</button>
    </div>
    <div id="creditFaucetResult"></div>

    <h3>Credit Transfer</h3>
    <div class="row">
      <input id="creditTransferRecipient" placeholder="Recipient user ID (hex)" style="flex:1;font-size:11px">
    </div>
    <div class="row" style="margin-top:4px">
      <input id="creditTransferAmount" type="number" value="10" min="1" style="width:120px">
      <button id="creditTransferBtn" class="small">Send</button>
    </div>
    <div id="creditTransferResult"></div>
```

- [ ] **Step 3: Add JavaScript for credit faucet and transfer**

Add after the karma faucet JavaScript (after the `faucetBtn` event listener block ending around line 1367):

```javascript
// ===========================================================================
// Credit Faucet
// ===========================================================================

document.getElementById('creditFaucetBtn').addEventListener('click', async () => {
  const btn = document.getElementById('creditFaucetBtn');
  const result = document.getElementById('creditFaucetResult');

  btn.disabled = true;
  result.innerHTML = '<span class="result-msg">Requesting...</span>';

  try {
    const res = await fetch(API + '/credits/faucet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: userId }),
    });
    const data = await res.json();
    if (res.ok) {
      result.innerHTML = `<span class="result-msg ok">Granted ${data.amount} credits. TxId: ${(data.txId || '').slice(0, 16)}...</span>`;
      loadIdentityStatus();
      loadStatus();
    } else {
      result.innerHTML = `<span class="result-msg err">${esc(data.error || 'faucet failed')}</span>`;
    }
  } catch (e) {
    result.innerHTML = `<span class="result-msg err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// ===========================================================================
// Credit Transfer
// ===========================================================================

function buildCreditTransferTx(creditBoxes, recipientHex, amount) {
  const now = currentBlockHeight;
  const selected = selectBoxes(creditBoxes.boxes, amount);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0);
  const change = selectedTotal - amount;

  const outputs = [{
    boxType: 'credit',
    value: amount,
    createdAtBlock: now,
    owner: recipientHex,
    guard: 'owner_signature',
    proofSource: -1,
  }];
  if (change > 0) {
    outputs.push({
      boxType: 'credit',
      value: change,
      createdAtBlock: now,
      owner: buf2hex(pubKeyRaw),
      guard: 'owner_signature',
      proofSource: -1,
    });
  }

  return {
    inputs: selected.map(b => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

document.getElementById('creditTransferBtn').addEventListener('click', async () => {
  const btn = document.getElementById('creditTransferBtn');
  const result = document.getElementById('creditTransferResult');
  const recipient = document.getElementById('creditTransferRecipient').value.trim();
  const amount = parseInt(document.getElementById('creditTransferAmount').value) || 0;

  if (!recipient || recipient.length !== 64) {
    result.innerHTML = '<span class="result-msg err">Recipient must be a 64-character hex user ID</span>';
    return;
  }
  if (amount < 1) {
    result.innerHTML = '<span class="result-msg err">Amount must be at least 1</span>';
    return;
  }

  btn.disabled = true;
  result.innerHTML = '<span class="result-msg">Building transaction...</span>';

  try {
    const creditBoxes = await fetchCreditBoxes();
    if (!creditBoxes || creditBoxes.total < amount) {
      result.innerHTML = `<span class="result-msg err">Insufficient credits: have ${creditBoxes?.total || 0}, need ${amount}</span>`;
      btn.disabled = false;
      return;
    }

    const tx = buildCreditTransferTx(creditBoxes, recipient, amount);
    const { signature } = await signTxId(tx);
    const pubKeyHex = buf2hex(pubKeyRaw);
    tx.signatures[pubKeyHex] = signature;

    // Convert hex signature to base64 for the API
    const sigBytes = hex2buf(signature);
    const sigBase64 = btoa(String.fromCharCode(...sigBytes));

    const res = await fetch(API + '/credits/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: userId,
        to: recipient,
        amount,
        signature: sigBase64,
      }),
    });

    const data = await res.json();
    if (res.ok) {
      result.innerHTML = `<span class="result-msg ok">Sent ${data.sent} credits${data.change > 0 ? ' (change: ' + data.change + ')' : ''}. TxId: ${(data.txId || '').slice(0, 16)}...</span>`;
      loadIdentityStatus();
      loadStatus();
    } else {
      result.innerHTML = `<span class="result-msg err">${esc(data.error || 'transfer failed')}</span>`;
    }
  } catch (e) {
    result.innerHTML = `<span class="result-msg err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});
```

Note: Verify that `hex2buf` and `buf2hex` helper names match what's defined in the demo UI (common names — check the script). The `btoa(String.fromCharCode(...sigBytes))` pattern converts raw bytes to base64. If `sigBytes` is large (64 bytes), this works but may hit call stack limits in some engines — test it.

- [ ] **Step 4: Verify full build and test suite**

```bash
pnpm build
pnpm test
pnpm typecheck
```
Expected: clean build, all tests pass, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/node/public/index.html
git commit -m "feat(ui): add credit transfer form and faucet button"
```

---

### Post-Implementation Verification

- [ ] Start a testnet node: `NETWORK_MODE=testnet pnpm --filter @dagsocial/node start`
- [ ] Create two identities
- [ ] Use the credit faucet to get 1000 credits on identity 1
- [ ] Transfer 300 credits from identity 1 to identity 2
- [ ] Verify identity 1 balance drops, identity 2 receives
- [ ] Verify the credit faucet/transfer UI appears only on testnet
