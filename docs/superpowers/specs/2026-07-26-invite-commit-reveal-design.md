# Invite Commit-Reveal Design

**Date:** 2026-07-26
**Status:** approved

## Summary

The invite system has a frontrunning vulnerability: the claim tx exposes the
secret preimage in `tx.preimages`, making it visible to any mempool observer.
Since the secret is the sole authorization mechanism (bearer instrument), an
attacker can extract the secret and submit their own claim tx with their own
public key, stealing the invite.

This design adds a two-phase commit-reveal flow that binds the invitee's
identity to the BondBox *before* the secret hits the wire. The BondBox gains a
new `hash_preimage` unlock path that allows the invitee to commit their pubkey.
Once committed, the secret is useless to an attacker — their pubkey won't match.

Key constraint: the invitee is a new user with no boxes to spend. The commit
step spends the BondBox (already on-chain, created by the inviter), avoiding
the zero-input tx problem.

## Data Model

### InviteBox — unchanged

```
InviteBox {
  boxType: 'invite'
  value: 25                    // INVITE_KARMA_AMOUNT
  secretHash: Uint8Array       // H(secret)
  inviterId: UserId
  guard: 'hash_preimage_with_bond'   // was: 'hash_preimage'
}
```

The guard name changes, but the structure is the same. The `secretHash` is still
`H(secret)` computed by the inviter at create time — no key binding at creation.

### BondBox — new field, new guard path

```
BondBox {
  boxType: 'bond'
  value: 25                    // INVITE_BOND_KARMA
  inviterId: UserId
  inviteBoxId: BoxId           // NEW — which InviteBox this pairs with
  inviteePublicKey: Uint8Array // empty = unclaimed, 32 bytes = committed
  probationStartBlock: number | null
  probationEndBlock: number | null
  guard: 'bond_dual'           // was: 'inviter_signature'
}
```

`inviteBoxId` is set at create time and gives the commit guard access to the
InviteBox's `secretHash` for verification. This is the only structural change
to the box.

The guard changes from `inviter_signature` (single unlock path) to `bond_dual`
(two unlock paths):

1. **`inviter_signature`** — inviter reclaims the bond (cancel, same as today)
2. **`hash_preimage`** — anyone who knows the secret can commit their pubkey.
   `H(preimage)` is checked against `inviteBox.secretHash` (looked up via
   `inviteBoxId`). The new `inviteePublicKey` in the output must match the tx
   signer's keypair. Also sets `probationStartBlock` and `probationEndBlock`.

## Lifecycle

### Create — unchanged

Inviter burns karma → InviteBox (25, `hash_preimage_with_bond`,
`secretHash=H(secret)`) + BondBox (25, `bond_dual`, `inviteePublicKey=empty`).

Inviter shares the secret with the invitee out-of-band.

### Commit — new step

Invitee spends ONLY the BondBox. The `hash_preimage` unlock path verifies
`H(secret) == secretHash` of the InviteBox referenced by `bondBox.inviteBoxId`.
The transition sets
`inviteePublicKey = txSigner.pubkey`, `probationStartBlock = currentHeight`,
`probationEndBlock = currentHeight + INVITE_PROBATION_BLOCKS`.

Secret is exposed in mempool at this point. An attacker who sees it cannot use
it: revealing the secret against the InviteBox requires a BondBox committed to
the attacker's pubkey, and the real BondBox is already committed to the invitee.

### Reveal — modified claim

Invitee spends **both** InviteBox and BondBox(committed) → KarmaBox(invitee) +
BondBox(probation-period).

The `hash_preimage_with_bond` guard on the InviteBox:
- `H(preimage) == secretHash` (same as before)
- **AND** a BondBox input in the same tx has `inviteePublicKey == txSigner.pubkey`

Both conditions must hold. An attacker with the secret but a mismatched keypair
fails the pubkey check.

The reveal tx is signed only by the invitee.

### Cancel — works on both uncommitted and committed BondBoxes

Inviter spends Karma + InviteBox + BondBox → KarmaBox(inviter). All karma returns
to the inviter.

The `inviter_signature` path on the BondBox remains valid regardless of commit
state. If the BondBox is committed, the inviter reclaims it the same way. The
invitee's committed pubkey doesn't block the inviter from canceling.

## Guard Changes

### BondBox: `bond_dual`

```
Path 1 (inviter_signature):
  - Tx is signed by inviter (pubkey == box.inviterId)

Path 2 (hash_preimage):
  - tx.preimages[bondBoxId] exists
  - H(preimage) == secretHash of InviteBox referenced by bondBox.inviteBoxId
  - Output BondBox.inviteePublicKey == tx signer's pubkey
  - Output BondBox.inviteePublicKey was empty in input
```

### InviteBox: `hash_preimage_with_bond`

```
Path (hash_preimage_with_bond):
  - tx.preimages[inviteBoxId] exists
  - H(preimage) == box.secretHash
  - A BondBox input in the same tx has inviteePublicKey == tx signer's pubkey
  - That BondBox.input.inviteePublicKey is non-empty (was committed)
```

## Transitions

### Commit

```
Inputs:  [BondBox(unclaimed)]
Outputs: [BondBox(committed: inviteePublicKey set, probation timers set)]
```

Value conservation is zero (no karma moves).

### Reveal

```
Inputs:  [InviteBox, BondBox(committed)]
Outputs: [KarmaBox(invitee, 25), BondBox(probation, 25)]
```

Value conserved (existing karma creation transition). BondBox output keeps
fields set by commit (inviteePublicKey, probation timers).

### Cancel

```
Inputs:  [KarmaBox(inviter), InviteBox, BondBox(*)]
Outputs: [KarmaBox(inviter, karma+50)]
```

Works with BondBox in any state (unclaimed or committed). Value conserved.

## API

### `POST /invites/commit` — new

```
Request:  { inviteBoxId: string, bondBoxId: string, secret: string, inviteePublicKey: string }
Response: { status: 'pending', txId: string, expiresAtHeight: number }
Errors:   400 (missing fields, wrong secret), 409 (BondBox already committed/spent)
```

### `POST /invites/claim` — modified

Same request shape as before. Verification now requires the BondBox to be
committed and the signer's pubkey to match. Same response shape.

### `POST /invites/cancel` — no API change

Works regardless of BondBox commit state. Same request and response.

### `GET /invites/:userId` — richer bond data

Committed BondBoxes now show `inviteePublicKey` in the response. Same endpoint,
richer data.

## Edge Cases

- **Stale commit** — invitee commits but never reveals. Inviter cancels,
  reclaims all karma. invitee lost nothing (they never put karma in).
- **Double commit** — first commit spends the BondBox, second fails (already
  spent). Standard UTXO double-spend protection.
- **Wrong secret in commit** — `H(secret) != secretHash`. Commit fails
  validation, same as today's claim failing with a wrong secret.
- **Cancel during commit window** — if cancel confirms first, commit tx fails
  (BondBox spent). If commit confirms first, cancel still works (inviter
  reclaims committed BondBox). No lockup.
- **Refresh during commit → reveal wait** — demo UI holds the secret in
  browser session storage. Page refresh: secret persists, UI resumes at
  "committed, waiting to reveal." Browser close: secret lost, invite
  unrecoverable unless invitee saved the secret.

## Demo UI Flow

```
User enters inviteBoxId, bondBoxId, secret → clicks "Redeem"
  ↓
POST /invites/commit (secret submitted, invitee signs)
  ↓ "Committing..." (button disabled, pending animation)
  ↓ wait for block inclusion
  ↓
POST /invites/claim (same secret, same signature)
  ↓ "Claiming..."
  ↓
Done — karma box created
```

Single button, two steps transparent to the user. Secret held in browser session
storage (persists through refresh, lost on browser close).

## Tests

### Unit tests (`packages/node/test/services/invites.test.ts`)

- Commit: spends BondBox, sets inviteePublicKey and probation timers
- Commit: fails with wrong secret (`H(secret) != secretHash`)
- Commit: fails if BondBox already committed (already spent)
- Reveal: succeeds with committed BondBox matching signer's pubkey
- Reveal: fails if BondBox.inviteePublicKey != tx signer's pubkey (front-run)
- Reveal: fails if BondBox is uncommitted (inviteePublicKey still empty)
- Cancel: succeeds on committed BondBox (inviter reclaims)
- Cancel: succeeds on uncommitted BondBox (existing behavior, unchanged)

### Route tests (`packages/node/test/routes/invites.test.ts`)

- `POST /invites/commit` — 201 with pending
- `POST /invites/commit` with missing secret — 400
- `POST /invites/commit` with already-committed BondBox — 409
- `POST /invites/claim` with committed BondBox and correct secret — 201
- `POST /invites/claim` where pubkey mismatch — 403

## Out of Scope

- Block-interval configuration for commit→reveal wait (hardcoded, tune later)
- Notification mechanism for invitee (out-of-band, same as today)
- Secret recovery after browser close (user-managed)
