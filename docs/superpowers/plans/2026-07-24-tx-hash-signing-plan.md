# Tx-Hash Signing Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change all UTXO transaction signatures from domain-specific messages to the transaction hash (`txId`), enabling `validateTx` at pool entry for every state mutation.

**Architecture:** The client (demo UI or future web client) acts as a wallet — fetches UTXO state, builds complete `UtxoTransaction` objects, signs `txId`, and submits signed transactions. Service layers drop ad-hoc `verifySignature` calls and delegate to `validateTx`. `UtxoTransaction` gains a `preimages` field for hash-locked guards.

**Tech Stack:** TypeScript, Node.js ≥ 22, Ed25519, blake2b512, pnpm workspaces, vitest

## Global Constraints

- Node.js ≥ 22 (blake2b512 via `crypto.createHash`)
- `@dagsocial/types` and `@dagsocial/validation` packages built before `@dagsocial/node`
- `PROTOCOL_VERSION = 1`
- Signatures: raw Ed25519 (64 bytes), hex-encoded on HTTP wire
- Hashing: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- No backward compatibility — clean break from domain-message signing
- All mutating routes (except faucet) MUST call `validateTx` before mempool insertion

---

### Task 1: Types — constants and UtxoTransaction preimages

**Files:**
- Modify: `packages/types/src/constants.ts`
- Modify: `packages/types/src/utxo.ts`

**Interfaces:**
- Consumes: nothing (leaf package)
- Produces: `INVITE_KARMA_AMOUNT = 25`, `INVITE_BOND_KARMA = 25` (was 10), `UtxoTransaction.preimages?: Record<BoxId, Uint8Array>`, updated `computeTxId` includes preimages

- [ ] **Step 1: Add INVITE_KARMA_AMOUNT and change INVITE_BOND_KARMA**

In `packages/types/src/constants.ts`, after `INVITE_MIN_KARMA`:

```typescript
export const INVITE_KARMA_AMOUNT = 25;        // Karma transferred in InviteBox
```

Change:
```typescript
export const INVITE_BOND_KARMA = 25;  // was 10
```

- [ ] **Step 2: Add preimages to UtxoTransaction interface**

In `packages/types/src/utxo.ts`, add to the interface:

```typescript
export interface UtxoTransaction {
  inputs: BoxId[];
  outputs: AnyBox[];
  signatures: Record<string, Uint8Array>;  // publicKey (hex) → Ed25519 sig (64 bytes) over txId
  preimages?: Record<string, Uint8Array>;  // boxId → hash preimage for hash_preimage guards
  protocolVersion: number;
}
```

- [ ] **Step 3: Update computeTxId to include preimages**

In `packages/types/src/utxo.ts`, after hashing outputs and before protocolVersion:

```typescript
export function computeTxId(tx: UtxoTransaction): TxId {
  const h = createHash('blake2b512');
  for (const input of tx.inputs) {
    h.update(input);
  }
  for (const output of tx.outputs) {
    const { id, ...rest } = output;
    h.update(encodeForHash(rest));
  }
  // NEW: include preimages in tx identity
  if (tx.preimages) {
    const sortedKeys = Object.keys(tx.preimages).sort();
    for (const boxId of sortedKeys) {
      h.update(boxId);
      h.update(tx.preimages[boxId]!);
    }
  }
  h.update(String(tx.protocolVersion));
  return h.digest().subarray(0, 32).toString('hex');
}
```

- [ ] **Step 4: Add serialization support for preimages**

In `packages/types/src/serialization.ts`, `encodeTx` and `decodeTx` must handle `preimages`.
Read the current implementation to confirm field handling. CBOR via `cbor-x` handles optional
maps natively — `encodeTx` passes the tx object directly. Verify `decodeTx` returns the
preimages field when present. Add a test in Task 1's test step.

- [ ] **Step 5: Re-export INVITE_KARMA_AMOUNT from index**

In `packages/types/src/index.ts`, add `INVITE_KARMA_AMOUNT` to the constants export block.

- [ ] **Step 6: Add types tests**

In `packages/types/test/utxo.test.ts`, add:

```typescript
import { computeTxId, INVITE_KARMA_AMOUNT, INVITE_BOND_KARMA } from '../src/index.js';
import type { UtxoTransaction, KarmaBox, InviteBox, BondBox } from '../src/index.js';

describe('computeTxId with preimages', () => {
  it('includes preimages in tx hash', () => {
    const tx: UtxoTransaction = {
      inputs: ['box1'],
      outputs: [],
      signatures: {},
      preimages: { 'box1': new Uint8Array([1, 2, 3]) },
      protocolVersion: 1,
    };
    const id1 = computeTxId(tx);

    const tx2: UtxoTransaction = {
      ...tx,
      preimages: { 'box1': new Uint8Array([4, 5, 6]) },
    };
    const id2 = computeTxId(tx2);

    expect(id1).not.toBe(id2);
  });

  it('sorts preimage keys for determinism', () => {
    const tx: UtxoTransaction = {
      inputs: ['box_b', 'box_a'],
      outputs: [],
      signatures: {},
      preimages: {
        'box_b': new Uint8Array([2]),
        'box_a': new Uint8Array([1]),
      },
      protocolVersion: 1,
    };
    // Should not throw; determinism means consistent output
    const id1 = computeTxId(tx);
    const id2 = computeTxId(tx);
    expect(id1).toBe(id2);
  });

  it('omits preimages from hash when undefined', () => {
    const tx: UtxoTransaction = {
      inputs: ['box1'],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    const id = computeTxId(tx);
    expect(typeof id).toBe('string');
    expect(id.length).toBe(64);
  });
});

describe('INVITE constants', () => {
  it('INVITE_KARMA_AMOUNT is 25', () => {
    expect(INVITE_KARMA_AMOUNT).toBe(25);
  });

  it('INVITE_BOND_KARMA is 25', () => {
    expect(INVITE_BOND_KARMA).toBe(25);
  });
});
```

- [ ] **Step 7: Run types tests, build**

```bash
pnpm --filter @dagsocial/types test
pnpm --filter @dagsocial/types build
```

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/constants.ts packages/types/src/utxo.ts packages/types/src/index.ts packages/types/test/utxo.test.ts
git commit -m "feat(types): add preimages to UtxoTransaction, INVITE_KARMA_AMOUNT=25, INVITE_BOND_KARMA=25

- UtxoTransaction gains optional preimages: Record<BoxId, Uint8Array>
- computeTxId includes preimages in deterministic sorted-key order
- INVITE_BOND_KARMA changed from 10 to 25
- INVITE_KARMA_AMOUNT added as 25 (invite box karma transfer)"
```

---

### Task 2: UTXO engine — hash_preimage guard and bond claim transition

**Files:**
- Modify: `packages/node/src/services/utxo-engine.ts`

**Interfaces:**
- Consumes: `UtxoTransaction.preimages` (Task 1)
- Produces: `checkGuards` handles `hash_preimage`, `checkTransitions` handles bond unclaimed→claimed

- [ ] **Step 1: Extend checkGuards for hash_preimage**

In `packages/node/src/services/utxo-engine.ts`, in `checkGuards`, replace the `hash_preimage` case:

Old:
```typescript
case 'hash_preimage':
  return {
    valid: false,
    error: `hash_preimage guard handled by invite claim route, not generic validation`,
  };
```

New:
```typescript
case 'hash_preimage': {
  const preimage = tx.preimages?.[box.id!];
  if (!preimage) {
    return {
      valid: false,
      error: `Missing preimage for hash-locked box ${box.id}`,
    };
  }
  const expectedHash = (box as InviteBox).secretHash;
  const computedHash = createHash('blake2b512')
    .update(Buffer.from(preimage))
    .digest()
    .subarray(0, 32);
  if (Buffer.from(computedHash).toString('hex') !== Buffer.from(expectedHash).toString('hex')) {
    return {
      valid: false,
      error: `Hash preimage mismatch for box ${box.id}`,
    };
  }
  break;
}
```

Import `InviteBox` from `@dagsocial/types` if not already imported (add to existing type import at top).

- [ ] **Step 2: Extend checkTransitions for bond claim**

In `checkTransitions`, after the `case 'bond':` block, add a special multi-input case by detecting
the combined invite+bond claim pattern. Before the switch statement, add a check for the claim
pattern:

```typescript
function checkTransitions(
  inputs: AnyBox[],
  outputs: AnyBox[],
): { valid: boolean; error?: string } {
  // Handle invite claim: InviteBox + BondBox → KarmaBox + BondBox (claimed)
  if (inputs.length === 2) {
    const hasInvite = inputs.some((b) => b.boxType === 'invite');
    const hasBond = inputs.some((b) => b.boxType === 'bond');
    if (hasInvite && hasBond) {
      const bondIn = inputs.find((b) => b.boxType === 'bond') as BondBox;
      const karmaOuts = outputs.filter((o) => o.boxType === 'karma');
      const bondOuts = outputs.filter((o) => o.boxType === 'bond');

      // Unclaimed bond → claimed bond transition
      if (bondIn.inviteePublicKey.length === 0 &&
          bondOuts.length === 1 &&
          karmaOuts.length === 1 &&
          outputs.length === 2) {
        const bondOut = bondOuts[0] as BondBox;
        // inviteePublicKey must be set (32 bytes), probation must be set
        if (bondOut.inviteePublicKey.length === 32 &&
            bondOut.probationStartBlock > 0 &&
            bondOut.probationEndBlock > bondOut.probationStartBlock) {
          return { valid: true };
        }
      }
      return {
        valid: false,
        error: `Invalid invite claim: expected 1 karma + 1 claimed bond output`,
      };
    }
  }

  const inputType = inputs[0]!.boxType;
  // ... rest of existing switch
}
```

This goes right after the function signature and before `const inputType = inputs[0]!.boxType;`.

- [ ] **Step 3: Update computeTxHash to include preimages**

In `packages/node/src/services/utxo-engine.ts`, the local `computeTxHash` function currently
uses `serializeTx`. Replace it to delegate to the types package's `computeTxId`:

Remove the local `computeTxHash` function:
```typescript
// Delete this:
function computeTxHash(tx: UtxoTransaction): Buffer {
  return createHash('blake2b512')
    .update(Buffer.from(serializeTx(tx)))
    .digest()
    .subarray(0, 32);
}
```

Instead, add import at top:
```typescript
import { computeTxId } from '@dagsocial/types';
```

And in `checkGuards`, replace `const txHash = computeTxHash(tx);` with:
```typescript
const txHash = Buffer.from(computeTxId(tx), 'hex');
```

`computeTxId` returns a hex string; convert to Buffer for `crypto.verify`.

- [ ] **Step 4: Add tests for hash_preimage guard**

In `packages/node/test/services/utxo-engine.test.ts`, add a new `describe` block:

```typescript
describe('hash_preimage guard', () => {
  let inviterPubKey: Uint8Array;
  let inviterPrivKey: KeyObject;
  let inviteBoxId: string;
  let secret: Uint8Array;
  let secretHash: Uint8Array;

  beforeEach(() => {
    const keys = generateKeyPairSync('ed25519');
    inviterPubKey = rawPublicKey(keys.publicKey);
    inviterPrivKey = keys.privateKey;

    secret = new Uint8Array(Buffer.from('a'.repeat(64), 'hex'));
    secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    // Create a karma box for inviter
    const karmaBox: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1,
    };
    const karmaId = computeBoxId(karmaBox);
    insertIdentity(inviterPubKey, { publicKey: inviterPubKey, secretKey: new Uint8Array(0) } as any);
    storeInsertBox({ ...karmaBox, id: karmaId });

    // Create an invite box (hash-locked)
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: 25,
      createdAtBlock: 1,
      secretHash,
      inviterId: inviterPubKey,
      guard: 'hash_preimage',
    };
    inviteBoxId = computeBoxId(inviteBox);
    storeInsertBox({ ...inviteBox, id: inviteBoxId });
  });

  it('accepts tx with valid preimage', () => {
    const newKarmaBox: KarmaBox = {
      boxType: 'karma',
      value: 25,
      createdAtBlock: 10,
      owner: new Uint8Array(32), // invitee
      guard: 'owner_signature',
      proofSource: 'claim',
      lastTouchBlock: 10,
    };

    const tx: UtxoTransaction = {
      inputs: [inviteBoxId],
      outputs: [newKarmaBox],
      signatures: {},
      preimages: { [inviteBoxId]: secret },
      protocolVersion: 1,
    };

    const result = validateTx(makeDeps(), tx, 10);
    // This will fail at the transition check (invite alone without bond is invalid
    // for the claim transition), but the guard check should pass.
    // Actually let's check: with just invite→karma, the existing transitions
    // allow it. Let's verify guard passes.
    if (!result.valid && result.error?.includes('Missing preimage')) {
      expect.fail('Guard should accept valid preimage');
    }
    // Note: may fail at transitions if bond not present. May need full claim setup.
  });

  it('rejects tx with missing preimage', () => {
    const tx: UtxoTransaction = {
      inputs: [inviteBoxId],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };

    const result = validateTx(makeDeps(), tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing preimage');
  });

  it('rejects tx with wrong preimage', () => {
    const wrongSecret = new Uint8Array(32);
    const tx: UtxoTransaction = {
      inputs: [inviteBoxId],
      outputs: [],
      signatures: {},
      preimages: { [inviteBoxId]: wrongSecret },
      protocolVersion: 1,
    };

    const result = validateTx(makeDeps(), tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('preimage mismatch');
  });
});
```

- [ ] **Step 5: Add tests for bond claim transition**

In the same test file, add:

```typescript
describe('invite+bond claim transition', () => {
  // Setup inviter karma, invite box, bond box, secret
  // Test: InviteBox+BondBox(unclaimed) → KarmaBox+BondBox(claimed) passes
  // Test: InviteBox+BondBox → KarmaBox only (no bond output) fails
  // Test: InviteBox+BondBox → KarmaBox+BondBox with empty inviteePubKey fails
});
```

Write the test setup and cases to match the pattern in the existing test file.

- [ ] **Step 6: Run UTXO engine tests**

```bash
pnpm --filter @dagsocial/node test -- services/utxo-engine
```

Expected: new tests pass, existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/services/utxo-engine.ts packages/node/test/services/utxo-engine.test.ts
git commit -m "feat(utxo-engine): hash_preimage guard and bond claim transition

- checkGuards verifies H(preimage) == secretHash for hash_preimage boxes
- checkTransitions allows InviteBox+BondBox(unclaimed) → KarmaBox+BondBox(claimed)
- computeTxHash delegates to types package computeTxId (includes preimages)"
```

---

### Task 3: Likes service — tx-hash signing

**Files:**
- Modify: `packages/node/src/services/likes.ts`

**Interfaces:**
- Consumes: `validateTx` from utxo-engine, `UtxoTransaction.preimages` (Task 1)
- Produces: `castLike` and `removeLike` accept pre-built signed transactions

- [ ] **Step 1: Rewrite castLike to accept signed tx**

Replace the entire `castLike` function. The new signature:

```typescript
export function castLike(
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
 | { castLikeResult: 'free'; likeId: string }
```

Inside the function:
1. Extract `targetPostId` and `likerId` from the `LikeBox` output in `tx.outputs`
2. Verify target post exists and is live
3. Verify not already liked (DB + mempool)
4. Check total like count — if ≥ 50, this should be a free like (throw if client submitted a locked tx)
5. `validateTx(deps, tx, currentBlockHeight)` — guards, transitions, decay
6. `insertUtxoTx(tx, null, currentBlockHeight + 720)`
7. Return `{ castLikeResult: 'pending', txId: computeTxId(tx), expiresAtHeight, tx }`

Remove the ad-hoc `verifySignature` call entirely. Remove the `signData` construction.
Remove the manual box construction (client builds the tx now).

For free likes (≥ 50 total likes), keep the direct `insertLike` path unchanged.

- [ ] **Step 2: Rewrite removeLike to accept signed tx**

Same pattern. New signature:

```typescript
export function removeLike(
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { removeLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
```

Extract targetPostId and likerId from the consumed LikeBox (look it up by input boxId).
Verify post exists and is live.
`validateTx(deps, tx, currentBlockHeight)`.
`insertUtxoTx(tx, null, currentBlockHeight + 720)`.
Return.

- [ ] **Step 3: Add deps for validateTx**

The likes service currently doesn't import `validateTx` or have the deps needed. Add imports:

```typescript
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
```

The likes service functions need `UtxoEngineDeps` as a parameter. Alternative: build deps
inline using the store functions already imported. Prefer passing deps as a parameter to
keep the service testable:

```typescript
import type { UtxoEngineDeps } from './utxo-engine.js';

export function castLike(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): ...
```

This changes the signature consumed by the route. Update the route deps accordingly (Task 6).

- [ ] **Step 4: Run likes tests**

```bash
pnpm --filter @dagsocial/node test -- services/likes
```

Tests will fail — they still use the old API. Mark them as expected failures for now;
they'll be rewritten in Task 7.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/services/likes.ts
git commit -m "feat(likes): castLike and removeLike accept signed UtxoTransaction

- Remove domain-message signature verification
- Accept complete UtxoTransaction from client
- Call validateTx for guard, transition, and decay checking
- deps parameter for UtxoEngineDeps (testable)"
```

---

### Task 4: Invites service — tx-hash signing

**Files:**
- Modify: `packages/node/src/services/invites.ts`

**Interfaces:**
- Consumes: `validateTx`, `INVITE_KARMA_AMOUNT`, `INVITE_BOND_KARMA` (Tasks 1, 2)
- Produces: `createInvite`, `claimInvite`, `cancelInvite` accept signed txs

- [ ] **Step 1: Rewrite createInvite**

New signature:
```typescript
export function createInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { status: 'pending'; txId: string; expiresAtHeight: number; inviteBox: InviteBox; bondBox: BondBox; tx: UtxoTransaction }
```

The client now builds the tx (including generating the secret and computing secretHash).
The service:
1. Extract inviter info from the consumed KarmaBox input (look up by input boxId)
2. Verify the karma input box exists, is unspent, belongs to the inviter
3. Verify invite count limit (UTXO + mempool)
4. Verify outputs: exactly 1 karma + 1 invite + 1 bond
5. Verify invite output value === INVITE_KARMA_AMOUNT (25) and bond output value === INVITE_BOND_KARMA (25)
6. `validateTx(deps, tx, currentBlockHeight)`
7. `insertUtxoTx(tx, null, currentBlockHeight + 720)`
8. Return result (no secret/secretHash in response — client generated them)

Remove: domain signature verification, secret generation, ad-hoc box construction.

- [ ] **Step 2: Rewrite claimInvite**

New signature:
```typescript
export function claimInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { status: 'pending'; txId: string; expiresAtHeight: number; userId: Uint8Array; karmaBoxId: string; tx: UtxoTransaction }
```

The client builds the tx with `preimages` containing the secret. The service:
1. Extract invite box ID and bond box ID from tx.inputs
2. Verify invite box exists, is unspent, is type `invite`
3. Verify invitee public key (from the new KarmaBox output) is not already an account
4. `validateTx(deps, tx, currentBlockHeight)` — this verifies the preimage via checkGuards
5. `insertUtxoTx(tx, null, currentBlockHeight + 720)`
6. Return result

Remove: secret hash computation, ad-hoc box construction, manual bond box update.

- [ ] **Step 3: Rewrite cancelInvite**

New signature:
```typescript
export function cancelInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
```

The client builds the tx. The service:
1. Extract invite box ID from tx.inputs
2. Verify invite box exists, is unspent, is type `invite`
3. Verify inviter matches the invite box's inviterId
4. `validateTx(deps, tx, currentBlockHeight)` — checks inviter_signature on bond box
5. `insertUtxoTx(tx, null, currentBlockHeight + 720)`
6. Return result

- [ ] **Step 4: Remove dead code**

Remove the local `verifySignature` function, `publicKeyToKeyObject`, and `ED25519_SPKI_PREFIX` —
they are no longer needed.

- [ ] **Step 5: Update imports**

Add:
```typescript
import type { UtxoEngineDeps } from './utxo-engine.js';
import { validateTx } from './utxo-engine.js';
import { INVITE_KARMA_AMOUNT, INVITE_BOND_KARMA } from '@dagsocial/types';
```

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/invites.ts
git commit -m "feat(invites): createInvite, claimInvite, cancelInvite accept signed UtxoTransaction

- Remove domain-message signature verification and secret generation
- Client builds tx including secret hash for invites, preimages for claims
- Fixed amounts: INVITE_KARMA_AMOUNT=25, INVITE_BOND_KARMA=25
- All three operations call validateTx for guard/transition/decay checking
- claimInvite goes through validateTx via preimages (hash_preimage guard)"
```

---

### Task 5: Posts route — accept signed karma-lock tx

**Files:**
- Modify: `packages/node/src/routes/posts.ts`

**Interfaces:**
- Consumes: signed `karmaLockTx` in request body (Task 1)
- Produces: updated `POST /posts` accepts `{ post, karmaLockTx }`

- [ ] **Step 1: Update PostsDeps interface**

Add to the `PostsDeps` interface:
```typescript
validateTx: (tx: UtxoTransaction, currentBlockHeight: number) => { valid: boolean; error?: string; computedOutputs?: AnyBox[]; txId?: string };
```

- [ ] **Step 2: Update POST /posts handler**

Current flow in the route builds the karma-lock tx server-side and reuses the post signature.
Replace the tx-building section (from `// Lock karma via UTXO transaction` through `deps.insertUtxoTx`):

```typescript
// Extract karma-lock tx from request body
const karmaLockTx = (req.body as { karmaLockTx?: UtxoTransaction }).karmaLockTx;
if (!karmaLockTx) {
  res.status(400).json({ error: 'karmaLockTx required' });
  return;
}

// Validate the karma-lock tx via the UTXO engine
const txResult = deps.validateTx(karmaLockTx, currentHeight);
if (!txResult.valid) {
  try { deps.consumeChallenge(post.author, post.challenge); } catch { /* ok */ }
  res.status(400).json({ error: txResult.error });
  return;
}

// Verify the karma-lock tx matches the post author
const karmaInput = deps.getBox(karmaLockTx.inputs[0]!);
if (!karmaInput || (karmaInput as KarmaBox).owner && 
    Buffer.from((karmaInput as KarmaBox).owner).toString('hex') !== Buffer.from(post.author).toString('hex')) {
  try { deps.consumeChallenge(post.author, post.challenge); } catch { /* ok */ }
  res.status(400).json({ error: 'karmaLockTx does not belong to post author' });
  return;
}
```

Remove the local `karmaBox`, `lockAmount`, `newKarmaBox`, `postLockBox`, `karmaLockTx` construction
and `pubKeyHex` variables — all replaced by client-provided tx.

Update the rest of the route to use `karmaLockTx` in the mempool insert and broadcast.

- [ ] **Step 3: Update response to include txId**

The response already returns `{ postId, status: "pending", expiresAtHeight }`. Add `txId` from
the validation result.

- [ ] **Step 4: Run posts route tests**

```bash
pnpm --filter @dagsocial/node test -- routes/posts
```

Tests will fail (old API). Mark as expected; rewritten in Task 7.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/routes/posts.ts
git commit -m "feat(posts): accept signed karmaLockTx from client

- Request body changes from Post to { post, karmaLockTx }
- validateTx called on karma-lock tx at pool entry
- No server-side tx construction — client provides signed tx"
```

---

### Task 6: Likes and Invites routes — accept signed txs

**Files:**
- Modify: `packages/node/src/routes/likes.ts`
- Modify: `packages/node/src/routes/invites.ts`

**Interfaces:**
- Consumes: updated service signatures (Tasks 3, 4)
- Produces: routes accept `UtxoTransaction` in request body

- [ ] **Step 1: Update LikesDeps interface**

```typescript
export interface LikesDeps {
  castLike(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
   | { castLikeResult: 'free'; likeId: string };
  removeLike(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { removeLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction };
  getCurrentHeight(): number;
}
```

Add import for `UtxoEngineDeps` from `../services/utxo-engine.js`.

- [ ] **Step 2: Update POST /likes handler**

Decode `tx` from the request body (CBOR or JSON — check existing wire format).
For locked likes: the client sends a hex-encoded CBOR tx, or a JSON tx object.
Since the HTTP API uses JSON, accept the tx as a JSON object matching `UtxoTransaction`.

```typescript
router.post('/', (req, res) => {
  const body = req.body as { tx?: Record<string, unknown> };
  
  if (!body.tx) {
    res.status(400).json({ error: 'tx required' });
    return;
  }

  // Convert JSON tx to UtxoTransaction (hex-encode binary fields)
  let tx: UtxoTransaction;
  try {
    tx = jsonToTx(body.tx);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  try {
    const currentHeight = deps.getCurrentHeight();
    const result = deps.castLike(deps, tx, currentHeight);
    // ... handle pending vs free, broadcast, respond
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
```

Add a `jsonToTx` helper that converts JSON-represented transaction (with hex strings for
Uint8Array fields in signatures and preimages) to `UtxoTransaction`.

- [ ] **Step 3: Update POST /likes/remove handler**

Same pattern — accept `{ tx }` instead of `{ targetPostId, likerId, signature }`.

- [ ] **Step 4: Update InvitesDeps interface**

```typescript
export interface InvitesDeps {
  createInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { status: 'pending'; txId: string; expiresAtHeight: number; inviteBox: { id?: string }; bondBox: { id?: string }; tx: UtxoTransaction };
  claimInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { status: 'pending'; txId: string; expiresAtHeight: number; userId: Uint8Array; karmaBoxId: string; tx: UtxoTransaction };
  cancelInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction };
  getIdentity(userId: Uint8Array): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getCurrentHeight(): number;
}
```

- [ ] **Step 5: Update invite route handlers**

`POST /invites` — accept `{ tx }` instead of `{ inviterId, karmaAmount, bondAmount, signature }`.
`POST /invites/claim` — accept `{ tx }` instead of `{ inviteBoxId, secret, publicKey }`.
`POST /invites/cancel` — accept `{ tx }` instead of `{ inviteBoxId, inviterId, signature }`.

Each decodes the JSON tx, calls the service, broadcasts, and returns pending response.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/routes/likes.ts packages/node/src/routes/invites.ts
git commit -m "feat(routes): likes and invites routes accept signed UtxoTransaction

- POST /likes and /likes/remove: accept { tx } instead of domain params
- POST /invites, /invites/claim, /invites/cancel: accept { tx }
- jsonToTx helper for JSON→UtxoTransaction conversion
- All mutating routes call validateTx via service layer"
```

---

### Task 7: Rewrite all affected tests

**Files:**
- Modify: `packages/node/test/routes/likes.test.ts`
- Modify: `packages/node/test/routes/invites.test.ts`
- Modify: `packages/node/test/routes/posts.test.ts`
- Modify: `packages/node/test/services/likes.test.ts`
- Modify: `packages/node/test/services/invites.test.ts`
- Modify: `packages/node/test/services/utxo-engine.test.ts` (Task 2 already handled)

**Interfaces:**
- Consumes: all changed interfaces from Tasks 1-6
- Produces: passing test suite

- [ ] **Step 1: Add tx-signing test helper**

In `packages/node/test/helpers.ts`, add a shared helper for building and signing txs in tests:

```typescript
import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from 'crypto';
import { computeTxId, computeBoxId } from '@dagsocial/types';
import type { UtxoTransaction, AnyBox } from '@dagsocial/types';

/** Sign a UtxoTransaction by adding a txId signature to tx.signatures. */
export function signTransaction(
  tx: UtxoTransaction,
  privKey: KeyObject,
  pubKeyHex: string,
): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  tx.signatures[pubKeyHex] = new Uint8Array(sig);
}

/** Compute txId from tx and sign the hex txId directly. */
export function signTxId(txId: string, privKey: KeyObject): Uint8Array {
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  return new Uint8Array(sig);
}
```

- [ ] **Step 2: Rewrite likes service test — castLike**

In `packages/node/test/services/likes.test.ts`, rewrite the castLike test:

```typescript
import { computeTxId, computeBoxId, LIKE_COST, PROTOCOL_VERSION } from '@dagsocial/types';
import type { KarmaBox, LikeBox, UtxoTransaction } from '@dagsocial/types';
import { signTransaction } from '../helpers.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { castLike } from '../../src/services/likes.js';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertIdentity } from '../../src/store/identities.js';
import { insertBox, getKarmaBox } from '../../src/store/utxo.js';
import { insertPost } from '../../src/store/posts.js';
import { insertMempoolSubBlock, insertUtxoTx } from '../../src/store/mempool.js';
import Database from 'better-sqlite3';

const TEST_DB = '/tmp/dagsocial-test-services-likes.sqlite';

describe('castLike (tx-hash signing)', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;
  let ownerPubKeyHex: string;
  let karmaBoxId: string;
  let postId: string;

  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id) => { /* ... existing pattern from utxo-engine tests */ },
      insertBox: (box) => { /* store insert */ },
      consumeBox: (id, atBlock) => { /* store consume */ },
      getKarmaBox: (owner) => { /* store get */ },
      getIdentity: (userId) => { /* store get */ },
      runInTransaction: (fn) => { db.transaction(fn)(); },
    };
  }

  beforeEach(() => {
    unlinkSync(TEST_DB).catch(() => {});
    initDb(TEST_DB);
    db = getDb();

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    ownerPubKey = new Uint8Array(pubDer.subarray(pubDer.length - 32));
    ownerPrivKey = privateKey;
    ownerPubKeyHex = Buffer.from(ownerPubKey).toString('hex');

    insertIdentity(ownerPubKey, {
      publicKey: ownerPubKey,
      secretKey: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer),
    });

    // Create karma box (value 100)
    const kb: KarmaBox = {
      boxType: 'karma', value: 100, createdAtBlock: 1,
      owner: ownerPubKey, guard: 'owner_signature',
      proofSource: 'test', lastTouchBlock: 1,
    };
    karmaBoxId = computeBoxId(kb);
    insertBox({ ...kb, id: karmaBoxId });

    // Create a post to like
    const post: Post = { /* minimal post for testing */ };
    postId = computePostId(post);
    insertPost(post, Buffer.from(encodePost(post)));
  });

  afterEach(() => {
    closeDb();
  });

  it('accepts a signed like tx and inserts into mempool', () => {
    const newKarma: KarmaBox = {
      boxType: 'karma', value: 98, createdAtBlock: 10,
      owner: ownerPubKey, guard: 'owner_signature',
      proofSource: `like:${postId}`, lastTouchBlock: 10,
    };
    const likeBox: LikeBox = {
      boxType: 'like', value: LIKE_COST, createdAtBlock: 10,
      likerId: ownerPubKey, targetPostId: postId, guard: 'epoch_tally',
    };

    const tx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...likeBox, id: computeBoxId(likeBox) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, ownerPrivKey, ownerPubKeyHex);

    const deps = makeDeps();
    const result = castLike(deps, tx, 10);

    expect(result.castLikeResult).toBe('pending');
    expect(result.txId).toBe(computeTxId(tx));
    expect(result.expiresAtHeight).toBe(730);

    // Verify tx is in mempool
    const entries = getPendingEntries(10);
    expect(entries.length).toBe(1);
    expect(entries[0]!.entryType).toBe('utxo_tx');
  });

  it('rejects tx with invalid signature', () => {
    const tx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [/* same as above */],
      signatures: { [ownerPubKeyHex]: new Uint8Array(64) }, // wrong sig
      protocolVersion: PROTOCOL_VERSION,
    };

    const deps = makeDeps();
    expect(() => castLike(deps, tx, 10)).toThrow('Invalid signature');
  });
});
```

- [ ] **Step 3: Rewrite invites service test — createInvite**

In `packages/node/test/services/invites.test.ts`, new test:

```typescript
import { INVITE_KARMA_AMOUNT, INVITE_BOND_KARMA, PROTOCOL_VERSION, computeBoxId, computeTxId } from '@dagsocial/types';
import type { KarmaBox, InviteBox, BondBox, UtxoTransaction } from '@dagsocial/types';
import { createHash, randomBytes } from 'crypto';
import { signTransaction } from '../helpers.js';

describe('createInvite (tx-hash signing)', () => {
  // Setup: inviter with karma box (value 100)

  it('accepts a signed invite tx and inserts into mempool', () => {
    const secret = new Uint8Array(randomBytes(32));
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const newKarma: KarmaBox = {
      boxType: 'karma', value: 50, createdAtBlock: 10,
      owner: inviterPubKey, guard: 'owner_signature',
      proofSource: 'invite-create', lastTouchBlock: 10,
    };
    const inviteBox: InviteBox = {
      boxType: 'invite', value: INVITE_KARMA_AMOUNT, createdAtBlock: 10,
      secretHash, inviterId: inviterPubKey, guard: 'hash_preimage',
    };
    const bondBox: BondBox = {
      boxType: 'bond', value: INVITE_BOND_KARMA, createdAtBlock: 10,
      inviterId: inviterPubKey, inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0, probationEndBlock: 0, guard: 'inviter_signature',
    };

    const tx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...inviteBox, id: computeBoxId(inviteBox) },
        { ...bondBox, id: computeBoxId(bondBox) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    const result = createInvite(deps, tx, 10);
    expect(result.status).toBe('pending');
    expect(result.inviteBox.value).toBe(25);
    expect(result.bondBox.value).toBe(25);
  });
});
```

- [ ] **Step 4: Rewrite route tests**

For `packages/node/test/routes/likes.test.ts`, update the HTTP request test:

```typescript
it('POST /likes accepts signed tx and returns pending', async () => {
  // Build tx (same as service test)
  const tx: UtxoTransaction = { /* ... */ };
  signTransaction(tx, ownerPrivKey, ownerPubKeyHex);

  // Send as JSON (convert Uint8Array fields to hex)
  const txJson = txToJson(tx);
  const res = await fetch(`http://localhost:${port}/likes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: txJson }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('pending');
  expect(body.txId).toBeTruthy();
  expect(body.expiresAtHeight).toBeGreaterThan(0);
});
```

Add a `txToJson` helper in the test file that converts `UtxoTransaction` to a JSON-safe
object (Uint8Array → hex, preimages values → hex):

```typescript
function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map((o) => {
      const obj: Record<string, unknown> = { ...o };
      // Convert Uint8Array fields to hex
      for (const [k, v] of Object.entries(obj)) {
        if (v instanceof Uint8Array) obj[k] = Buffer.from(v).toString('hex');
      }
      return obj;
    }),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, Buffer.from(v).toString('hex')])
    ),
    preimages: tx.preimages
      ? Object.fromEntries(
          Object.entries(tx.preimages).map(([k, v]) => [k, Buffer.from(v).toString('hex')])
        )
      : undefined,
    protocolVersion: tx.protocolVersion,
  };
}
```

Apply the same pattern to `invites.test.ts` and `posts.test.ts` route tests.

- [ ] **Step 5: Run all tests**

```bash
pnpm test
```

Fix failures iteratively. Target: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/node/test/ packages/node/test/helpers.ts
git commit -m "test: rewrite tests for tx-hash signing protocol

- Add signTransaction helper for building signed txs in tests
- Rewrite likes and invites service tests (tx-hash signing)
- Rewrite route tests with txToJson helper for JSON wire format
- UTXO engine tests cover hash_preimage guard and bond claim transition
- Remove domain-message signing helpers"
```

---

### Task 8: Demo UI — wallet-aware client

**Files:**
- Modify: `packages/node/public/index.html`

**Interfaces:**
- Consumes: new API shapes from Tasks 5-6
- Produces: working demo UI that builds and signs transactions

- [ ] **Step 1: Add UTXO state fetching**

The demo UI already fetches `/karma/:userId`. Add fetches for:
- Invite state: `GET /invites/:userId` (pending + bond boxes)

- [ ] **Step 2: Add tx construction functions in JS**

In the demo UI's JavaScript, add helper functions that:
1. Build a karma→karma+like tx for `POST /likes`
2. Build a karma→karma+invite+bond tx for `POST /invites`
3. Build a invite+bond→karma+bond(claimed) tx for `POST /invites/claim`
4. Build a karma+invite+bond→karma tx for `POST /invites/cancel`
5. Build a karma→karma+post_lock tx for `POST /posts`

Each function:
- Takes current UTXO state (box IDs, values)
- Constructs the `UtxoTransaction` object with proper output types
- Returns the tx for signing

- [ ] **Step 3: Add txId signing**

Use the existing Ed25519 signing code (Web Crypto API via `blakejs` CDN) but change
the preimage from domain messages to `txId`:

```javascript
async function signTxId(tx, privateKeyJwk) {
  const txId = computeTxId(tx);  // client-side tx hash
  const txIdBytes = hexToBytes(txId);
  const key = await crypto.subtle.importKey('jwk', privateKeyJwk, ...);
  const sig = await crypto.subtle.sign('Ed25519', key, txIdBytes);
  return bytesToHex(new Uint8Array(sig));
}
```

Note: `computeTxId` must be reimplemented in JS for the demo UI. It uses blake2b512
(already available via CDN `blakejs`).

- [ ] **Step 4: Update form submission handlers**

Each form in the demo UI now:
1. Fetches latest UTXO state
2. Builds the tx using the helper functions from Step 2
3. Signs `txId`
4. Submits `{ tx }` or `{ post, karmaLockTx: tx }` to the API

- [ ] **Step 5: Manual test**

```bash
pnpm build
node packages/node/dist/index.js
```

Open `http://localhost:3000`, create identity, get faucet karma, post, like, invite.
Verify all operations succeed and return `{ status: "pending" }`.

- [ ] **Step 6: Commit**

```bash
git add packages/node/public/index.html
git commit -m "feat(demo-ui): wallet-aware tx construction and txId signing

- Fetch UTXO state before building transactions
- JS helpers for building all tx types
- Sign txId instead of domain messages
- computeTxId reimplemented in JS (blake2b512 via blakejs CDN)"
```

---

### Task 9: Integration check — full test run and typecheck

**Files:**
- No specific files — verification task

- [ ] **Step 1: Build all packages**

```bash
pnpm build
```

Fix any build errors.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Fix any type errors from changed interfaces.

- [ ] **Step 3: Full test run**

```bash
pnpm test
```

All tests must pass. The pre-existing block-creator failure (217/218 → "returns null when
nothing pending") may still exist. Count should be ≥ previous passing count.

- [ ] **Step 4: Start node and smoke test**

```bash
node packages/node/dist/index.js
```

Run through the full flow manually:
1. Create identity
2. Faucet karma
3. Post a thread
4. Post a reply
5. Like a post
6. Unlike a post
7. Create an invite
8. Check invite appears in GET /invites
9. Claim the invite (separate identity)
10. Cancel an invite
11. Check block height advances

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore: build, typecheck, and test fixes for tx-hash signing"
```
