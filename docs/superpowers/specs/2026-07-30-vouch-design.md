# Vouch System Design

**Date:** 2026-07-30
**Status:** design

## Motivation

Followers are an offchain/offline concept — there is no on-chain mechanism to
apply weights to authors based on popularity. The vouch system provides a
cryptographic endorsement primitive: an identity stakes 1 karma to another
identity, creating a verifiable on-chain record that clients and indexers can
aggregate into reputation graphs, trust scores, or feed ranking signals.

The node's job is to faithfully record, validate, and serve vouch data.
Interpretation — ranking, curation, reputation scoring — is the responsibility
of client implementations and indexers. See `contracts/ARCHITECTURE.md` § Design
Principles.

## Design

### VouchBox

A new UTXO box type representing a 1-karma endorsement from one identity to
another.

```
VouchBox {
  id: BoxId
  boxType: 'vouch'
  value: 1                          // always 1 karma
  createdAtBlock: number
  voucherId: UserId                 // who staked the karma
  targetId: UserId                  // who is being vouched for
  guard: 'owner_signature'          // voucher controls spend
}
```

Properties:
- **Boolean relationship:** one VouchBox per (voucher, target) pair at a time.
- **1 karma locked:** always exactly 1, always from the voucher's KarmaBox.
- **Guard:** `owner_signature` — only the voucher can unvouch. The target cannot
  reject or remove a vouch.
- **No activity effect:** creating a vouch does NOT reset the staleness clock.
- **No decay interaction:** the locked karma is in the VouchBox, not the
  KarmaBox, so it is excluded from decay burns.

### Protocol constants

| Constant | Value | Meaning |
|---|---|---|
| `VOUCH_KARMA_AMOUNT` | 1 | Karma locked per vouch |
| `VOUCH_MIN_BALANCE` | 11 | Must have ≥11 karma to vouch |
| `VOUCH_COOLDOWN_BLOCKS` | 60 | Blocks before karma returned + re-vouch allowed |

`VOUCH_MIN_BALANCE` ensures a voucher at the decay floor (10 karma) cannot
vouch. Someone with ≥11 karma locks 1 in the VouchBox, leaving ≥10 in their
KarmaBox — enough to post (1 karma min) and like (2 karma to lock).

### Lifecycle

#### Vouch

1. Client builds UTXO transaction: `KarmaBox → KarmaBox (change, −1) + VouchBox`
2. Client signs, submits to node
3. Node validates:
   - Voucher has ≥ `VOUCH_MIN_BALANCE` karma across unspent KarmaBoxes
   - No existing unspent VouchBox for (voucher, target)
   - No active cooldown row for (voucher, target)
   - targetId is a valid 32-byte public key
   - Signature is valid
4. On block inclusion: `applyTx` consumes KarmaBox, inserts KarmaBox change +
   VouchBox

#### Unvouch (initiate)

1. Client builds UTXO transaction: `VouchBox → (none)`
2. Client signs, submits to node
3. Node validates:
   - VouchBox exists, is unspent, guard satisfied (voucher signature)
4. On block inclusion: `applyTx` consumes VouchBox, inserts cooldown row:
   `(voucherId, targetId, releaseAtBlock = currentHeight + 60, karmaAmount = 1)`
5. Karma is now in escrow — locked during the 60-block cooldown

#### Maturation (block application)

At each block application, same layer as decay processing:

1. `processVouchCooldowns(currentHeight)`: SELECT rows where
   `releaseAtBlock <= currentHeight`
2. For each matured row: `mintKarma(voucherId, karmaAmount)` — consolidates
   karma back into the voucher's KarmaBox
3. DELETE matured cooldown rows
4. Re-vouch for the pair is now allowed

### Cooldown table

A new SQLite table:

```sql
CREATE TABLE vouch_cooldowns (
    voucher_id BLOB NOT NULL,       -- 32-byte UserId
    target_id BLOB NOT NULL,        -- 32-byte UserId
    release_at_block INTEGER NOT NULL,
    karma_amount INTEGER NOT NULL,
    PRIMARY KEY (voucher_id, target_id)
);
```

Serves double duty:
- **Karma escrow:** holds the 1 karma until `releaseAtBlock`
- **Re-vouch gate:** the presence of a row blocks new vouches for the pair

### UTXO transition rules

| Consumed | Created | Condition |
|---|---|---|
| KarmaBox | KarmaBox + VouchBox | Same owner, vouch (1 VouchBox output) |
| VouchBox | (none) | Unvouch, proceeds held in cooldown table |

No new guard type — VouchBox uses the existing `owner_signature` guard (same as
KarmaBox).

Value conservation: karma types are exempt from strict value conservation
(same as existing LikeBox, PostLockBox, InviteBox pattern).

### Re-vouch gate

Checked at vouch submission time. Reject if ANY of:
- An unspent VouchBox exists for `(voucherId, targetId)`
- A cooldown row exists for `(voucherId, targetId)`
- Voucher has < `VOUCH_MIN_BALANCE` karma

## API

All endpoints return JSON. Signed UTXO transactions are submitted as CBOR blobs
(base64-encoded on the wire).

### `POST /api/v1/vouches`

Create a vouch. Body: signed UTXO transaction (KarmaBox → KarmaBox + VouchBox).

Response: `{ status: 'pending', txId: string, expiresAtHeight: number }`

Errors: `400` (insufficient karma, pair already vouched/cooldown, invalid
target), `422` (signature/transaction validation failure).

### `DELETE /api/v1/vouches/:targetId`

Initiate unvouch. Body: signed UTXO transaction (VouchBox → none).

Response: `{ status: 'pending', txId: string, expiresAtHeight: number, karmaReturnsAtBlock: number }`

Errors: `404` (no VouchBox for pair), `422` (signature/validation failure).

### `GET /api/v1/vouches?target=<userId>`

Who vouches for this identity. Returns all unspent VouchBoxes targeting the
given userId.

Response: `{ vouches: [{ voucherId: string, targetId: string, createdAtBlock: number }], count: number }`

### `GET /api/v1/vouches?voucher=<userId>`

Who this identity vouches for. Returns all unspent VouchBoxes created by the
given userId.

Response: `{ vouches: [{ voucherId: string, targetId: string, createdAtBlock: number }], count: number }`

### `GET /api/v1/vouches/cooldowns?voucher=<userId>`

Active cooldowns for this identity. Returns all cooldown rows where karma has
not yet been returned.

Response: `{ cooldowns: [{ targetId: string, releaseAtBlock: number }] }`

## Implementation surface

### `@dagsocial/types`

- `VouchBox` interface + `VouchBoxData` in `utxo.ts`
- Add `'vouch'` to `BoxType` union, `AnyBox` union
- `VOUCH_KARMA_AMOUNT`, `VOUCH_MIN_BALANCE`, `VOUCH_COOLDOWN_BLOCKS` in
  `constants.ts`

### `@dagsocial/node`

- **Store:** `vouch_cooldowns` table migration, `insertVouchCooldown()`,
  `getVouchCooldowns()`, `getMaturedVouchCooldowns()`, `deleteVouchCooldown()`,
  serialization cases in `rowToBox()` / `insertBox()`
- **Service:** `packages/node/src/services/vouch.ts` — `castVouch(tx)`,
  `initiateUnvouch(tx)`
- **UTXO engine:** transition rule (KarmaBox → KarmaBox + VouchBox), guard
  check (VouchBox uses existing `owner_signature`), value conservation
- **Block apply:** `processVouchCooldowns(currentHeight)` — matures cooldowns,
  calls `mintKarma()`
- **Routes:** `packages/node/src/routes/vouches.ts` — POST, DELETE, GET
  handlers
- **Mempool:** no schema change needed — VouchBox is carried inside a `utxo_tx`
  entry, same pattern as LikeBox

### `@dagsocial/validation`

- Stateless: `isValidVouchTarget(userId)` — valid 32-byte public key
- The ≥ `VOUCH_MIN_BALANCE` check is stateful, lives in the node service

### Contracts

- `ARCHITECTURE.md` — add VouchBox to UTXO box type table, note cooldown
  processing in block application section
- `NODE_INTERFACE.md` — vouch API endpoints, cooldown processing, store
  interface
- `TYPES_INTERFACE.md` — VouchBox type, constants

### No changes to

- **`@dagsocial/net`:** gossip handles UTXO transactions generically
- **Block creator:** VouchBox transactions flow through the existing UTXO tx
  pool; the block creator already includes all pending UTXO txs
- **Epoch tally:** vouches don't interact with likes or post locks
- **Prune settlement:** VouchBoxes aren't tied to posts — they persist
  independently

## Edge cases

### Voucher drops below KARMA_MINIMUM

If a voucher has 11 karma, vouches (locks 1), and then their KarmaBox drops
from 10 to below KARMA_MINIMUM (10) due to posting, liking, or decay — the
VouchBox's 1 karma still counts as theirs, but it's locked. Decay can still
burn the KarmaBox down to 10 (the minimum). The VouchBox is unaffected.

### Target identity is unknown

Vouching for a public key that has never appeared on-chain is allowed. The
VouchBox is created; if the target later appears, the vouch is there waiting.
This is an intentional design choice — anyone can vouch for anyone.

### Vouch → unvouch → re-vouch cycle

The full cycle:
1. Vouch: KarmaBox (−1) + VouchBox created
2. Unvouch: VouchBox consumed, cooldown row inserted (60 blocks)
3. After 60 blocks: karma returned via `processVouchCooldowns`
4. Voucher can now vouch the same target again

Minimum cycle time: 60 blocks (~1h at 60s blocks). The cooldown prevents
vouch/unvouch spam because karma stays locked for the full duration.

### Multiple vouches by one identity

Blocked by the one-per-pair constraint + re-vouch gate. An identity can vouch
for many different targets (each 1 karma locked), but only once per target.

### Unvouch during chain reorg

Cooldown rows are subject to the same fork-resolution rollback as other state.
If the block containing the unvouch is reorged out, the VouchBox reappears
(consumed → unspent) and the cooldown row is removed. Reorg handling follows
the existing pattern in `revertBlock()`.

## Testing

- **Unit:** VouchBox serialization, cooldown table CRUD, `processVouchCooldowns`
  logic, re-vouch gate logic
- **UTXO engine:** transition validation (valid + invalid transitions), guard
  satisfaction, value conservation
- **API:** HTTP endpoint responses, error cases, signature validation
- **Integration:** vouch → block inclusion → unvouch → cooldown maturation →
  re-vouch, karma balance assertions at each step
- **E2E:** multi-node vouch/unvouch cycle, cooldown maturation after block
  advancement, reorg safety
