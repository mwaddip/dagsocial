# Tx-Hash Signing Protocol

**Date:** 2026-07-24
**Status:** design
**Scope:** `@dagsocial/types`, `@dagsocial/node` (services, routes, store), demo UI

## Problem

Service layers sign domain messages (`create-invite:...`, `JSON.stringify({targetPostId, likerId})`)
but `validateTx` in the UTXO engine verifies signatures against `computeTxId(tx)` (the blake2b512
hash of the serialized transaction). These preimages are fundamentally different — the same key
can't produce a signature that verifies against both.

Consequence: `validateTx` is never called at pool entry. Routes bypass it with ad-hoc signature
verification and `tx.signatures` is always `{}`. This breaks the unified mempool model where every
state mutation should pass through `validateTx` for guard checking, duplicate detection, decay
verification, and transition validation.

## Design

### Core change

Every UTXO transaction signature covers `txId` (the transaction hash). The client acts as a wallet:
it fetches UTXO state, builds the full `UtxoTransaction`, signs `txId`, and submits the signed
transaction.

```
Old: Ed25519(blake2b512(domain_message))
New: Ed25519(blake2b512(serializeTx(tx)))   — i.e., Ed25519(txId)
```

### New field: `preimages`

`UtxoTransaction` gains an optional field for hash-locked guards:

```typescript
export interface UtxoTransaction {
  inputs: BoxId[];
  outputs: AnyBox[];
  signatures: Record<string, Uint8Array>;  // pubKey(hex) → Ed25519 sig over txId
  preimages?: Record<BoxId, Uint8Array>;   // hash preimage for each hash-locked input
  protocolVersion: number;
}
```

`checkGuards` in the UTXO engine is extended to handle `hash_preimage`: if a consumed box has
guard `hash_preimage`, the engine looks up `tx.preimages[box.id]`, hashes it, and checks
`H(preimage) == box.secretHash`. Throws if missing or mismatched.

This makes claim a regular transaction that passes through `validateTx`.

### Protocol constants

| Constant | Old | New |
|----------|-----|-----|
| `INVITE_BOND_KARMA` | 10 | 25 |
| `INVITE_KARMA_AMOUNT` | (not a constant) | 25 |

`INVITE_KARMA_AMOUNT` is the karma transferred in the InviteBox. It was previously a
per-request parameter; it's now a fixed protocol constant. Total karma required for an
invite: 50 (25 invite + 25 bond).

### Validation pipeline (after fix)

```
Route handler
  ├── App-level validation (content limits, challenge check for posts)
  ├── Post signature verification (verifier, unchanged)
  ├── validateTx(deps, tx, currentHeight)     ← NEW: called at pool entry
  │     ├── No duplicate inputs
  │     ├── All inputs exist and are unspent
  │     ├── Same boxType for all inputs
  │     ├── Value conservation (non-karma) / decay check (karma)
  │     ├── Guard satisfaction (signatures + preimages)
  │     └── Legal transitions
  ├── insertMempoolSubBlock / insertUtxoTx
  └── Broadcast

Block finalization
  ├── revalidateTxInContext (liveness + decay only)
  └── applyTx (consume inputs, insert outputs)
```

## Per-operation changes

### POST /posts

**Old request:** `Post` object (JSON). Karma-lock tx built server-side; post signature reused.

**New request:** `{ post, karmaLockTx }` where:
- `post` — the Post object (unchanged, post signature over `signingHash(post)`)
- `karmaLockTx` — signed `UtxoTransaction` consuming karma box → new karma + PostLockBox

**Flow:**
1. Decode and validate post fields
2. `verifyPost()` — challenge, PoW, post signature, parent refs, content, protocol, karma sufficiency
3. `computePostId(post)` — server-authoritative
4. Store post (status = pending)
5. `validateTx(karmaLockTx)` — guards, transitions, decay
6. Assemble sub-block: `{ subBlockId: postId, post, likeBoxes: [], producerId, protocolVersion }`
7. Insert both into mempool as batch (`batchId = postId`)
8. Consume challenge
9. Broadcast sub-block + tx
10. Signal block creator
11. Return `{ postId, status: "pending", expiresAtHeight }`

**Client preparation:** Fetch karma box (`GET /karma/:userId`), fetch challenge (`POST /challenge`),
build post, solve PoW, build karma-lock tx, sign both (post → `signingHash`, tx → `txId`).

### POST /likes

**Old request:** `{ targetPostId, likerId, signature }` — domain signature, server builds tx.

**New request:** `{ tx: UtxoTransaction }` — signed UTXO transaction.
Or for free likes: `{ targetPostId, likerId }` — no tx, no signature change.

**Flow (locked like):**
1. Verify target post exists and is live
2. Verify not already liked (DB + mempool)
3. Check total like count < 50 (free threshold)
4. `validateTx(tx)` — guards, transitions, decay
5. `insertUtxoTx(tx, null, expiresAtHeight)`
6. Broadcast
7. Return `{ status: "pending", txId, expiresAtHeight }`

**Client preparation:** Fetch karma box, check target post, build tx (consume karma → new karma +
LikeBox), sign `txId`.

### POST /likes/remove

**Old request:** `{ targetPostId, likerId, signature }` — domain signature.

**New request:** `{ tx: UtxoTransaction }` for locked like removal, or `{ tx: UtxoTransaction, freeLikeId }` for free.

**Flow (locked like):**
1. Verify post exists and is live
2. `validateTx(tx)`
3. `insertUtxoTx(tx, null, expiresAtHeight)`
4. Return `{ status: "pending", txId, expiresAtHeight }`

**Flow (free like):**
1. Verify post exists and is live
2. `deleteFreeLike(targetPostId, likerId)` — immediate (non-UTXO)
3. `validateTx(tx)` — the karma penalty tx
4. `insertUtxoTx(tx, null, expiresAtHeight)`
5. Return `{ status: "pending", txId, expiresAtHeight }`

### POST /invites

**Old request:** `{ inviterId, karmaAmount, bondAmount, signature }` — domain signature, server generates secret.

**New request:** `{ tx: UtxoTransaction }` — signed, with `secretHash` already embedded in the InviteBox output.

**Flow:**
1. Verify pending invite count < `MAX_PENDING_INVITES` (UTXO + mempool)
2. `validateTx(tx)` — guards, transitions (karma → karma + invite + bond), decay
3. `insertUtxoTx(tx, null, expiresAtHeight)`
4. Return `{ status: "pending", txId, expiresAtHeight, inviteBoxId, bondBoxId }`

Note: `secret` and `secretHash` are NOT in the response. The client generated the secret,
so it already has both. The client communicates the secret to the invitee out of band.

**Client preparation:** Generate 32 random bytes for secret, compute `secretHash = blake2b512(secret).subarray(0,32)`,
fetch karma box, build tx (consume karma → new karma [value - 50] + InviteBox [25, hash-locked] +
BondBox [25, inviter-owned]), sign `txId`.

### POST /invites/claim

**Old request:** `{ inviteBoxId, secret, publicKey }` — no signature.

**New request:** `{ tx: UtxoTransaction }` with `preimages: { [inviteBoxId]: secret }`.

**Flow:**
1. `validateTx(tx)` — verifies `H(preimage) == secretHash` via checkGuards, bond transition (unclaimed → claimed), bond.inviteePublicKey set to non-empty
2. `insertUtxoTx(tx, null, expiresAtHeight)`
3. Return `{ status: "pending", txId, expiresAtHeight, userId }`

`userId` is the invitee's public key (from the new KarmaBox output).

**Client preparation:** Receive secret from inviter (out of band), generate keypair, fetch invite box,
build tx (consume InviteBox + BondBox → new KarmaBox [25, invitee pubkey] + updated BondBox [inviteePubkey set, probation start/end set]), include `preimages`.

### POST /invites/cancel

**Old request:** `{ inviteBoxId, inviterId, signature }` — domain signature.

**New request:** `{ tx: UtxoTransaction }` — signed.

**Flow:**
1. Verify invite is unclaimed (sanity check)
2. `validateTx(tx)` — guards (inviter_signature on bond box), transitions, decay
3. `insertUtxoTx(tx, null, expiresAtHeight)`
4. Return `{ status: "pending", txId, expiresAtHeight }`

**Client preparation:** Fetch invite box, bond box, karma box, build tx (consume karma + invite +
bond → new karma [current + 50]), sign `txId`.

### POST /faucet

Deferred. 0-input transactions are a separate issue (gap #2). Faucet stays as-is for now.

## Guard changes

### `hash_preimage` guard

Currently `checkGuards` rejects `hash_preimage` with "handled by invite claim route."

**After fix:** `checkGuards` checks `tx.preimages[box.id]`, hashes it, verifies against
`box.secretHash`. Returns valid if matched, error if missing/mismatched. This makes claim
a regular validatable transaction.

### Transition: bond (unclaimed → claimed)

A new transition is added for BondBox alongside existing ones:

| Consumed | Created | Condition |
|----------|---------|-----------|
| InviteBox + BondBox (unclaimed) | KarmaBox (invitee) + BondBox (claimed) | Valid hash preimage for InviteBox. BondBox.inviteePublicKey changes from empty → non-empty. BondBox.probationStartBlock/probationEndBlock set. |

`checkTransitions` recognizes this as a valid transition when inputs include both an
InviteBox and an unclaimed BondBox (inviteePublicKey length === 0) and outputs include
a KarmaBox and a claimed BondBox (inviteePublicKey length === 32).

## Types package changes

### `UtxoTransaction`

```typescript
export interface UtxoTransaction {
  inputs: BoxId[];
  outputs: AnyBox[];
  signatures: Record<string, Uint8Array>;  // pubKey(hex) → Ed25519 sig over txId
  preimages?: Record<BoxId, Uint8Array>;   // hash preimage per hash-locked input
  protocolVersion: number;
}
```

### New constant

```typescript
export const INVITE_KARMA_AMOUNT = 25;
```

### Changed constant

```typescript
export const INVITE_BOND_KARMA = 25;  // was 10
```

## Serialization

`preimages` is included in CBOR serialization (and `computeTxId`). The preimages are part of the
transaction identity — changing a preimage changes the txId.

`computeTxId` adds preimages to its hash input:

```typescript
// After hashing outputs:
if (tx.preimages) {
  for (const [boxId, preimage] of Object.entries(tx.preimages).sort()) {
    h.update(boxId);
    h.update(preimage);
  }
}
```

## Things that don't change

- **Post signatures** — still over `signingHash(post)`. The post is a separate cryptographic object.
- **Epoch tally** — `LikeBox` and `PostLockBox` consumption is `epoch_tally` guarded, handled by the
  block creator, not user transactions.
- **Free likes** — still go through `dag_likes` directly (no UTXO tx). The karma penalty for unlike
  of a free like IS a UTXO tx (now signed).
- **Challenge service** — unchanged.

## Exceptions

- **Claim does use signatures** — via `preimages`, not Ed25519. The hash preimage is the authorization.
- **Faucet** — deferred to gap #2 (0-input transactions).
- **Epoch tally** — `epoch_tally` guard, handled by block creator during `finalizeBlock`.

## Demo UI impact

The demo UI (`public/index.html`) becomes wallet-aware:
- Fetch UTXO state before building transactions
- Construct `UtxoTransaction` objects in JS
- Sign `txId` with the user's Ed25519 key
- Include `preimages` for claim transactions
- Generate secrets for invite creation

The demo UI already has Ed25519 signing via the Web Crypto API (for post signatures).
Tx-hash signing uses the same keypair but a different preimage.

## Migration

No backward compatibility. Clean break — old unsigned transactions are rejected by `validateTx`.
This is acceptable: the project is pre-release, no persisted data or external clients exist.
