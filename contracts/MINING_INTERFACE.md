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

### Block hash and PoW preimage (header model)

The block hash is `blockHash(header)` — the header alone commits to the whole
block transitively (`subBlockRoot` / `utxoTxRoot` / `stateRoot`), see
`TYPES_INTERFACE.md`. PoW is likewise header-only:

```
powPreimage = computePowHash(header)
            = blake2b512(encodeHeader({ ...header, powNonce: 0 }))[:32]
```

The miner iterates the nonce against this fixed 32-byte preimage — no
re-serialization per iteration, and the miner never touches CBOR.

## PoW Verification

```ts
verifyOrderingBlockPoW(header: BlockHeader): boolean
```

1. Guard: header is encodable, `powNonce`/`powTargetBits` are safe u64s
   (no-panic — returns `false`, never throws)
2. `preimage = computePowHash(header)` (as above)
3. `hash = blake2b512(preimage || encodeLE64(header.powNonce)).subarray(0, 32)`
4. Count leading zero bits in `hash` ≥ `header.powTargetBits`

## Difficulty Schedule

`powTargetBits` is a **deterministic function of block height** — never of wall
clock. On-chain time is block height (ARCHITECTURE invariant), so the difficulty
target may not depend on `Date.now()` or a header timestamp, and every node must
compute the same expected target for a given height, for all time.

Phase 1 uses a **fixed target**:

```ts
expectedTarget(height) = ORDERING_BLOCK_POW_TARGET_BITS   // constant, Phase 1
```

There is no wall-clock retargeting. Rationale: the previous scheme
(`prevTarget × actualDuration / expectedDuration`, clamped ±50%) fired only every
`CREDIT_EPOCH_BLOCKS` (~90 days) and made the target a function of local wall
time, so two honest nodes could compute different targets and a miner could
self-declare a floor target for near-free blocks. A real hashrate-tracking
retarget needs a deterministic on-chain time source (e.g. median-of-header-
timestamps with future bounds); that is deferred, and ordering-block difficulty
is expected to evolve (possibly karma-proportional) in a later phase. Until then
the target is fixed by schedule and enforced.

**Enforcement (apply — all paths: gossip, sync, reorg):** a block whose
`header.powTargetBits !== expectedTarget(height)` is rejected. This is a consensus
check, not a sanity floor — the target is fixed by schedule, not miner-chosen.

## Mining API

**Exposure (audit M-7):** the `/mining` routes are mounted **only** when
`nodeRole === 'miner'` **and** `miningMode === 'external'`. Internal mining is
in-process and exposes no mining HTTP surface at all. On any other
configuration the paths simply do not exist (404 from the server).

**Authentication (audit M-7):** external mining REQUIRES a configured,
non-empty `MINING_SECRET` — a miner node with `MINING_MODE=external` and an
empty secret **fails at startup** with a configuration error; there is no
unauthenticated passthrough mode. Every `/mining/*` request must carry
`Authorization: Bearer <MINING_SECRET>`; the comparison is constant-time
(`crypto.timingSafeEqual` over length-guarded buffers). Missing or wrong
credentials → 401, before any handler logic (including `?miner=`).

### GET /mining/template

Returns the current block template. The block creator assembles this on a timer
(60s default) and whenever a sub-block arrives.

`?miner=<hex(32)>` (authenticated, optional): sets the coinbase payout pubkey
used for subsequently assembled templates. Invalid hex → 400. Because auth
precedes it, only a holder of the mining secret can redirect the coinbase.

**Response (200):**
```json
{
  "header": {
    "protocolVersion": 1,
    "height": 123,
    "prevBlockHash": "hex(32)",
    "subBlockRoot": "hex(32)",
    "utxoTxRoot": "hex(32)",
    "stateRoot": "hex(32)",
    "validatorId": "hex(32)",
    "powTargetBits": 20,
    "createdAt": 1234567890000
  },
  "subBlockRefs": ["hex(32)", ...],
  "subBlockEntries": [{ "postId": "hex(32)", "parentRefs": ["hex(32)"], "author": "hex(32)" }, ...],
  "pruneEntries": [...],
  "likeBoxIds": ["hex(32)", ...],
  "utxoTxIds": [],
  "coinbaseOutputs": [
    { "owner": "hex(32)", "value": 90, "lockedUntilBlock": 843, "isTreasury": false },
    { "owner": "hex(32)", "value": 10, "lockedUntilBlock": 843, "isTreasury": true }
  ],
  "powPreimage": "hex(32)"
}
```

`powPreimage` is `computePowHash(header)` (see "Block hash and PoW preimage") —
the fixed 32-byte preimage the miner hashes with the nonce. The miner never
touches CBOR. 404 when no template is available yet.

### POST /mining/submit

Submits a solved nonce. The node rebuilds the block from its own stored
template — the request carries **only** `{ height, powNonce }`, so an external
miner cannot substitute entries, coinbase outputs, or any body content.

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
- 401: missing/wrong bearer token
- 400: missing fields
- 422: PoW invalid or template stale (height no longer matches the current template)

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

| Variable | Class | Default | Purpose |
|----------|-------|---------|---------|
| `MINING_MODE` | operational | `internal` | `internal` (mine in-process, no mining HTTP surface) or `external` (expose the authenticated template API) |
| `MINING_SECRET` | operational | — | Bearer token for the mining API. **Required non-empty when `MINING_MODE=external` on a miner node — startup fails otherwise.** Ignored (routes unmounted) in internal mode. There is no unauthenticated mode. |
| `ORDERING_BLOCK_POW_TARGET_BITS` | **consensus** | `12` | Initial PoW difficulty (12 bits = fast on CPU, ~4K hashes) |
| `CREDIT_INITIAL_REWARD` | **consensus** | `10000000000` | Credits per block in fixed-rate period, in **base units of 10⁻⁸** (= 100 credits) |
| `CREDIT_TREASURY_PCT` | **consensus** | `10` | Percent to treasury |
| `TREASURY_PUBKEY` | **consensus** | `""` | Hex-encoded 32-byte Ed25519 public key (empty = no treasury) |

Classes are defined in `NODE_INTERFACE.md → Configuration`. A `consensus` variable
**MUST NOT be readable from the environment** — two nodes differing on one of these
partition permanently.

> ⚠ **`ORDERING_BLOCK_POW_TARGET_BITS` is currently environment-readable, and this
> section previously told operators to change it.** The removed sentence read
> *"Production would use 30+"* — an operator following it while the network ran the
> default would have forked themselves off at the first block. The default of 12 is
> intentionally low for development (~2K hashes, sub-second on a modern CPU); raising
> it for production is a **network-wide coordinated change**, not a deployment
> setting. See invariant 7.

## Invariants

1. Coinbase value per block matches `computeBlockReward(height)` exactly
2. Treasury split matches `CREDIT_TREASURY_PCT` when treasury key is configured
3. Coinbase outputs cannot be spent before `lockedUntilBlock`, and every coinbase
   output's `lockedUntilBlock` **equals `height + CREDIT_MINER_REWARD_DELAY`** —
   enforced at apply on all paths (gossip, sync, reorg), not only in the gossip
   validator. A block with any other coinbase lock is rejected.
4. `powTargetBits` **equals `expectedTarget(height)`** (a deterministic function of
   height), enforced at apply on all paths — not a self-declared value with a
   sanity floor. A mismatch rejects the block.
5. Difficulty is height-deterministic; there is no wall-clock adjustment.
6. Block hash covers PoW fields — changing `powNonce` or `powTargetBits` invalidates the block
7. Old blocks verify against the scheduled difficulty for their height; since the
   schedule is a pure function of height, that is the same value on every node and
   for all time.

> ⚠ **VIOLATED — invariants 4, 5 and 7. The rules are correct; the implementation is not.**
> `expectedTarget(_height)` **discards its height argument** and returns
> `config.orderingBlockPowTargetBits`, a per-process environment value. Two consequences,
> and the second is the worse one:
>
> 1. **Cross-node.** Two nodes with different `ORDERING_BLOCK_POW_TARGET_BITS` reject each
>    other's blocks on *every* block — a permanent partition from the first block after
>    divergence, not a reorg.
> 2. **Retroactive.** Because height is ignored, changing the value re-targets *history*:
>    on the next resync, reorg, or restart-and-revalidate, every previously-accepted block
>    is re-checked against the new value and rejected. Invariant 7's "the same value on
>    every node and for all time" is precisely what does not hold. A schedule keyed to
>    height would have that property; a constant read from the environment cannot.
>
> These invariants are **kept as written** — they state the intended rule, and Phase 2
> makes them true. Do not weaken them to match the code.
8. The mining API is never served unauthenticated: external mode requires a
   configured `MINING_SECRET` (enforced at startup, not per-request), every
   request is bearer-authenticated with a constant-time comparison, and the
   coinbase payout override (`?miner=`) is reachable only behind that auth.
   Internal mode mounts no mining routes. (audit M-7)

## Miner Script

`packages/node/scripts/miner.mjs` — standalone Node.js process (the only miner
script; deployed via `scripts/dagsocial-miner.service`):

1. `GET /mining/template` (Bearer `MINING_SECRET`; `?miner=MINER_PUBKEY` when
   set) → reads `powPreimage`, `header.powTargetBits`, `header.height`
2. Loop: `nonce++`, `hash = blake2b512(hex2buf(powPreimage) || encodeLE64(nonce))`,
   check leading zeros
3. `POST /mining/submit` (Bearer) with `{ height, powNonce }`
4. Repeat

Config via env: `NODE_URL` (default `http://localhost:3000`), `MINING_SECRET`
(required — the node refuses unauthenticated mining), `MINER_PUBKEY` (optional
coinbase payout override), `MINER_PCT` (duty-cycle CPU throttle, default 25).
