# Karma Decay: Periodic Burn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace spend-time formula-based karma decay with a periodic burn model: after 28 days of inactivity, burn 5 karma per 24 hours, floor at 10.

**Architecture:** New `decay.ts` service with pure functions (`isIdentityStale`, `owedPeriods`) and an `applyKarmaDecay` function called from `applyOrderingBlock`. New `DecayJournalEntry` in the journal for fork rollback. Old `effectiveKarmaValue`/`checkKarmaDecay` removed from UTXO engine.

**Tech Stack:** TypeScript, better-sqlite3, vitest

## Global Constraints

- `KARMA_STALE_THRESHOLD_BLOCKS = 20160` (28 days), `KARMA_DECAY_INTERVAL_BLOCKS = 720` (24h), `KARMA_DECAY_AMOUNT = 5`, `KARMA_MINIMUM = 10`
- `decayBurn: boolean` optional field on `KarmaBox` — absent on normal boxes, `true` on decay-created boxes
- `isIdentityStale` checks for ANY normal box within threshold — if found, not stale
- Decay creates single consolidated replacement box consuming all previous karma boxes
- Decay burn caps at `min(owed * DECAY_AMOUNT, totalKarma - KARMA_MINIMUM)`
- Remove `KARMA_DECAY_RATE`, `KARMA_DECAY_GRACE_BLOCKS`, `KARMA_FLOOR`
- Remove `effectiveKarmaValue()`, `checkKarmaDecay()`, and decay steps from `validateTx`/`revalidateTxInContext`
- Journal tracks decay burns for fork rollback

---

### Task 1: Constants + KarmaBox type + Journal type

**Files:**
- Modify: `packages/types/src/constants.ts:12-16`
- Modify: `packages/types/src/utxo.ts:43-49` (KarmaBox interface)
- Modify: `packages/types/src/journal.ts:1-24` (add DecayJournalEntry)
- Modify: `packages/types/src/index.ts` (update exports)
- Modify: `packages/types/test/utxo.test.ts` (add decayBurn to computeBoxId test)

**Interfaces:**
- Produces: `KARMA_STALE_THRESHOLD_BLOCKS`, `KARMA_DECAY_INTERVAL_BLOCKS`, `KARMA_DECAY_AMOUNT`, `KARMA_MINIMUM` (replacing old decay constants)
- Produces: `DecayJournalEntry` interface
- Produces: `KarmaBox.decayBurn?: boolean`

- [ ] **Step 1: Update constants**

In `packages/types/src/constants.ts`, replace lines 12-16:

```typescript
// Karma (old — replaced by periodic decay)
// export const KARMA_DECAY_RATE = 0.0001;       // removed
// export const KARMA_DECAY_GRACE_BLOCKS = 100;  // removed
// export const KARMA_FLOOR = 0;                 // removed

// Karma decay (periodic burn model)
export const KARMA_POSTING_MINIMUM = 1;
export const KARMA_STALE_THRESHOLD_BLOCKS = 20160; // 28 days at 2m blocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 720;    // 24 hours at 2m blocks
export const KARMA_DECAY_AMOUNT = 5;               // karma burned per interval
export const KARMA_MINIMUM = 10;                   // floor — decay never reduces below this
```

- [ ] **Step 2: Add `decayBurn` to KarmaBox**

In `packages/types/src/utxo.ts`, add the optional field to the `KarmaBox` interface:

```typescript
export interface KarmaBox extends BoxBase {
  boxType: 'karma';
  owner: Uint8Array;
  guard: 'owner_signature';
  proofSource: string;
  lastTouchBlock: number;
  decayBurn?: boolean;
}
```

- [ ] **Step 3: Add `DecayJournalEntry` to journal types**

In `packages/types/src/journal.ts`, add before `BlockJournal`:

```typescript
export interface DecayJournalEntry {
  owner: Uint8Array;
  consumedBoxIds: string[];
  newBoxId: string;
  burnAmount: number;
}
```

Update `BlockJournal` to include the new field:

```typescript
export interface BlockJournal {
  blockHeight: number;
  creditBoxIds: string[];
  confirmedSubBlockIds: string[];
  subBlockCbors: { subBlockId: string; cbor: Uint8Array }[];
  talliedLikeBoxIds: string[];
  karmaMints: KarmaMint[];
  appliedUtxoTxs: AppliedUtxoTx[];
  decayBurns: DecayJournalEntry[];
}
```

- [ ] **Step 4: Update types exports**

In `packages/types/src/index.ts`, update exports:
- Remove `KARMA_DECAY_RATE`, `KARMA_DECAY_GRACE_BLOCKS`, `KARMA_FLOOR`
- Add `KARMA_STALE_THRESHOLD_BLOCKS`, `KARMA_DECAY_INTERVAL_BLOCKS`, `KARMA_DECAY_AMOUNT`, `KARMA_MINIMUM`
- Add `DecayJournalEntry` to type exports

- [ ] **Step 5: Update computeBoxId test for decayBurn**

In `packages/types/test/utxo.test.ts`, add a test verifying `computeBoxId` includes `decayBurn` in the hash:

```typescript
it('computeBoxId differs when decayBurn differs', () => {
  const box1 = makeKarmaBox({ value: 100 });
  const box2 = makeKarmaBox({ value: 100, decayBurn: true });
  const id1 = computeBoxId(box1);
  const id2 = computeBoxId(box2);
  expect(id1).not.toBe(id2);
});
```

- [ ] **Step 6: Run types tests + build**

```bash
pnpm --filter @dagsocial/types test && pnpm build
```

Expected: types tests pass. Build may have errors in node package (imports old constants) — expected, fixed in later tasks.

- [ ] **Step 7: Commit**

```bash
git add packages/types/
git commit -m "feat(types): periodic decay constants, decayBurn field, DecayJournalEntry
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Decay service (`isIdentityStale`, `owedPeriods`, `applyKarmaDecay`)

**Files:**
- Create: `packages/node/src/services/decay.ts`

**Interfaces:**
- Consumes: `KARMA_STALE_THRESHOLD_BLOCKS`, `KARMA_DECAY_INTERVAL_BLOCKS`, `KARMA_DECAY_AMOUNT`, `KARMA_MINIMUM` (Task 1)
- Consumes: `KarmaBox`, `DecayJournalEntry` (Task 1)
- Consumes: `computeBoxId` from `@dagsocial/types`
- Consumes: `getKarmaBoxes`, `consumeBox`, `insertBox` from store (existing)
- Produces: `isIdentityStale(boxes, currentHeight, thresholdBlocks): boolean`
- Produces: `owedPeriods(boxes, currentHeight, intervalBlocks): number`
- Produces: `applyKarmaDecay(deps, currentHeight): DecayJournalEntry[]`

- [ ] **Step 1: Create the decay service**

Create `packages/node/src/services/decay.ts`:

```typescript
import {
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  computeBoxId,
} from '@dagsocial/types';
import type { KarmaBox, DecayJournalEntry } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * An identity is stale if it has NO unspent karma box where decayBurn !== true
 * and createdAtBlock is within the threshold window.
 */
export function isIdentityStale(
  boxes: KarmaBox[],
  currentHeight: number,
  thresholdBlocks: number,
): boolean {
  if (boxes.length === 0) return false;
  const hasRecentActivity = boxes.some(
    (b) =>
      b.decayBurn !== true &&
      b.createdAtBlock > currentHeight - thresholdBlocks,
  );
  return !hasRecentActivity;
}

/**
 * How many decay periods have elapsed since this identity's last activity?
 * Uses the oldest non-decay-burn box as the clock start. If all boxes are
 * decay-burn boxes, uses the youngest one.
 */
export function owedPeriods(
  boxes: KarmaBox[],
  currentHeight: number,
  intervalBlocks: number,
): number {
  const normalBoxes = boxes.filter((b) => b.decayBurn !== true);
  if (normalBoxes.length === 0) {
    if (boxes.length === 0) return 0;
    const youngest = boxes.reduce((a, b) =>
      b.createdAtBlock > a.createdAtBlock ? b : a,
    );
    return Math.floor(
      (currentHeight - youngest.createdAtBlock) / intervalBlocks,
    );
  }
  const oldest = normalBoxes.reduce((a, b) =>
    b.createdAtBlock < a.createdAtBlock ? b : a,
  );
  return Math.floor(
    (currentHeight - oldest.createdAtBlock) / intervalBlocks,
  );
}

// ---------------------------------------------------------------------------
// Decay execution
// ---------------------------------------------------------------------------

export interface DecayDeps {
  getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
  consumeBox: (boxId: string, consumedAtBlock: number) => void;
  insertBox: (box: KarmaBox) => void;
  /** Return all distinct owners with unspent karma boxes. */
  getKarmaOwners: () => Uint8Array[];
}

/**
 * Apply periodic karma decay to all stale identities.
 * Called during applyOrderingBlock after UTXO transactions are applied.
 * Returns journal entries for rollback.
 */
export function applyKarmaDecay(
  deps: DecayDeps,
  currentHeight: number,
): DecayJournalEntry[] {
  const journal: DecayJournalEntry[] = [];
  const owners = deps.getKarmaOwners();

  for (const owner of owners) {
    const boxes = deps.getKarmaBoxes(owner);
    if (boxes.length === 0) continue;

    if (!isIdentityStale(boxes, currentHeight, KARMA_STALE_THRESHOLD_BLOCKS)) {
      continue;
    }

    const periods = owedPeriods(boxes, currentHeight, KARMA_DECAY_INTERVAL_BLOCKS);
    if (periods <= 0) continue;

    const totalKarma = boxes.reduce((sum, b) => sum + b.value, 0);
    const maxBurn = Math.max(0, totalKarma - KARMA_MINIMUM);
    const burnAmount = Math.min(periods * KARMA_DECAY_AMOUNT, maxBurn);
    if (burnAmount <= 0) continue;

    const newValue = totalKarma - burnAmount;

    // Consume all existing karma boxes
    const consumedBoxIds: string[] = [];
    for (const box of boxes) {
      if (box.id) {
        deps.consumeBox(box.id, currentHeight);
        consumedBoxIds.push(box.id);
      }
    }

    // Create single consolidated replacement box
    const newBox: KarmaBox = {
      boxType: 'karma',
      value: newValue,
      createdAtBlock: currentHeight,
      owner,
      guard: 'owner_signature',
      proofSource: `decay-${currentHeight}`,
      lastTouchBlock: currentHeight,
      decayBurn: true,
    };
    const boxId = computeBoxId(newBox);
    newBox.id = boxId;
    deps.insertBox(newBox);

    journal.push({ owner, consumedBoxIds, newBoxId: boxId, burnAmount });
  }

  return journal;
}
```

- [ ] **Step 2: Verify file compiles with tsc**

```bash
pnpm typecheck
```

Expected: errors in block-apply.ts (imports old constants, KARMA_DECAY_RATE etc. — Task 4), but decay.ts itself should compile if imports are correct.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/services/decay.ts
git commit -m "feat(decay): add isIdentityStale, owedPeriods, applyKarmaDecay
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Remove old decay from UTXO engine

**Files:**
- Modify: `packages/node/src/services/utxo-engine.ts`

**Interfaces:**
- Removes: `effectiveKarmaValue()`, `checkKarmaDecay()`
- Removes: decay checks from `validateTx()` and `revalidateTxInContext()`
- Removes: `KARMA_DECAY_RATE`, `KARMA_DECAY_GRACE_BLOCKS`, `KARMA_FLOOR` imports

- [ ] **Step 1: Remove decay imports and functions**

In `packages/node/src/services/utxo-engine.ts`:

**a)** Remove these lines from the imports (lines 5-6):
```typescript
  KARMA_DECAY_RATE,
  KARMA_DECAY_GRACE_BLOCKS,
```
(Keep `KARMA_FLOOR` removal if present — it may be imported alongside the others.)

**b)** Remove the entire `effectiveKarmaValue` function (lines 61-70).

**c)** Remove the entire `checkKarmaDecay` function (lines 449-502).

**d)** In `validateTx()`, remove step 7 (decay check, approximately lines 583-585):
```typescript
  // ---- 7. Karma decay ----
  const decayCheck = checkKarmaDecay(inputBoxes, tx.outputs, currentBlockHeight);
  if (!decayCheck.valid) return decayCheck;
```

**e)** In `revalidateTxInContext()`, remove the decay check (approximately lines 622-627):
```typescript
  // Check karma decay hasn't expired (height-dependent)
  const decayCheck = checkKarmaDecay(inputBoxes, tx.outputs, currentBlockHeight);
  if (!decayCheck.valid) return decayCheck;
```

- [ ] **Step 2: Verify build + typecheck**

```bash
pnpm build && pnpm typecheck
```

Expected: build clean, typecheck clean. If errors remain from constants removal, they're in other files — fix imports in those files to remove references to removed constants.

- [ ] **Step 3: Run UTXO engine tests (expect decay test failures)**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern='utxo-engine'
```

Expected: 3 decay tests fail (they reference removed functions). Other tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/utxo-engine.ts
git commit -m "feat(utxo): remove formula-based karma decay

Remove effectiveKarmaValue, checkKarmaDecay, and decay checks from
validateTx and revalidateTxInContext. Periodic burn model replaces them.
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Wire decay into block-apply

**Files:**
- Modify: `packages/node/src/services/block-apply.ts`

**Interfaces:**
- Consumes: `applyKarmaDecay`, `DecayDeps` from `./decay.js` (Task 2)
- Consumes: `DecayJournalEntry` from `@dagsocial/types` (Task 1)
- Produces: `currentJournal.decayBurns` populated during block application

- [ ] **Step 1: Add imports**

In `packages/node/src/services/block-apply.ts`, add:

```typescript
import { applyKarmaDecay } from './decay.js';
import type { DecayDeps } from './decay.js';
```

- [ ] **Step 2: Initialize `decayBurns` in journal**

In `applyOrderingBlock()`, add to the journal initialization (line 43-50):

```typescript
    decayBurns: [],
```

- [ ] **Step 3: Add decay step after UTXO transactions**

After step 10 (UTXO transaction application), add a new step. Find the section after the UTXO tx loop and before the block storage insert. Insert:

```typescript
  // 11. Apply periodic karma decay
  const decayDeps: DecayDeps = {
    getKarmaBoxes: (owner: Uint8Array) => {
      // Import getKarmaBoxes from '../store/index.js' at top of file
      return getKarmaBoxes(owner);
    },
    consumeBox,
    insertBox,
    getKarmaOwners: () => {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT DISTINCT owner FROM utxo_boxes
           WHERE box_type = 'karma' AND spent_at_block IS NULL`,
        )
        .all() as { owner: Buffer }[];
      return rows.map((r) => new Uint8Array(r.owner));
    },
  };
  const journalEntries = applyKarmaDecay(decayDeps, block.header.height);
  currentJournal.decayBurns.push(...journalEntries);
```

Also add the import at the top of the file:
```typescript
import { getKarmaBoxes } from '../store/index.js';
```

(NOTE: `getKarmaBoxes` already exists from the karma-box-selection branch. It returns all unspent karma boxes for an owner sorted by value DESC. No new store function needed — just import and use it.)

- [ ] **Step 4: Add `consumeBox` and `insertBox` to existing imports if not already present**

Verify that `consumeBox` and `insertBox` are already imported from `../store/index.js`. If not, add them. (They should already be present — they're used for UTXO tx application.)

- [ ] **Step 5: Update any import of removed constants**

If `block-apply.ts` imports `KARMA_DECAY_RATE` or `KARMA_DECAY_GRACE_BLOCKS`, remove those imports. They may be present if previously needed.

- [ ] **Step 6: Build + typecheck**

```bash
pnpm build && pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/services/block-apply.ts
git commit -m "feat(block-apply): wire periodic karma decay after UTXO tx application
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Wire decay rollback into fork-resolution

**Files:**
- Modify: `packages/node/src/services/fork-resolution.ts`

**Interfaces:**
- Consumes: `deleteBox`, `unconsumeBox` from store (existing)
- Consumes: `DecayJournalEntry` from journal (Task 1)

- [ ] **Step 1: Add decay burn reversal in `revertBlock`**

In `packages/node/src/services/fork-resolution.ts`, inside `revertBlock()`, add a new step after the karma mint reversal (step 2) and before the like box unspend (step 3). Insert after line 87:

```typescript
  // 2b. Reverse decay burns (delete new box, unconsume consumed boxes)
  for (const decay of journal.decayBurns) {
    deleteBox(decay.newBoxId);
    for (const boxId of decay.consumedBoxIds) {
      unconsumeBox(boxId);
    }
  }
```

- [ ] **Step 2: Build + typecheck**

```bash
pnpm build && pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/services/fork-resolution.ts
git commit -m "feat(fork): rollback decay burns during block revert
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Decay service tests

**Files:**
- Create: `packages/node/test/services/decay.test.ts`

**Interfaces:**
- Consumes: `isIdentityStale`, `owedPeriods`, `applyKarmaDecay` from `../src/services/decay.js` (Task 2)
- Consumes: `KARMA_STALE_THRESHOLD_BLOCKS`, etc. from `@dagsocial/types` (Task 1)

- [ ] **Step 1: Write the test file**

Create `packages/node/test/services/decay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  isIdentityStale,
  owedPeriods,
  applyKarmaDecay,
} from '../../src/services/decay.js';
import {
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { KarmaBox, DecayJournalEntry } from '@dagsocial/types';

const OWNER = new Uint8Array(32).fill(0xaa);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100,
    createdAtBlock: 0,
    owner: OWNER,
    guard: 'owner_signature',
    proofSource: 'test',
    lastTouchBlock: 0,
    id: 'box-' + Math.random().toString(36).slice(2, 8),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isIdentityStale
// ---------------------------------------------------------------------------

describe('isIdentityStale', () => {
  it('returns false for empty box list', () => {
    expect(isIdentityStale([], 1000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns false when a normal box is within threshold', () => {
    const boxes = [makeKarmaBox({ createdAtBlock: 99000 })];
    // threshold = 20160, current = 100000, age = 1000 < threshold
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns true when all normal boxes are older than threshold', () => {
    const boxes = [makeKarmaBox({ createdAtBlock: 1000 })];
    // threshold = 20160, current = 100000, age = 99000 > threshold
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('returns true when only decayBurn boxes exist', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 99999, decayBurn: true }),
    ];
    // Even though box is recent, it's decayBurn — no real activity
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('returns false with mixed old decayBurn + recent normal box', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 1000, decayBurn: true }),  // old decay
      makeKarmaBox({ createdAtBlock: 99999 }),                   // recent normal
    ];
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// owedPeriods
// ---------------------------------------------------------------------------

describe('owedPeriods', () => {
  it('returns 0 for empty box list', () => {
    expect(owedPeriods([], 1000, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(0);
  });

  it('returns correct periods for normal boxes', () => {
    // Oldest normal box at height 1000, current 3160, interval 720
    // (3160 - 1000) / 720 = 3
    const boxes = [makeKarmaBox({ createdAtBlock: 1000 })];
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
  });

  it('uses oldest normal box when multiple exist', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 2000 }),  // newer
      makeKarmaBox({ createdAtBlock: 1000 }),  // older — this one counts
    ];
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
  });

  it('uses youngest decayBurn box when all are decayBurn', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 1000, decayBurn: true }),  // older decay
      makeKarmaBox({ createdAtBlock: 2000, decayBurn: true }),  // younger decay
    ];
    // Uses youngest: (3160 - 2000) / 720 = 1
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(1);
  });

  it('ignores decayBurn boxes when normal boxes exist', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 500, decayBurn: true }),   // old decay — ignored
      makeKarmaBox({ createdAtBlock: 1000 }),                    // normal — this counts
    ];
    // Oldest normal is 1000: (3160 - 1000) / 720 = 3
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// applyKarmaDecay
// ---------------------------------------------------------------------------

describe('applyKarmaDecay', () => {
  function makeDeps(boxesMap: Map<string, KarmaBox[]>) {
    const consumed: { boxId: string; atHeight: number }[] = [];
    const inserted: KarmaBox[] = [];
    return {
      deps: {
        getKarmaBoxes: (owner: Uint8Array) => {
          const key = Buffer.from(owner).toString('hex');
          return boxesMap.get(key) ?? [];
        },
        consumeBox: (boxId: string, atHeight: number) => {
          consumed.push({ boxId, atHeight });
        },
        insertBox: (box: KarmaBox) => {
          inserted.push(box);
        },
        getKarmaOwners: () => {
          return Array.from(boxesMap.keys()).map(k => new Uint8Array(Buffer.from(k, 'hex')));
        },
      },
      consumed,
      inserted,
    };
  }

  it('does nothing for non-stale identity', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ createdAtBlock: 99999, value: 100 }),
    ]);
    const { deps, consumed, inserted } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 100000);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('burns karma for stale identity', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    // Box at height 1000, current 4000, threshold 20160 -> stale
    // periods = floor((4000-1000)/720) = 4, burn = min(4*5=20, 100-10=90) = 20
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box-1', createdAtBlock: 1000, value: 100 }),
    ]);
    const { deps } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 4000);

    expect(journal).toHaveLength(1);
    const entry = journal[0]!;
    expect(entry.burnAmount).toBe(20);
    expect(entry.consumedBoxIds).toEqual(['old-box-1']);
    expect(entry.newBoxId).toBeTruthy();
  });

  it('caps burn at KARMA_MINIMUM floor', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    // Box with 12 karma, 4 owed periods -> burn = min(20, 12-10=2) = 2
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box-1', createdAtBlock: 1000, value: 12 }),
    ]);
    const { deps } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 4000);

    expect(journal).toHaveLength(1);
    expect(journal[0]!.burnAmount).toBe(2);
  });

  it('does nothing when already at or below minimum', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box-1', createdAtBlock: 1000, value: 8 }),
    ]);
    const { deps, consumed, inserted } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 4000);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('consolidates multiple boxes into one', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'box-a', createdAtBlock: 1000, value: 50 }),
      makeKarmaBox({ id: 'box-b', createdAtBlock: 1000, value: 60 }),
    ]);
    const { deps, consumed } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 4000);

    expect(journal).toHaveLength(1);
    expect(consumed.length).toBe(2); // both old boxes consumed
    expect(consumed.map(c => c.boxId).sort()).toEqual(['box-a', 'box-b']);
  });

  it('new box has decayBurn: true', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box', createdAtBlock: 1000, value: 100 }),
    ]);
    const { deps, inserted } = makeDeps(boxesMap);

    applyKarmaDecay(deps, 4000);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.decayBurn).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern='decay\.test'
```

Expected: all 14 new tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/node/test/services/decay.test.ts
git commit -m "test(decay): isIdentityStale, owedPeriods, applyKarmaDecay tests
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Clean up old decay tests + update integration tests

**Files:**
- Modify: `packages/node/test/services/utxo-engine.test.ts` (remove 3 decay tests)
- Modify: `packages/node/test/services/block-apply.test.ts` (add decay burn journal test)
- Modify: `packages/node/test/services/fork-resolution.test.ts` (add decay burn rollback test)

- [ ] **Step 1: Remove decay tests from UTXO engine tests**

In `packages/node/test/services/utxo-engine.test.ts`, find and remove these 3 test blocks (around lines 386-465):

- "applies karma decay at consumption"
- "karma decay with grace period (young box not decayed)"
- "karma decay floor (doesn't go below KARMA_FLOOR)"

Also remove any imports of `KARMA_DECAY_RATE`, `KARMA_DECAY_GRACE_BLOCKS`, `KARMA_FLOOR` that become unused.

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern='utxo-engine'
```

Expected: all remaining tests pass, 3 fewer tests.

- [ ] **Step 2: Add decay journal test to block-apply tests**

Read `packages/node/test/services/block-apply.test.ts` to find where journal tests live. Add a test:

```typescript
it('records decay burns in journal', () => {
  // Setup: create an identity with an old karma box (stale)
  // Apply a block that triggers decay
  // Verify currentJournal.decayBurns has expected entries
});
```

Follow the existing test patterns in the file. The test should verify that when `applyOrderingBlock` processes a block at a height where an identity is stale, the journal contains `decayBurns` entries.

- [ ] **Step 3: Add decay rollback test to fork-resolution tests**

Read `packages/node/test/services/fork-resolution.test.ts`. Add a test:

```typescript
it('rolls back decay burns', () => {
  // Setup: apply a block with decay burns
  // Revert the block
  // Verify old boxes are unspent and new box is deleted
});
```

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass. Test count adjusts for removed decay tests + added tests.

- [ ] **Step 5: Commit**

```bash
git add packages/node/test/
git commit -m "test: remove old decay tests, add periodic decay tests
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Final verification + cleanup

- [ ] **Step 1: Build + typecheck + full test suite**

```bash
pnpm build && pnpm typecheck && pnpm test
```

Expected: all clean, all tests pass.

- [ ] **Step 2: Check for remaining references to removed constants**

```bash
grep -r "KARMA_DECAY_RATE\|KARMA_DECAY_GRACE_BLOCKS\|KARMA_FLOOR\|effectiveKarmaValue\|checkKarmaDecay" packages/ --include="*.ts"
```

Expected: zero results (or only in comments/specs referencing the old design).

- [ ] **Step 3: Commit any remaining cleanup**

```bash
git add -A
git commit -m "chore: final cleanup for periodic decay migration
Co-Authored-By: Claude <noreply@anthropic.com>"
```
