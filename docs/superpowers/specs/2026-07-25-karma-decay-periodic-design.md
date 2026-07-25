# Karma Decay: Periodic Burn Model

**Date:** 2026-07-25
**Status:** design
**Protocol version:** 1

## Motivation

The current decay implementation uses a spend-time formula: `effectiveValue =
box.value - floor(box.value * 0.0001 * (age - 100))`. This has three problems:

1. **It's not storage rent.** Decay reduces spendable value at transaction time
   rather than burning karma periodically like Ergo's storage rent.
2. **It's unpredictable for users.** The effective value depends on block height
   at spend time, not on elapsed time since creation. A box sitting idle for
   200 blocks might be fine today but underfunded tomorrow.
3. **It fights the UTXO model.** The formula applies a discount rather than
   consuming and recreating boxes, which is how UTXO-based systems handle value
   changes.

## Design

### Model

Periodic decay, applied at block application time:

- After 28 days of inactivity (no normal karma transactions from the owner),
  decay begins
- Every 24 hours, 5 karma is burned from the owner's aggregate karma
- Decay never reduces karma below a floor of 10
- Decay is applied by consuming all of the owner's karma boxes and creating a
  single replacement box with the reduced value
- Normal user activity (post, like, invite, transfer) resets the clock

### Provenance tracking

A new optional field `decayBurn: boolean` on `KarmaBox` distinguishes
decay-created boxes from normal-activity boxes:

```typescript
interface KarmaBox extends BoxBase {
  boxType: 'karma';
  owner: Uint8Array;
  guard: 'owner_signature';
  proofSource: string;
  lastTouchBlock: number;
  decayBurn?: boolean;  // true if this box was created by a decay burn
}
```

The staleness check (`isIdentityStale`) examines all of an owner's karma boxes.
If **any** unspent karma box has `decayBurn !== true` and a `createdAtBlock`
within the threshold, the identity is not stale — no decay applied.

A decay burn creates a box with `decayBurn: true`. This box does NOT reset the
staleness clock. The next decay cycle will see it and continue burning.

A normal user transaction creates a box without `decayBurn`. This resets the
clock — the owner is no longer stale.

### Protocol parameters

| Parameter | Default | Description |
|---|---|---|
| `KARMA_STALE_THRESHOLD_BLOCKS` | 20160 | Grace period (~28 days at 2m blocks) |
| `KARMA_DECAY_INTERVAL_BLOCKS` | 720 | Decay applied per interval (~24 hours) |
| `KARMA_DECAY_AMOUNT` | 5 | Karma burned per interval |
| `KARMA_MINIMUM` | 10 | Floor — decay never reduces below this |

Replaces: `KARMA_DECAY_RATE`, `KARMA_DECAY_GRACE_BLOCKS`, `KARMA_FLOOR`.

### Staleness check

```typescript
function isIdentityStale(
  boxes: KarmaBox[],
  currentHeight: number,
  thresholdBlocks: number,
): boolean {
  const hasRecentActivity = boxes.some(
    (b) =>
      b.decayBurn !== true &&
      b.createdAtBlock > currentHeight - thresholdBlocks,
  );
  return !hasRecentActivity;
}
```

### Owed periods

```typescript
function owedPeriods(
  boxes: KarmaBox[],
  currentHeight: number,
  intervalBlocks: number,
): number {
  // Use the oldest non-decay-burn box to determine when the clock started
  const normalBoxes = boxes.filter((b) => b.decayBurn !== true);
  if (normalBoxes.length === 0) {
    // All boxes are decay-burn boxes — use the youngest one
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
```

### Decay execution

Called during `applyOrderingBlock`, after UTXO transactions are applied:

```typescript
function applyKarmaDecay(
  currentHeight: number,
  deps: { getKarmaBoxes; consumeBox; insertBox; getIdentity; runInTransaction },
): DecayJournalEntry[] {
  const journal: DecayJournalEntry[] = [];

  // Iterate all identities that have karma boxes and check staleness
  for (const owner of getIdentitiesWithKarma()) {
    const boxes = deps.getKarmaBoxes(owner);
    if (boxes.length === 0) continue;

    if (!isIdentityStale(boxes, currentHeight, KARMA_STALE_THRESHOLD_BLOCKS)) {
      continue;
    }

    const periods = owedPeriods(boxes, currentHeight, KARMA_DECAY_INTERVAL_BLOCKS);
    if (periods <= 0) continue;

    const totalKarma = boxes.reduce((sum, b) => sum + b.value, 0);
    const burnAmount = Math.min(
      periods * KARMA_DECAY_AMOUNT,
      totalKarma - KARMA_MINIMUM,
    );
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

    // Create single replacement box
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

### Journal and rollback

`DecayJournalEntry` added to `BlockJournal`:

```typescript
interface DecayJournalEntry {
  owner: Uint8Array;
  consumedBoxIds: string[];
  newBoxId: string;
  burnAmount: number;
}

interface BlockJournal {
  // ... existing fields ...
  decayBurns: DecayJournalEntry[];
}
```

On revert: for each entry, delete `newBoxId` (the decay-created box), unconsume
all `consumedBoxIds`. Standard journal reversal pattern.

### What gets removed

- `effectiveKarmaValue()` function from `utxo-engine.ts`
- `checkKarmaDecay()` function from `utxo-engine.ts`
- Decay checks in `validateTx()` (step 7) and `revalidateTxInContext()`
- `KARMA_DECAY_RATE`, `KARMA_DECAY_GRACE_BLOCKS`, `KARMA_FLOOR` from `constants.ts`
- 3 UTXO engine decay tests
- `KARMA_DECAY_RATE` and `KARMA_DECAY_GRACE_BLOCKS` imports in `utxo-engine.ts`

`lastTouchBlock` stays on `KarmaBox` — it's set on creation and represents
the box's birth block, still useful for general age queries.

### Implications

**`computeBoxId`:** The `decayBurn` field is included in CBOR serialization
when computing the box ID. Boxes with `decayBurn: true` will have a different
ID than identical boxes without it — this is correct, they are different boxes.
The field is `undefined` (absent from CBOR) for normal boxes and `true` for
decay boxes.

**Client API:** The `GET /karma/:userId` response does NOT include `decayBurn`.
The field is internal. The `boxes[]` array already returns `{ boxId, value }` —
no change needed.

**Demo UI:** No changes. The client doesn't need to know about decay burn
tracking.

**Mint paths:** `mintKarma` and `mintCredits` continue to produce boxes without
`decayBurn` (normal boxes). Epoch rewards, like refunds, and post-lock returns
all create normal boxes and reset the decay clock.

**Fork resolution:** Existing journal entries (`karmaMints`) are unchanged.
The new `decayBurns` array follows the same consume/insert pattern and reverses
the same way.

**Performance:** `getIdentitiesWithKarma()` is a new store query. With the
current `utxo_boxes` table, it's:

```sql
SELECT DISTINCT owner FROM utxo_boxes
 WHERE box_type = 'karma' AND spent_at_block IS NULL
```

For small-scale social networks this is fine (hundreds to low thousands of
identities). If it becomes a bottleneck, a `karma_owners` index or materialized
view can be added later.

### Constants changes

```typescript
// Removed:
// export const KARMA_DECAY_RATE = 0.0001;
// export const KARMA_DECAY_GRACE_BLOCKS = 100;
// export const KARMA_FLOOR = 0;

// Added:
export const KARMA_STALE_THRESHOLD_BLOCKS = 20160;
export const KARMA_DECAY_INTERVAL_BLOCKS = 720;
export const KARMA_DECAY_AMOUNT = 5;
export const KARMA_MINIMUM = 10;
```

## Testing

### Staleness check unit tests

- Identity with 0 karma boxes → not stale (no-op)
- Identity with recent normal box (`createdAtBlock` within threshold) → not stale
- Identity with only old normal boxes (all `createdAtBlock` past threshold) → stale
- Identity with only `decayBurn` boxes → stale (no normal activity boxes)
- Identity with old `decayBurn` box + recent normal box → not stale

### Owed periods unit tests

- No normal boxes, youngest decay-burn box is 2160 blocks old → 3 periods
- Normal box is 1440 blocks old → 2 periods
- Normal box is 500 blocks old → 0 periods

### Decay execution unit tests

- Stale identity with 100 karma, 3 owed periods → burns 15, new box has 85
- Stale identity with 15 karma, 3 owed periods → burns 5 (down to KARMA_MINIMUM 10)
- Stale identity with 8 karma, any periods → no burn (already below minimum)
- Decay creates single consolidated box with `decayBurn: true`
- All previous boxes are consumed (spent)
- Journal entry records correct consumed/new IDs

### Journal/rollback tests

- Decay burn reverted: new box deleted, old boxes unspent

### Integration tests

- Full block application includes decay step
- Identity with no activity for 28+ days sees karma reduced
- Identity with recent post is not decayed
