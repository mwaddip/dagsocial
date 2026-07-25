# Credit Transfer MVP

**Date:** 2026-07-25
**Status:** approved

## Summary

Miners earn 100 credits per block via coinbase emission, but there is no way
to transfer credits between users. The validation engine (utxo-engine.ts) already
supports credit transfers — this adds the API surface, transaction builder, and
demo UI to make them functional.

Additionally: a testnet-only credit faucet for development, and bringing the
balance endpoint up to parity with the multi-box karma format.

## API

### `POST /credits/transfer`

Transfer credits from one identity to another. Bitcoin-style UTXO selection:
enough unlocked boxes to cover the amount, remainder back as change.

```
Request:  { from: UserId, to: UserId, amount: number, signature: base64 }
Response: { txId: string, sent: number, change: number, boxesConsumed: number }
Errors:   400 (invalid input, insufficient balance), 401 (bad signature)
```

Logic:
1. Look up sender's unlocked credit boxes (`lockedUntilBlock <= currentHeight`)
2. Select largest-first until the amount is covered
3. Build outputs: [recipient output, sender change output (if remainder > 0)]
4. Compute tx hash via `computeTxId()`, verify Ed25519 signature against sender
5. Apply to UTXO set: mark consumed boxes spent, insert new boxes
6. Return summary

- `amount` must be >= 1
- No fee for MVP
- Face-value conservation enforced by existing UTXO engine (`checkValueConservation`)

### `GET /credits/:userId` (updated)

Multi-box format matching how `/karma/:userId` was updated:

```
Response: { userId: UserId, total: number, boxes: { boxId: string, value: number, lockedUntilBlock?: number }[] }
```

Previously returned `{ userId, balance, boxId }`. Breaking change, consistent with karma.

### `POST /credits/faucet` (testnet only)

```
Request:  { to: UserId }
Response: { txId: string, amount: 1000 }
```

- Active only when `Config.TESTNET` is true; returns 403 on mainnet
- Faucet has its own identity (keypair generated at node boot, persisted in
  store). Pre-seeded with 100,000 credits during node initialization (one-time
  direct store insert if the faucet identity has no unspent credit boxes).
- 1000 credits per call — uses `sendCredits()` internally (regular transfer,
  same builder as the transfer endpoint)
- No per-address limit, no minimum balance enforcement

## Server Implementation

### Store (`packages/node/src/store/utxo.ts`)

**New query:** `getUnlockedCreditBoxes(userId: UserId, blockHeight: number): Promise<CreditBox[]>`

```sql
SELECT * FROM utxo_boxes
WHERE box_type = 'credit'
  AND owner = ?
  AND spent_at_block IS NULL
  AND (locked_until_block IS NULL OR locked_until_block <= ?)
ORDER BY value DESC
```

Richer than `getCreditBoxes` (which returns all unspent regardless of lock).
`getCreditBoxes` keeps its current behavior (used by `mintCredits` which needs
to see locked boxes too).

### Service (`packages/node/src/services/credits.ts`)

**New function:** `sendCredits(deps, from, to, amount, signature, currentHeight)`

- Calls `getUnlockedCreditBoxes` + `selectBoxes` from types
- Builds `CreditBox[]` outputs with `proofSource = -1` (transfer, not coinbase)
- Computes tx ID, verifies signature
- Mutates store (marks spent, inserts outputs)
- Returns `{ txId, sent, change, boxesConsumed }`

Existing `mintCredits()` unchanged.

### Routes (`packages/node/src/routes/utxo.ts`)

- `POST /credits/transfer` handler
- `GET /credits/:userId` — updated response shape
- `POST /credits/faucet` handler (testnet-gated)

### Server wiring (`packages/node/src/server.ts`)

- Add `getUnlockedCreditBoxes` to `UtxoDeps`
- Wire the new route

## Demo UI (`packages/node/public/index.html`)

### Transfer form
- Recipient ID input (text field, hex user ID)
- Amount input (number, min 1)
- Send button
- Signs the transfer tx with the active identity's secret key
- `selectBoxes()` JS implementation already exists from karma work

### Faucet button
- Rendered only when the node is in testnet mode
- "Get 1000 credits" button next to credit balance
- Sends `POST /credits/faucet` with the active identity

## Tests

### Unit tests
- `sendCredits()` in `packages/node/test/services/credits.test.ts`:
  - Transfers from multi-box wallet with correct selection
  - Skips locked boxes
  - Produces correct change output
  - Rejects insufficient balance
  - Rejects bad signature
  - Exact-amount transfer (no change output)

- `getUnlockedCreditBoxes` in store tests

### Route tests
- `POST /credits/transfer` — success, bad sig, insufficient balance
- `GET /credits/:userId` — updated response shape
- `POST /credits/faucet` — 200 on testnet, 403 on mainnet

## Out of scope

- Fee market for credit transfers
- Transaction memo/reason field
- Client-side tx construction (deferred to proper multi-function implementation)
- Per-address faucet rate limiting
- Locked credit spend attempts (engine already enforces, no UX needed)
