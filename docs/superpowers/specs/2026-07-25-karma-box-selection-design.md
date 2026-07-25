# Karma Box Multi-UTXO Selection

**Date:** 2026-07-25
**Status:** design
**Protocol version:** 1

## Motivation

Karma boxes can accumulate from multiple sources: faucet grants, invite claims,
epoch rewards (which *do* merge via `mintKarma`), and any future paths that
produce karma outputs for an owner who already has one.

Today `getKarmaBox(owner)` returns only the first unspent box via `LIMIT 1`
with no `ORDER BY`. The API and all server-side spend paths (posts, likes,
invites) see at most one box per owner. Secondary boxes are invisible pockets
of karma that can't be spent.

This isn't a model problem — multiple UTXOs per identity is the expected
UTXO design. The fix is proper multi-UTXO selection, not forced merging.

## Design

### Approach

Replace single-box blind picks with largest-first multi-box selection across
all server-side karma spend paths. No new invariants, no transaction
augmentation, no forced merging. Just proper UTXO handling.

### API change: `GET /karma/:userId`

```typescript
// Current
{ boxId: string; value: number }

// New
{
  total: number;
  boxes: { boxId: string; value: number }[];  // value DESC
}
```

The client can still build transactions referencing a single box — this is
purely a visibility improvement. The server provides the full picture.

### New pure function: `selectBoxes` (`@dagsocial/types`)

```typescript
/**
 * Largest-first UTXO selection. Returns the minimal subset of boxes whose
 * combined effective value covers `requiredAmount`. Throws if total is
 * insufficient.
 *
 * Assumes boxes are pre-sorted by value descending.
 */
function selectBoxes<T extends { value: number }>(
  boxes: T[],
  requiredAmount: number,
  effectiveValue?: (box: T) => number
): T[]
```

- Generic over any box-like type with a `value` field.
- `effectiveValue` is optional — for karma boxes it's the decay-adjusted value
  via `effectiveKarmaValue`. Defaults to `box.value`.
- Largest-first minimizes UTXO count per spend.
- Throws on insufficient total.

Lives alongside `computeBoxId` / `computeTxId` in the types package. Pure, no
dependencies.

### Store changes (`@dagsocial/node`)

- **Drop** `getKarmaBox(owner)` — replaced by `getKarmaBoxes`.
- **Add** `getKarmaBoxes(owner): KarmaBox[]` — all unspent karma boxes for an
  owner, `ORDER BY value DESC`. Only returns unspent boxes.
- **Add** `getCreditBoxes(owner): CreditBox[]` — same pattern for credits,
  for consistency and future use (currently credits don't need multi-box
  selection but the symmetry is free).

No schema changes. No migration.

### Server-side spend paths

Each path that currently does `const box = getKarmaBox(owner)` switches to:

```typescript
const boxes = getKarmaBoxes(owner);
const selected = selectBoxes(boxes, requiredAmount, effectiveKarmaValue);
// selected[] listed as inputs in the UTXO transaction
// single karma output = sum(effectiveValues) - spent
```

Paths affected:

| Path | Required amount | Notes |
|------|----------------|-------|
| Post creation | `POST_LOCK_THREAD_COST` (5) or `POST_LOCK_REPLY_COST` (3) | Locked karma held in PostLockBox |
| Like cast | `LIKE_COST` (2) | LikeBox holds the karma |
| Invite creation | `INVITE_BOND_KARMA` (25) | BondBox holds the karma |
| Invite cancel | N/A (all boxes refunded) | Inputs listed explicitly; selection not needed |

### Decay interaction

`effectiveKarmaValue` adjusts each box's spendable value based on age.
Largest-first selection works correctly with decay because the effective
value is used for coverage checks, not the nominal value. A large box near
expiry may have less effective value than a smaller fresh box — that's fine,
sorting stays nominal (value desc) and the effective value drives the
coverage calculation.

The output box always gets `createdAtBlock` set to the current block height,
resetting the decay clock on the consolidated balance.

### What doesn't change

- **Client-built transactions** are unaffected. The client references
  specific box IDs; if it only knows about one, that's a client concern.
- **`mintKarma()`** keeps its existing merge behavior (consumes old, creates
  new sum). With multi-box selection this becomes a consistency check rather
  than the sole merge path.
- **Invariant:** at most one unspent karma box per owner is NOT enforced.
  Multiple boxes are fine and expected.
- **UTXO engine validation** (`checkTransitions`) is unchanged. It already
  handles multiple karma inputs from the same owner.

### Rollback safety

The fork-resolution journal already tracks `karmaMints` by box ID. No change
needed — `selectBoxes` is a read-side concern; the journal records what was
actually consumed and created during `applyTx`, which already handles multiple
inputs atomically.

## Testing

### Unit tests (`@dagsocial/types`)

- `selectBoxes` with exact match from one box
- `selectBoxes` with largest-first spanning multiple boxes
- `selectBoxes` with insufficient total — throws
- `selectBoxes` with empty array — throws if `requiredAmount > 0`
- `selectBoxes` with `requiredAmount = 0` — returns empty array
- `selectBoxes` with `effectiveValue` override (decay scenario)

### Store tests (`@dagsocial/node`)

- `getKarmaBoxes` returns all unspent boxes for owner, sorted value desc
- `getKarmaBoxes` returns empty array for unknown owner
- `getKarmaBoxes` excludes spent boxes
- `getCreditBoxes` same pattern

### UTXO engine tests

- Post creation selects multiple karma boxes to cover lock cost
- Like cast selects multiple boxes
- Invite creation selects multiple boxes
- Spend that produces a single consolidated output with correct value
