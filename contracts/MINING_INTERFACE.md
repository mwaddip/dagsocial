# MINING Interface Contract

**Component:** `@dagsocial/node` (mining subsystem)
**Protocol version:** 2
**Last updated:** 2026-07-23

## Scope

Mining subsystem for ordering blocks. Owns: credit emission schedule, coinbase
structure, PoW verification for ordering blocks, difficulty adjustment, mining
API endpoints (template + submit). Depends on:

- `@dagsocial/types` — data structures, constants, hashing
- `@dagsocial/validation` — stateless PoW verification
- `@dagsocial/node` — store (block persistence, UTXO), block creator, config

## Emission Schedule

Ergo-style linear decay with flat tail. At 60-second blocks:

| Parameter | Blocks | Duration |
|-----------|--------|----------|
| Fixed-rate period | 1,051,200 | ~2 years |
| Epoch (reduction interval) | 129,600 | ~90 days |
| Tail period | 9,132,672 | ~17.4 years |
| **Total** | **16,663,872** | **~31.7 years** |

| Parameter | Value | Description |
|-----------|-------|-------------|
| `CREDIT_INITIAL_REWARD` | 100 | Credits per block in fixed-rate period |
| `CREDIT_REWARD_REDUCTION` | 2 | Credits reduced per epoch |
| `CREDIT_TAIL_REWARD` | 2 | Flat reward after emission ends |
| `CREDIT_MINER_REWARD_DELAY` | 720 | Blocks before coinbase can be spent (~12h) |
| `CREDIT_TREASURY_PCT` | 10 | Percent of each reward to treasury |

**Reward function:**

```
computeBlockReward(height):
  if height == 0: return 0
  if height <= CREDIT_FIXED_RATE_BLOCKS:
    return CREDIT_INITIAL_REWARD                    // 100
  epochs = floor((height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS) + 1
  reward = CREDIT_INITIAL_REWARD - epochs × CREDIT_REWARD_REDUCTION
  if reward <= CREDIT_TAIL_REWARD:
    return CREDIT_TAIL_REWARD                       // 2
  return reward
```

**Total supply:** ~453.9M credits (triangular decay area + tail).

**Treasury split:** `treasuryAmount = floor(reward × CREDIT_TREASURY_PCT / 100)`,
`minerAmount = reward - treasuryAmount`. Treasury output is omitted if no
treasury public key is configured.

## Ordering Block (extended)

Additions to the existing `OrderingBlock` type:

| Field | Type | Description |
|-------|------|-------------|
| `powNonce` | `number` | PoW solution (nonce that satisfies target) |
| `powTargetBits` | `number` | Difficulty target for this block |
| `coinbaseOutputs` | `CoinbaseOutput[]` | Block reward distribution |

### CoinbaseOutput

| Field | Type | Description |
|-------|------|-------------|
| `owner` | `Uint8Array` (32 bytes) | Recipient public key |
| `value` | `number` | Credits minted |
| `lockedUntilBlock` | `number` | Height at which credits become spendable |
| `isTreasury` | `boolean` | Treasury or miner output |

### Block hash

The block hash covers all fields except `validatorSignature`. PoW solves for
`hash(blockBody || powNonce)`, where `blockBody` is the CBOR-serialized block
with `powNonce=0`. This avoids re-serializing the entire block each iteration.

## PoW Verification

```ts
verifyOrderingBlockPoW(block: OrderingBlock): boolean
```

Same algorithm as `verifyPoW` (blake2b512 → 32 bytes, check leading zero bits):

1. Build `bodyBytes` = CBOR-serialize block with `powNonce=0`, `validatorSignature` zeroed
2. `hash = blake2b512(bodyBytes || encodeLE64(block.powNonce)).subarray(0, 32)`
3. Count leading zero bits in `hash` ≥ `block.powTargetBits`

## Difficulty Adjustment

Recalculated at each epoch boundary (every `CREDIT_EPOCH_BLOCKS`):

```ts
newTarget = Math.round(prevTarget × actualDuration / expectedDuration)
// clamp to ±50% of prevTarget
```

The adjustment uses the previous epoch's start timestamp and target, both stored
in the block header. The first block after an epoch boundary carries the new
target.

## Mining API

Only exposed when `nodeRole === 'miner'`.

### GET /mining/template

Returns the current block template. The block creator assembles this on a timer
(60s default) and whenever a sub-block arrives.

**Response (200):**
```json
{
  "height": 123,
  "prevBlockHash": "hex(32)",
  "subBlockRefs": ["hex(32)", ...],
  "likeBoxIds": ["hex(32)", ...],
  "utxoTxIds": [],
  "stumpIds": [],
  "coinbaseOutputs": [
    { "owner": "hex(32)", "value": 90, "lockedUntilBlock": 843, "isTreasury": false },
    { "owner": "hex(32)", "value": 10, "lockedUntilBlock": 843, "isTreasury": true }
  ],
  "powTargetBits": 20,
  "protocolVersion": 1,
  "createdAt": 1234567890000,
  "bodyHash": "hex(32)"
}
```

`bodyHash` is `blake2b512(blockBody).subarray(0, 32).toString('hex')` — the
preimage the miner hashes with the nonce. The miner never touches CBOR.

### POST /mining/submit

Submits a solved nonce.

**Request:**
```json
{
  "height": 123,
  "powNonce": 456789
}
```

**Response (201):**
```json
{
  "blockHash": "hex(32)",
  "height": 123
}
```

**Errors:**
- 400: missing fields
- 409: height mismatch with current template
- 422: PoW invalid

On success, the node assembles the final block (inserts `powNonce`, signs with
validator key), stores it, broadcasts it, and applies coinbase mints.

## Coinbase Application

### On block creation (miner):
1. `reward = computeBlockReward(height)`
2. Split into miner + treasury outputs
3. Include `CoinbaseOutput[]` in block
4. After block storage: for each output, mint credits via `mintCredits(owner, value, lockedUntilBlock)` — creates or increases a `CreditBox` in the UTXO set

### On block receipt (relay node):
1. Verify PoW
2. Verify `sum(coinbaseOutputs.map(o => o.value)) === computeBlockReward(height)`
3. Verify treasury split matches `CREDIT_TREASURY_PCT`
4. For each output, mint credits
5. Coinbase outputs with `lockedUntilBlock > currentHeight` are stored but not spendable — the UTXO engine enforces this during transaction validation

## Config

| Variable | Default | Purpose |
|----------|---------|---------|
| `MINING_MODE` | `internal` | `internal` (mine in-process) or `external` (expose template API) |
| `ORDERING_BLOCK_POW_TARGET_BITS` | `12` | Initial PoW difficulty (12 bits = fast on CPU, ~4K hashes) |
| `CREDIT_INITIAL_REWARD` | `100` | Credits per block in fixed-rate period |
| `CREDIT_TREASURY_PCT` | `10` | Percent to treasury |
| `TREASURY_PUBKEY` | `""` | Hex-encoded 32-byte Ed25519 public key (empty = no treasury) |

Default targetBits of 12 is intentionally low for development (expected ~2K
hashes, sub-second on modern CPU). Production would use 30+.

## Invariants

1. Coinbase value per block matches `computeBlockReward(height)` exactly
2. Treasury split matches `CREDIT_TREASURY_PCT` when treasury key is configured
3. Coinbase outputs cannot be spent before `lockedUntilBlock`
4. `powTargetBits` ≥ 4 (sanity floor — any lower is effectively zero-work)
5. Difficulty adjustment is clamped to ±50% per epoch
6. Block hash covers PoW fields — changing `powNonce` or `powTargetBits` invalidates the block
7. Old blocks verify against their declared difficulty, not current difficulty

## Miner Script

`packages/node/scripts/miner.js` — standalone Node.js process:

1. `GET /mining/template` → `{ bodyHash, powTargetBits, height }`
2. Loop: `nonce++`, `hash = blake2b512(hex2buf(bodyHash) || encodeLE64(nonce))`, check leading zeros
3. `POST /mining/submit` with `{ height, powNonce }`
4. Repeat

Config via env: `NODE_URL` (default `http://localhost:3000`), `THROTTLE_MS`
(default 0 = full speed). Throttling inserts `setTimeout` between batches for
CPU-friendly mining during development.
