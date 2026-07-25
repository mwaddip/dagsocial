# Karma Box Multi-UTXO Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-box blind picks with largest-first multi-box UTXO selection so multiple karma boxes per identity are all visible and spendable.

**Architecture:** Add a generic `selectBoxes<T>()` pure function in types, add `getKarmaBoxes` / `getCreditBoxes` store queries returning all unspent boxes sorted by value desc, update the karma API to return all boxes, and update `mintKarma` + verifier to use multi-box selection. Keep `getKarmaBox` / `getCreditBox` as convenience wrappers for callers that only need a single box.

**Tech Stack:** TypeScript, better-sqlite3, vitest

## Global Constraints

- `selectBoxes` is generic over `{ value: number }`, largest-first, throws on insufficient total
- Multi-box callers use `getKarmaBoxes` / `getCreditBoxes`; existing single-box callers unchanged
- No schema changes, no migration
- `mintKarma` consumes ALL existing karma boxes when merging
- Verifier checks total karma across all boxes for post lock sufficiency

---

### Task 1: `selectBoxes` pure function (`@dagsocial/types`)

**Files:**
- Modify: `packages/types/src/utxo.ts` (append function + export)
- Modify: `packages/types/src/index.ts` (add export)
- Modify: `packages/types/test/utxo.test.ts` (add test block)

**Interfaces:**
- Produces: `selectBoxes<T extends { value: number }>(boxes: T[], requiredAmount: number): T[]`

- [ ] **Step 1: Write the failing tests**

In `packages/types/test/utxo.test.ts`, append after the last test block:

```typescript
// ---------------------------------------------------------------------------
// selectBoxes
// ---------------------------------------------------------------------------

describe('selectBoxes', () => {
  it('returns single box when value equals required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 5, id: 'a' }];
    const result = selectBoxes(boxes, 5);
    expect(result).toEqual([{ value: 5, id: 'a' }]);
  });

  it('returns single box when value exceeds required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10, id: 'a' }];
    const result = selectBoxes(boxes, 5);
    expect(result).toEqual([{ value: 10, id: 'a' }]);
  });

  it('selects largest-first to cover required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
      { value: 10, id: 'small' },
    ];
    // 100 covers 80 alone — largest-first picks just the big one
    const result = selectBoxes(boxes, 80);
    expect(result).toEqual([{ value: 100, id: 'big' }]);
  });

  it('selects multiple boxes when one is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
      { value: 10, id: 'small' },
    ];
    // 150 needs big (100) + med (50)
    const result = selectBoxes(boxes, 150);
    expect(result).toEqual([
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
    ]);
  });

  it('selects all boxes when needed', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
      { value: 10, id: 'small' },
    ];
    const result = selectBoxes(boxes, 160);
    expect(result).toEqual(boxes);
  });

  it('throws when total is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 10, id: 'a' },
      { value: 5, id: 'b' },
    ];
    expect(() => selectBoxes(boxes, 20)).toThrow('Insufficient total value');
  });

  it('throws on empty boxes with positive requiredAmount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    expect(() => selectBoxes([], 1)).toThrow('Insufficient total value');
  });

  it('returns empty array for requiredAmount of 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10, id: 'a' }];
    const result = selectBoxes(boxes, 0);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty boxes and requiredAmount 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const result = selectBoxes([], 0);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @dagsocial/types test
```

Expected: FAIL — `selectBoxes is not a function` or similar.

- [ ] **Step 3: Implement `selectBoxes` in types**

In `packages/types/src/utxo.ts`, append after the last function (after `computeTxId`):

```typescript
/**
 * Largest-first UTXO selection. Returns the minimal subset of boxes whose
 * combined value covers `requiredAmount`. Assumes boxes are pre-sorted by
 * value descending. Throws if the total value of all boxes is insufficient.
 */
export function selectBoxes<T extends { value: number }>(
  boxes: T[],
  requiredAmount: number,
): T[] {
  if (requiredAmount <= 0) return [];

  let accumulated = 0;
  const selected: T[] = [];
  for (const box of boxes) {
    accumulated += box.value;
    selected.push(box);
    if (accumulated >= requiredAmount) break;
  }

  if (accumulated < requiredAmount) {
    throw new Error('Insufficient total value');
  }

  return selected;
}
```

- [ ] **Step 4: Export from types index**

In `packages/types/src/index.ts`, find the export block for utxo functions and add `selectBoxes`:

```typescript
export {
  computeBoxId,
  computeTxId,
  encodeTx,
  decodeTx,
  selectBoxes,
} from './utxo.js';
```

(Only add `selectBoxes` to the existing export list — don't duplicate the other names.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @dagsocial/types test
```

Expected: all tests PASS including the new `selectBoxes` block.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/utxo.ts packages/types/src/index.ts packages/types/test/utxo.test.ts
git commit -m "feat(types): add selectBoxes for largest-first UTXO selection
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Store queries `getKarmaBoxes` / `getCreditBoxes` (`@dagsocial/node`)

**Files:**
- Modify: `packages/node/src/store/utxo.ts` (add two functions)
- Modify: `packages/node/src/store/index.ts` (add exports)
- Modify: `packages/node/test/store/utxo.test.ts` (add test block)

**Interfaces:**
- Consumes: `KarmaBox`, `CreditBox`, `AnyBox` from `@dagsocial/types` (existing)
- Produces: `getKarmaBoxes(owner: Uint8Array): KarmaBox[]`, `getCreditBoxes(owner: Uint8Array): CreditBox[]`

- [ ] **Step 1: Write the failing tests**

In `packages/node/test/store/utxo.test.ts`, find the `importUtxoFresh()` helper type (around line 29–43) and add the new function types:

Find this block:
```typescript
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getCreditBox: (owner: Uint8Array) => CreditBox | null;
```

Add after:
```typescript
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getCreditBoxes: (owner: Uint8Array) => CreditBox[];
```

Then append at the end of the file (after the last test block) to add the test cases:

```typescript
  // --- getKarmaBoxes returns all unspent karma boxes sorted by value desc -----

  it('getKarmaBoxes returns all unspent karma boxes sorted value desc', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box1 = makeKarmaBox({ value: 100, owner });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeKarmaBox({ value: 200, owner });
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const box3 = makeKarmaBox({ value: 50, owner });
    box3.id = computeBoxId(box3);
    insertBox(box3);

    // Consume box2 — it should be excluded
    consumeBox(box2.id!, 5);

    const results = getKarmaBoxes(owner);
    expect(results).toHaveLength(2);
    // Sorted value desc: 100, 50
    expect(results[0]!.value).toBe(100);
    expect(results[1]!.value).toBe(50);
  });

  it('getKarmaBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getKarmaBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getKarmaBoxes(bytes(32));
    expect(results).toEqual([]);
  });

  it('getKarmaBoxes excludes boxes owned by other users', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const alice = bytes(32).fill(0xaa);
    const bob = bytes(32).fill(0xbb);

    const aliceBox = makeKarmaBox({ value: 100, owner: alice });
    aliceBox.id = computeBoxId(aliceBox);
    insertBox(aliceBox);

    const bobBox = makeKarmaBox({ value: 200, owner: bob });
    bobBox.id = computeBoxId(bobBox);
    insertBox(bobBox);

    const results = getKarmaBoxes(alice);
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe(100);
  });

  // --- getCreditBoxes return all unspent credit boxes sorted by value desc ----

  it('getCreditBoxes returns all unspent credit boxes sorted value desc', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getCreditBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box1 = makeCreditBox({ value: 300, owner });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeCreditBox({ value: 500, owner });
    box2.id = computeBoxId(box2);
    insertBox(box2);

    // Consume box1 — it should be excluded
    consumeBox(box1.id!, 5);

    const results = getCreditBoxes(owner);
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe(500);
  });

  it('getCreditBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getCreditBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getCreditBoxes(bytes(32));
    expect(results).toEqual([]);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern='utxo\.test'
```

Expected: FAIL on the new tests — `getKarmaBoxes is not a function`.

- [ ] **Step 3: Implement the store functions**

In `packages/node/src/store/utxo.ts`, add after `getKarmaBox` the `getKarmaBoxes` function:

```typescript
/**
 * Return all unspent karma boxes for the given owner, sorted by value
 * descending (largest-first for UTXO selection).
 */
export function getKarmaBoxes(owner: Uint8Array): KarmaBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL
       ORDER BY value DESC`,
    )
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as KarmaBox[];
}
```

Add after `getCreditBox` the `getCreditBoxes` function:

```typescript
/**
 * Return all unspent credit boxes for the given owner, sorted by value
 * descending (largest-first for UTXO selection).
 */
export function getCreditBoxes(owner: Uint8Array): CreditBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
       ORDER BY value DESC`,
    )
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as CreditBox[];
}
```

- [ ] **Step 4: Export from store barrel**

In `packages/node/src/store/index.ts`, find the export block with `getKarmaBox, getCreditBox` and add:

```typescript
  getKarmaBox,
  getKarmaBoxes,
  getCreditBox,
  getCreditBoxes,
```

- [ ] **Step 5: Run the store tests to verify they pass**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern='utxo\.test'
```

Expected: all store tests PASS including the new `getKarmaBoxes` / `getCreditBoxes` tests.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/store/utxo.ts packages/node/src/store/index.ts packages/node/test/store/utxo.test.ts
git commit -m "feat(store): add getKarmaBoxes and getCreditBoxes multi-box queries
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Update `GET /karma/:userId` API

**Files:**
- Modify: `packages/node/src/routes/utxo.ts` (deps interface + handler)
- Modify: `packages/node/test/routes/utxo.test.ts` (update assertions)

**Interfaces:**
- Consumes: `getKarmaBoxes` (new store function from Task 2)
- Produces: updated API response `{ userId, total, boxes: { boxId, value }[] }`

- [ ] **Step 1: Update the route deps interface**

In `packages/node/src/routes/utxo.ts`, update the `UtxoDeps` interface to add `getKarmaBoxes`:

```typescript
export interface UtxoDeps {
  getIdentity(
    userId: Uint8Array,
  ): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  getKarmaBoxes(owner: Uint8Array): KarmaBox[];
  getCreditBox(owner: Uint8Array): CreditBox | null;
  getPendingInvites(inviterId: Uint8Array): InviteBox[];
  getBondBoxes(inviterId: Uint8Array): BondBox[];
}
```

- [ ] **Step 2: Update the `/karma/:userId` handler**

In `packages/node/src/routes/utxo.ts`, replace the handler body (lines 40–62) with:

```typescript
  // GET /karma/:userId — get karma balance for a user
  router.get('/karma/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const identity = deps.getIdentity(userIdBytes);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const karmaBoxes = deps.getKarmaBoxes(identity.publicKey);
    if (karmaBoxes.length === 0) {
      res.status(404).json({ error: 'No karma box found' });
      return;
    }

    const total = karmaBoxes.reduce((sum, b) => sum + b.value, 0);
    const boxes = karmaBoxes.map(b => ({
      boxId: b.id!,
      value: b.value,
    }));

    res.json({
      userId: req.params['userId'],
      total,
      boxes,
    });
  });
```

- [ ] **Step 3: Update the route test**

Read `packages/node/test/routes/utxo.test.ts` to find the karma endpoint test. Update the assertion to match the new response shape (check `total` and `boxes` array instead of `balance` and `boxId`).

The existing test likely does:
```typescript
expect(result.body).toMatchObject({ balance: expect.any(Number), boxId: expect.any(String) });
```

Update to:
```typescript
expect(result.body).toMatchObject({
  total: expect.any(Number),
  boxes: expect.arrayContaining([
    expect.objectContaining({ boxId: expect.any(String), value: expect.any(Number) }),
  ]),
});
```

- [ ] **Step 4: Run the route test**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern='routes/utxo'
```

Expected: PASS with updated assertions.

- [ ] **Step 5: Verify all node tests still pass**

```bash
pnpm --filter @dagsocial/node test
```

Expected: 246 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/routes/utxo.ts packages/node/test/routes/utxo.test.ts
git commit -m "feat(api): return all karma boxes in GET /karma/:userId

Replace single-box response with { total, boxes[] } so clients can see
and spend all their karma boxes instead of just one arbitrary pick.
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update `mintKarma` and `mintCredits` to merge all boxes

**Files:**
- Modify: `packages/node/src/services/karma.ts`
- Modify: `packages/node/src/services/credits.ts`

**Interfaces:**
- Consumes: `getKarmaBoxes`, `getCreditBoxes` (Task 2), `selectBoxes` (Task 1)
- Produces: same signature — `mintKarma(userId, amount, blockHeight): string`, `mintCredits(owner, amount, blockHeight, lockedUntilBlock?): string`

- [ ] **Step 1: Update `mintKarma` to merge all boxes**

In `packages/node/src/services/karma.ts`, replace the import and function body:

```typescript
import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { getKarmaBoxes, insertBox, consumeBox } from '../store/index.js';

/**
 * Mint (or increase) karma for a given user.
 *
 * Consumes ALL existing unspent karma boxes and creates a single new one
 * with the combined value + amount. This ensures each identity has at most
 * one unspent karma box after any mint operation.
 *
 * Exported so both the local block creator (miner) and the server's
 * block-application path can use it.
 */
export function mintKarma(
  userId: Uint8Array,
  amount: number,
  blockHeight: number,
): string {
  if (amount <= 0) return '';

  const existingBoxes = getKarmaBoxes(userId);
  const existingTotal = existingBoxes.reduce((sum, b) => sum + b.value, 0);
  const newValue = existingTotal + amount;

  // Consume all existing boxes
  for (const box of existingBoxes) {
    if (box.id) consumeBox(box.id, blockHeight);
  }

  const proofSource = existingBoxes.length > 0
    ? (existingBoxes[0]!.proofSource ?? `mint-${blockHeight}`)
    : `mint-${blockHeight}`;

  const newBox: KarmaBox = {
    boxType: 'karma',
    value: newValue,
    createdAtBlock: blockHeight,
    owner: userId,
    guard: 'owner_signature',
    proofSource,
    lastTouchBlock: blockHeight,
  };
  const boxId = computeBoxId(newBox);
  newBox.id = boxId;

  insertBox(newBox);
  return boxId;
}
```

- [ ] **Step 2: Update `mintCredits` to merge all boxes**

In `packages/node/src/services/credits.ts`, replace the import and function body:

```typescript
import { computeBoxId } from '@dagsocial/types';
import type { CreditBox } from '@dagsocial/types';
import { getCreditBoxes, insertBox, consumeBox } from '../store/index.js';

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

  // Consume all existing boxes
  for (const box of existingBoxes) {
    if (box.id) consumeBox(box.id, blockHeight);
  }

  // Merge lock: keep the furthest-future lock
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
```

- [ ] **Step 3: Run all node tests**

```bash
pnpm --filter @dagsocial/node test
```

Expected: 246 tests pass. The karma and credits tests should still pass since `mintKarma` and `mintCredits` keep the same signatures — only internal implementation changed.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/karma.ts packages/node/src/services/credits.ts
git commit -m "feat(mint): merge all existing boxes in mintKarma and mintCredits

Consume all unspent karma/credit boxes for the owner instead of just the
first one, producing a single consolidated output box.
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update verifier for multi-box karma sufficiency

**Files:**
- Modify: `packages/node/src/services/verifier.ts` (deps interface + check)
- Modify: `packages/node/test/services/verifier.test.ts` (mock store + add test)

**Interfaces:**
- Consumes: `getKarmaBoxes` returning multiple boxes
- Produces: same `VerificationResult`

- [ ] **Step 1: Update `VerifierDeps` interface**

In `packages/node/src/services/verifier.ts`, replace the `getKarmaBox` dep with `getKarmaBoxes`:

```typescript
export interface VerifierDeps {
  getActiveChallenge: (
    userId: Uint8Array,
  ) => { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null;
  getIdentity: (
    userId: Uint8Array,
  ) => { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBoxes: (owner: Uint8Array) => { value: number; id?: string }[];
  getPost: (id: string) => unknown | null;
}
```

- [ ] **Step 2: Update the karma sufficiency check**

In `packages/node/src/services/verifier.ts`, replace the karma block (lines 103–117) with:

```typescript
  // 7. Karma: author must have sufficient karma across all boxes.
  // Look up by public key (post.author).
  const karmaBoxes = deps.getKarmaBoxes(post.author);
  if (karmaBoxes.length === 0) {
    return { valid: false, error: 'No karma box found' };
  }
  const totalKarma = karmaBoxes.reduce((sum, b) => sum + b.value, 0);
  const requiredKarma =
    post.parentRefs.length === 0 ? POST_LOCK_THREAD_COST : POST_LOCK_REPLY_COST;
  if (totalKarma < requiredKarma) {
    return {
      valid: false,
      error: `Insufficient karma: need ${requiredKarma} (have ${totalKarma})`,
    };
  }
```

- [ ] **Step 3: Update verifier tests**

In `packages/node/test/services/verifier.test.ts`:

**a)** Update the `MockStore` interface:
```typescript
interface MockStore {
  identities: Map<string, { userId: Uint8Array; publicKey: Uint8Array; createdAt: number }>;
  challenges: Map<string, { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array }>;
  karmaBoxes: Map<string, { value: number }[]>; // keyed by hex(owner publicKey), now an array
  posts: Map<string, unknown>;
}
```

**b)** Update `createMockDeps`:
```typescript
function createMockDeps(store: MockStore): VerifierDeps {
  return {
    getActiveChallenge: (userId: Uint8Array) => store.challenges.get(userId) ?? null,
    getIdentity: (userId: Uint8Array) => store.identities.get(userId) ?? null,
    getKarmaBoxes: (owner: Uint8Array) => {
      const hex = Buffer.from(owner).toString('hex');
      return store.karmaBoxes.get(hex) ?? [];
    },
    getPost: (id: string) => store.posts.get(id) ?? null,
  };
}
```

**c)** Update `makeStore` — karmaBoxes now Map of arrays:
```typescript
  function makeStore(): MockStore {
    return {
      identities: new Map(),
      challenges: new Map(),
      karmaBoxes: new Map(),
      posts: new Map(),
    };
  }
```
(No change needed — the Map just holds arrays instead of single objects now.)

**d)** Update ALL existing test usages of `store.karmaBoxes.set(...)` to wrap the value in an array. Each single-object value becomes a single-element array:

- Line 169–171: `{ value: POST_LOCK_THREAD_COST }` → `[{ value: POST_LOCK_THREAD_COST }]`
- Line 333–335: `{ value: POST_LOCK_THREAD_COST }` → `[{ value: POST_LOCK_THREAD_COST }]`
- Line 378–380: `{ value: POST_LOCK_THREAD_COST }` → `[{ value: POST_LOCK_THREAD_COST }]`
- Line 383: (same pattern, second set in the same test) → `[{ value: POST_LOCK_THREAD_COST }]`
- Line 419: `{ value: 0 }` → `[{ value: 0 }]`
- Line 453–455: `{ value: POST_LOCK_THREAD_COST }` → `[{ value: POST_LOCK_THREAD_COST }]`

**e)** Add two new tests for multi-box sufficiency at the end of the `verifyPost` describe block:

```typescript
  it('accepts post when karma is split across multiple boxes', { timeout: 60_000 }, () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.challenges.set(userId, { userId, challenge: challengeBytes, expiresAtBlock: 100 });
    // Two karma boxes: 3 + 2 = 5, enough for thread post
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 3 },
      { value: 2 },
    ]);
    const deps = createMockDeps(store);
    let post = makePost();
    const powInput = buildPowInput(post);
    const nonce = solvePoW(powInput, 20);
    post = { ...post, powNonce: nonce };
    post = signPost(post);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(true);
  });

  it('rejects post when combined karma across boxes is insufficient', { timeout: 60_000 }, () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.challenges.set(userId, { userId, challenge: challengeBytes, expiresAtBlock: 100 });
    // Two boxes with 2 + 2 = 4, but thread post costs 5
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 2 },
      { value: 2 },
    ]);
    const deps = createMockDeps(store);
    let post = makePost();
    const powInput = buildPowInput(post);
    const nonce = solvePoW(powInput, 20);
    post = { ...post, powNonce: nonce };
    post = signPost(post);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient karma');
  });
```

- [ ] **Step 4: Run verifier tests**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern='verifier'
```

Expected: all verifier tests PASS including the new multi-box tests.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/services/verifier.ts packages/node/test/services/verifier.test.ts
git commit -m "feat(verifier): check total karma across all boxes for post creation
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Wire new deps in server and index

**Files:**
- Modify: `packages/node/src/server.ts` (add getKarmaBoxes / getCreditBoxes to dep objects)
- Modify: `packages/node/src/index.ts` (add imports, wire to dep objects)

**Interfaces:**
- Consumes: `getKarmaBoxes`, `getCreditBoxes` from Task 2

- [ ] **Step 1: Wire in `server.ts`**

In `packages/node/src/server.ts`, at each of the 6 dep objects that pass `getKarmaBox`, add `getKarmaBoxes` alongside it. The line numbers below are where `getKarmaBox` already appears — add the new line right after each one:

- Line 46: `getKarmaBox: store.getKarmaBox,` → add `getKarmaBoxes: store.getKarmaBoxes,` after
- Line 97: `getKarmaBox: store.getKarmaBox,` → add `getKarmaBoxes: store.getKarmaBoxes,` after
- Line 119: `getKarmaBox: store.getKarmaBox,` → add `getKarmaBoxes: store.getKarmaBoxes,` after
- Line 136: `getKarmaBox: store.getKarmaBox,` → add `getKarmaBoxes: store.getKarmaBoxes,` after
- Line 148: `getKarmaBox: store.getKarmaBox,` → add `getKarmaBoxes: store.getKarmaBoxes,` after
- Line 177: `getKarmaBox: store.getKarmaBox,` → add `getKarmaBoxes: store.getKarmaBoxes,` after

Also at line 178 (`getCreditBox: store.getCreditBox,`), add:

```typescript
getCreditBoxes: store.getCreditBoxes,
```

- [ ] **Step 2: Wire in `index.ts`**

In `packages/node/src/index.ts`:

**a) Line 15** — add to the import from `../store/index.js`:
```typescript
  getKarmaBox,
  getKarmaBoxes,
  getCreditBox,
  getCreditBoxes,
```

**b) Lines 63–73** — in the `onSubBlock` handler, the `verifyPostForRelay` call creates a `VerifierDeps` inline. Since Task 5 renamed `getKarmaBox` → `getKarmaBoxes` in the interface, change line 68 from:

```typescript
      getKarmaBox,
```
to:
```typescript
      getKarmaBoxes,

**c) Line 192** — in the `deps` object for `validateTx`, add after `getKarmaBox,`:
```typescript
    getKarmaBoxes,

- [ ] **Step 3: Build and typecheck**

```bash
pnpm build && pnpm typecheck
```

Expected: clean build, no type errors.

- [ ] **Step 4: Run all tests**

```bash
pnpm test
```

Expected: 427 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/server.ts packages/node/src/index.ts
git commit -m "feat(wiring): expose getKarmaBoxes and getCreditBoxes in server deps
Co-Authored-By: Claude <noreply@anthropic.com>"
```
