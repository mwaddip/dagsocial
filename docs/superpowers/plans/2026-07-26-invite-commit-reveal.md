# Invite Commit-Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-phase commit-reveal flow to the invite system that binds the invitee's identity to the BondBox before the secret hits the mempool, closing the frontrunning vulnerability.

**Architecture:** The BondBox guard changes from `inviter_signature` (single path) to `bond_dual` (two paths: inviter reclaims OR invitee commits). The InviteBox guard changes from `hash_preimage` to `hash_preimage_with_bond` (requires preimage + committed BondBox with matching pubkey). A new `commitInvite` service spends only the BondBox to lock in the invitee's identity. The existing `claimInvite` (now "reveal") consumes both InviteBox and committed BondBox together.

**Tech Stack:** TypeScript, Express, better-sqlite3, cbor-x, Ed25519, blake2b512

## Global Constraints

- Protocol version: 1 (unchanged, no wire break)
- No WASM dependencies in TypeScript packages
- Pure functions only in `@dagsocial/types`
- Secret keys never in API responses
- All hashing: `blake2b512` with `.subarray(0, 32)`
- Value conservation enforced by UTXO engine

---

### Task 1: Types — Update InviteBox, BondBox, and BoxGuard

**Files:**
- Modify: `packages/types/src/utxo.ts:33,75-93`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `BoxGuard` union: adds `'bond_dual' | 'hash_preimage_with_bond'`
  - `BondBox` interface: adds `inviteBoxId: BoxId`, guard changes to `'bond_dual'`
  - `InviteBox` interface: guard changes to `'hash_preimage_with_bond'`

- [ ] **Step 1: Update BoxGuard union type**

In `packages/types/src/utxo.ts`, line 33, replace:
```ts
export type BoxGuard = 'owner_signature' | 'epoch_tally' | 'hash_preimage' | 'inviter_signature';
```
with:
```ts
export type BoxGuard = 'owner_signature' | 'epoch_tally' | 'hash_preimage' | 'inviter_signature' | 'bond_dual' | 'hash_preimage_with_bond';
```

- [ ] **Step 2: Update InviteBox guard**

In `packages/types/src/utxo.ts`, lines 75-81, replace the InviteBox interface:
```ts
export interface InviteBox extends BoxBase {
  boxType: 'invite';
  value: number;              // N karma transferred
  secretHash: Uint8Array;     // 32 bytes — H(s) = blake2b512(s).subarray(0,32)
  inviterId: UserId;
  guard: 'hash_preimage';     // Unlocked by preimage + publicKey not in ledger
}
```
with:
```ts
export interface InviteBox extends BoxBase {
  boxType: 'invite';
  value: number;                    // N karma transferred
  secretHash: Uint8Array;           // 32 bytes — H(s) = blake2b512(s).subarray(0,32)
  inviterId: UserId;
  guard: 'hash_preimage_with_bond'; // Unlocked by preimage + committed BondBox
}
```

- [ ] **Step 3: Update BondBox — add inviteBoxId, change guard**

In `packages/types/src/utxo.ts`, lines 85-93, replace the BondBox interface:
```ts
export interface BondBox extends BoxBase {
  boxType: 'bond';
  value: number;                    // D karma deposited
  inviterId: UserId;               // Owner — the inviter
  inviteePublicKey: Uint8Array;    // 32 raw bytes — set when invite is claimed
  probationStartBlock: number;     // Set when invite is claimed
  probationEndBlock: number;       // probationStartBlock + INVITE_PROBATION_BLOCKS
  guard: 'inviter_signature';     // Only inviter may reclaim
}
```
with:
```ts
export interface BondBox extends BoxBase {
  boxType: 'bond';
  value: number;                    // D karma deposited
  inviterId: UserId;               // Owner — the inviter
  inviteBoxId: BoxId;              // Which InviteBox this pairs with (for commit secret lookup)
  inviteePublicKey: Uint8Array;    // 32 raw bytes — set during commit
  probationStartBlock: number;     // Set during commit
  probationEndBlock: number;       // probationStartBlock + INVITE_PROBATION_BLOCKS
  guard: 'bond_dual';              // inviter_signature (reclaim) OR hash_preimage (commit)
}
```

- [ ] **Step 4: Run typecheck to verify**

```bash
pnpm typecheck
```
Expected: zero errors. All downstream code will fail at this point — that's expected and will be fixed in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/utxo.ts
git commit -m "feat(types): add bond_dual and hash_preimage_with_bond guards, add inviteBoxId to BondBox

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Store — Update BondExtra, rowToBox, and insertBox

**Files:**
- Modify: `packages/node/src/store/utxo.ts:54-59,141-168,461-474`
- Modify: `packages/node/src/store/db.ts:62-74` (add migration for stale data)

**Interfaces:**
- Consumes: BondBox with `inviteBoxId` and `bond_dual` guard, InviteBox with `hash_preimage_with_bond` guard
- Produces: Updated store serialization/deserialization

- [ ] **Step 1: Add inviteBoxId to BondExtra**

In `packages/node/src/store/utxo.ts`, lines 54-59, replace:
```ts
interface BondExtra {
  inviterId: string;     // hex-encoded pubkey in JSON (Uint8Array in code)
  inviteePublicKey: number[] | null;
  probationStartBlock: number | null;
  probationEndBlock: number | null;
}
```
with:
```ts
interface BondExtra {
  inviterId: string;                // hex-encoded pubkey in JSON (Uint8Array in code)
  inviteBoxId: string;              // BoxId of the paired InviteBox
  inviteePublicKey: number[] | null;
  probationStartBlock: number | null;
  probationEndBlock: number | null;
}
```

- [ ] **Step 2: Update rowToBox for invite case (guard name)**

In `packages/node/src/store/utxo.ts`, line 150, change the invite case guard:
```ts
guard: 'hash_preimage',
```
to:
```ts
guard: 'hash_preimage_with_bond',
```

- [ ] **Step 3: Update rowToBox for bond case (inviteBoxId + guard name)**

In `packages/node/src/store/utxo.ts`, lines 154-168, replace:
```ts
    case 'bond': {
      const e = extra as BondExtra;
      return {
        id: row.id,
        boxType: 'bond',
        value: row.value,
        createdAtBlock: row.created_at_block,
        inviterId: hexToPubkey(e.inviterId),
        inviteePublicKey: e.inviteePublicKey
          ? new Uint8Array(e.inviteePublicKey)
          : new Uint8Array(0),
        probationStartBlock: e.probationStartBlock ?? 0,
        probationEndBlock: e.probationEndBlock ?? 0,
        guard: 'inviter_signature',
      } satisfies BondBox as BondBox;
    }
```
with:
```ts
    case 'bond': {
      const e = extra as BondExtra;
      return {
        id: row.id,
        boxType: 'bond',
        value: row.value,
        createdAtBlock: row.created_at_block,
        inviterId: hexToPubkey(e.inviterId),
        inviteBoxId: e.inviteBoxId ?? '',
        inviteePublicKey: e.inviteePublicKey
          ? new Uint8Array(e.inviteePublicKey)
          : new Uint8Array(0),
        probationStartBlock: e.probationStartBlock ?? 0,
        probationEndBlock: e.probationEndBlock ?? 0,
        guard: 'bond_dual',
      } satisfies BondBox as BondBox;
    }
```

- [ ] **Step 4: Update insertBox for bond case (add inviteBoxId)**

In `packages/node/src/store/utxo.ts`, lines 461-474, replace:
```ts
    case 'bond': {
      const b = box as BondBox;
      extraData = {
        inviterId: pubkeyToHex(b.inviterId),
        inviteePublicKey:
          b.inviteePublicKey.length > 0
            ? Array.from(b.inviteePublicKey)
            : null,
        probationStartBlock:
          b.probationStartBlock > 0 ? b.probationStartBlock : null,
        probationEndBlock:
          b.probationEndBlock > 0 ? b.probationEndBlock : null,
      } satisfies BondExtra;
      break;
    }
```
with:
```ts
    case 'bond': {
      const b = box as BondBox;
      extraData = {
        inviterId: pubkeyToHex(b.inviterId),
        inviteBoxId: b.inviteBoxId,
        inviteePublicKey:
          b.inviteePublicKey.length > 0
            ? Array.from(b.inviteePublicKey)
            : null,
        probationStartBlock:
          b.probationStartBlock > 0 ? b.probationStartBlock : null,
        probationEndBlock:
          b.probationEndBlock > 0 ? b.probationEndBlock : null,
      } satisfies BondExtra;
      break;
    }
```

- [ ] **Step 5: Add migration to clean stale bond/invite data with old guards**

In `packages/node/src/store/db.ts`, after the existing migrations (before line 120's `export function initDb`), add a new migration string inside the `MIGRATIONS` array as the last element:
```ts
  // Clean invite/bond boxes with old guard types (pre commit-reveal)
  `DELETE FROM utxo_boxes WHERE (box_type = 'invite' AND guard = 'hash_preimage') OR (box_type = 'bond' AND guard = 'inviter_signature')`,
```

- [ ] **Step 6: Run typecheck to verify**

```bash
pnpm typecheck
```
Expected: errors only in services, routes, and tests (will be fixed in subsequent tasks). No store errors.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/store/utxo.ts packages/node/src/store/db.ts
git commit -m "feat(store): add inviteBoxId to bond extra_data, update guards for commit-reveal

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: UTXO Engine — New guards and transitions

**Files:**
- Modify: `packages/node/src/services/utxo-engine.ts:1-11,119-145,259-261,397-428`

**Interfaces:**
- Consumes: BondBox with `bond_dual` guard and `inviteBoxId`, InviteBox with `hash_preimage_with_bond` guard
- Produces: `bond_dual` guard check (two paths), `hash_preimage_with_bond` guard check (cross-box), commit transition (bond→bond), updated reveal transition (accepts committed bond)

- [ ] **Step 1: Add InviteBox import**

In `packages/node/src/services/utxo-engine.ts`, the import on line 10 needs `InviteBox` added. It's already imported:
```ts
import type { UtxoTransaction, AnyBox, KarmaBox, BondBox, InviteBox, LikeBox } from '@dagsocial/types';
```
No change needed — already imported.

- [ ] **Step 2: Replace inviter_signature guard with bond_dual guard**

In `packages/node/src/services/utxo-engine.ts`, lines 419-428, replace the `inviter_signature` case:
```ts
      case 'inviter_signature': {
        const bondBox = box as BondBox;
        // inviterId IS the 32-byte Ed25519 public key — no identity lookup needed
        if (!verifyGuardSignature(tx, txHash, bondBox.inviterId)) {
          return {
            valid: false,
            error: `Missing or invalid inviter signature for box ${box.id}`,
          };
        }
        break;
      }
```
with:
```ts
      case 'bond_dual': {
        const bondBox = box as BondBox;
        // Path 1: inviter_signature — inviter reclaims the bond
        if (verifyGuardSignature(tx, txHash, bondBox.inviterId)) {
          break;
        }
        // Path 2: hash_preimage — invitee commits their identity
        const bondPreimage = tx.preimages?.[box.id!];
        if (!bondPreimage) {
          return {
            valid: false,
            error: `Bond box ${box.id} requires inviter signature or preimage for commit`,
          };
        }
        // Look up the paired InviteBox to get the expected secretHash
        const pairedInviteBox = deps.getBox(bondBox.inviteBoxId);
        if (!pairedInviteBox || pairedInviteBox.boxType !== 'invite') {
          return {
            valid: false,
            error: `InviteBox ${bondBox.inviteBoxId} not found for bond commit`,
          };
        }
        const expectedHash = (pairedInviteBox as InviteBox).secretHash;
        const computedHash = createHash('blake2b512')
          .update(Buffer.from(bondPreimage))
          .digest()
          .subarray(0, 32);
        if (Buffer.from(computedHash).toString('hex') !== Buffer.from(expectedHash).toString('hex')) {
          return {
            valid: false,
            error: `Hash preimage mismatch for bond commit on box ${box.id}`,
          };
        }
        // Must have at least one signature (service layer verifies pubkey match)
        if (Object.keys(tx.signatures).length === 0) {
          return {
            valid: false,
            error: `Bond commit requires a signature from the invitee`,
          };
        }
        break;
      }
```

- [ ] **Step 3: Replace hash_preimage guard with hash_preimage_with_bond guard**

In `packages/node/src/services/utxo-engine.ts`, lines 397-416, replace the `hash_preimage` case:
```ts
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
with:
```ts
      case 'hash_preimage_with_bond': {
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
        // Cross-box check: a BondBox input in the same tx must be committed
        // to the tx signer's pubkey
        const bondInput = inputBoxes.find((b): b is BondBox => b.boxType === 'bond');
        if (!bondInput) {
          return {
            valid: false,
            error: `Invite claim requires a BondBox input alongside the InviteBox`,
          };
        }
        if (bondInput.inviteePublicKey.length !== 32) {
          return {
            valid: false,
            error: `BondBox must be committed (inviteePublicKey set) before reveal`,
          };
        }
        // The tx must be signed by the committed invitee
        if (!verifyGuardSignature(tx, txHash, bondInput.inviteePublicKey)) {
          return {
            valid: false,
            error: `Reveal must be signed by the committed invitee`,
          };
        }
        break;
      }
```

- [ ] **Step 4: Update reveal transition — accept committed BondBox**

In `packages/node/src/services/utxo-engine.ts`, lines 119-145, replace the invite claim transition check:
```ts
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
```
with:
```ts
  // Handle invite claim (reveal): InviteBox + BondBox(committed) → KarmaBox + BondBox(probation)
  if (inputs.length === 2) {
    const hasInvite = inputs.some((b) => b.boxType === 'invite');
    const hasBond = inputs.some((b) => b.boxType === 'bond');
    if (hasInvite && hasBond) {
      const bondIn = inputs.find((b) => b.boxType === 'bond') as BondBox;
      const karmaOuts = outputs.filter((o) => o.boxType === 'karma');
      const bondOuts = outputs.filter((o) => o.boxType === 'bond');

      // Bond must already be committed (inviteePublicKey set to 32 bytes)
      if (bondIn.inviteePublicKey.length === 32 &&
          bondOuts.length === 1 &&
          karmaOuts.length === 1 &&
          outputs.length === 2) {
        const bondOut = bondOuts[0] as BondBox;
        // BondOut must preserve commitment fields from commit step
        if (bondOut.inviteePublicKey.length === 32 &&
            Buffer.from(bondOut.inviteePublicKey).toString('hex') ===
              Buffer.from(bondIn.inviteePublicKey).toString('hex') &&
            bondOut.probationStartBlock === bondIn.probationStartBlock &&
            bondOut.probationEndBlock === bondIn.probationEndBlock) {
          return { valid: true };
        }
      }
      return {
        valid: false,
        error: `Invalid invite reveal: BondBox must be committed and preservation fields must match`,
      };
    }
  }
```

- [ ] **Step 5: Add bond commit transition (BondBox → BondBox)**

In `packages/node/src/services/utxo-engine.ts`, in the bond case of `checkTransitions` (lines 259-272), add the commit path before the existing burn and bond→karma paths:
```ts
    case 'bond': {
      // Bond commit: BondBox(unclaimed) → BondBox(committed)
      const bondOuts = outputs.filter((o) => o.boxType === 'bond');
      if (bondOuts.length === 1 && outputs.length === 1) {
        const bondIn = inputs[0] as BondBox;
        const bondOut = bondOuts[0] as BondBox;
        if (bondIn.inviteePublicKey.length === 0 &&
            bondOut.inviteePublicKey.length === 32 &&
            bondOut.probationStartBlock > 0 &&
            bondOut.probationEndBlock > bondOut.probationStartBlock) {
          return { valid: true };
        }
        return {
          valid: false,
          error: `Invalid bond commit: inviteePublicKey must go from empty to 32 bytes with probation set`,
        };
      }
      // Existing: burn or bond → karma
      if (outputs.length === 0) {
        // Burn — valid
        return { valid: true };
      }
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      if (karmaOutputs.length !== 1 || outputs.length !== 1) {
        return {
          valid: false,
          error: `BondBox can only be spent to create exactly 1 KarmaBox, 1 committed BondBox, or burned`,
        };
      }
      return { valid: true };
    }
```

- [ ] **Step 6: Run typecheck**

```bash
pnpm typecheck
```
Expected: errors only in services/invites.ts, routes/invites.ts, and tests. No engine errors.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/services/utxo-engine.ts
git commit -m "feat(engine): add bond_dual and hash_preimage_with_bond guards, commit/reveal transitions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Invites Service — Add commitInvite, modify claimInvite and cancelInvite

**Files:**
- Modify: `packages/node/src/services/invites.ts`

**Interfaces:**
- Consumes: new guards and transitions from Task 3, new types from Task 1
- Produces: `commitInvite(deps, tx, currentBlockHeight) => { status, txId, expiresAtHeight, bondBoxId, tx }`

- [ ] **Step 1: Update imports**

No new imports needed — `INVITE_KARMA_AMOUNT`, `INVITE_BOND_KARMA`, `INVITE_PROBATION_BLOCKS`, `MEMPOOL_EXPIRY_BLOCKS` are already imported. The new types (`BondBox`, `InviteBox`) are already imported.

- [ ] **Step 2: Add commitInvite function**

Insert after the `createInvite` function (after line 138, before the `claimInvite` doc comment) in `packages/node/src/services/invites.ts`:

```ts
/**
 * Commit to an invite by spending the BondBox to lock in the invitee's identity.
 *
 * The invitee builds a tx spending only the BondBox. The bond_dual guard's
 * hash_preimage path verifies that the preimage matches the InviteBox's
 * secretHash. The transition records the invitee's public key and starts
 * probation timers.
 *
 * The commit is **pending** until the next ordering block is confirmed.
 * Once committed, the invitee must reveal (claimInvite) to get their karma.
 */
export function commitInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  bondBoxId: string;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract BondBox from inputs ----
  if (tx.inputs.length !== 1) {
    throw new Error('Commit transaction must have exactly one input (BondBox)');
  }
  const bondBoxId = tx.inputs[0]!;
  const bondBoxInput = deps.getBox(bondBoxId);
  if (!bondBoxInput || bondBoxInput.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  const bondIn = bondBoxInput as BondBox;

  // ---- 2. Verify BondBox is unclaimed ----
  if (bondIn.inviteePublicKey.length > 0) {
    throw new Error('BondBox already committed');
  }

  // ---- 3. Verify exactly 1 BondBox output ----
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');
  if (tx.outputs.length !== 1 || bondOutputs.length !== 1) {
    throw new Error('Commit transaction must produce exactly 1 BondBox output');
  }
  const bondOut = bondOutputs[0] as BondBox;

  // ---- 4. Verify output BondBox has valid commitment shape ----
  if (bondOut.inviteePublicKey.length !== 32) {
    throw new Error('Commit output BondBox must have 32-byte inviteePublicKey');
  }

  // ---- 5. Verify tx is signed by the invitee (bond output pubkey) ----
  const inviteePubKeyHex = Buffer.from(bondOut.inviteePublicKey).toString('hex');
  if (!tx.signatures[inviteePubKeyHex]) {
    throw new Error('Commit transaction must be signed by the invitee');
  }

  // ---- 6. Validate transaction (guards, transitions) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid commit transaction: ${result.error}`);
  }

  // ---- 7. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 8. Return result ----
  const txId = computeTxId(tx);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    bondBoxId,
    tx,
  };
}
```

- [ ] **Step 3: Modify claimInvite — require committed BondBox**

In `packages/node/src/services/invites.ts`, in the `claimInvite` function, after finding the bondBox (after line 177), add a committed check. Insert after the `if (!bondBoxId)` check (line 176):

```ts
  // ---- Verify bond box is committed (inviteePublicKey set) ----
  const bondBox = deps.getBox(bondBoxId);
  if (!bondBox || bondBox.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  const bond = bondBox as BondBox;
  if (bond.inviteePublicKey.length !== 32) {
    throw new Error('BondBox must be committed before reveal');
  }
```

And remove the duplicate `const bondBox = deps.getBox(bondBoxId)` check that comes later in the existing code — actually, looking at the code again, the existing code only looks up the invite box at line 180 (`const inviteBox = deps.getBox(inviteBoxId)`), not the bond box. The bond box was only identified by ID, not loaded. So this bond lookup is new. The existing code has:

```ts
  if (!inviteBoxId) {
    throw new Error('Transaction does not consume an InviteBox');
  }
  if (!bondBoxId) {
    throw new Error('Transaction does not consume a BondBox');
  }

  // ---- 2. Verify invite box exists, is unspent, is type invite ----
  const inviteBox = deps.getBox(inviteBoxId);
```

So I need to:
1. Add bond lookup after the invite lookup
2. Add committed check
3. Remove the duplicate lookup in the cancel section (irrelevant for claim)

Let me write the replacement for the section from line 179 to 195 (the verify invite box + verify invitee not already account block):

After finding inviteBoxId and bondBoxId (lines 163-177), replace lines 179-195:
```ts
  // ---- 2. Verify invite box exists, is unspent, is type invite ----
  const inviteBox = deps.getBox(inviteBoxId);
  if (!inviteBox || inviteBox.boxType !== 'invite') {
    throw new Error(`Invite box not found: ${inviteBoxId}`);
  }

  // ---- 2.5. Verify bond box is committed ----
  const bondBoxForClaim = deps.getBox(bondBoxId);
  if (!bondBoxForClaim || bondBoxForClaim.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  const bondForClaim = bondBoxForClaim as BondBox;
  if (bondForClaim.inviteePublicKey.length !== 32) {
    throw new Error('BondBox must be committed before reveal');
  }

  // ---- 3. Verify invitee public key is not already an account ----
```
Keep the rest unchanged (lines 186-220 in the file, which is the invitee check + validateTx + mempool insert + return).

- [ ] **Step 4: Modify cancelInvite — allow committed BondBox**

In `packages/node/src/services/invites.ts`, lines 275-294, remove the "already claimed" check. Replace:
```ts
  // ---- 3.5. Verify bond box is unclaimed ----
  let bondBoxId: string | undefined;
  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box?.boxType === 'bond') {
      bondBoxId = inputId;
      break;
    }
  }
  if (!bondBoxId) {
    throw new Error('Transaction does not consume a BondBox');
  }
  const bondBox = deps.getBox(bondBoxId);
  if (!bondBox || bondBox.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  const bond = bondBox as BondBox;
  if (bond.inviteePublicKey && bond.inviteePublicKey.length > 0) {
    throw new Error('Invite already claimed');
  }
```
with:
```ts
  // ---- 3.5. Verify bond box exists ----
  let bondBoxId: string | undefined;
  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box?.boxType === 'bond') {
      bondBoxId = inputId;
      break;
    }
  }
  if (!bondBoxId) {
    throw new Error('Transaction does not consume a BondBox');
  }
  const bondBox = deps.getBox(bondBoxId);
  if (!bondBox || bondBox.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  // Cancel works on both unclaimed and committed BondBoxes.
  // The inviter_signature path on bond_dual allows the inviter to reclaim
  // regardless of commit state.
```

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```
Expected: zero errors (or only test fixture errors at this point).

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/invites.ts
git commit -m "feat(invites): add commitInvite, require committed bond for reveal, allow cancel on committed bond

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Routes — Add POST /invites/commit endpoint

**Files:**
- Modify: `packages/node/src/routes/invites.ts`

**Interfaces:**
- Consumes: `commitInvite` from Task 4
- Produces: `POST /invites/commit` endpoint

- [ ] **Step 1: Add commitInvite to InvitesDeps interface**

In `packages/node/src/routes/invites.ts`, in the `InvitesDeps` interface (after `cancelInvite` signature, before `getCurrentHeight`), add:
```ts
  commitInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    bondBoxId: string;
    tx: UtxoTransaction;
  };
```

- [ ] **Step 2: Add commitInvite to function import**

At the top of the file, the imports from services/invites:
```ts
import {
  createInvite,
  claimInvite,
  cancelInvite,
} from '../services/invites.js';
```
Add `commitInvite`:
```ts
import {
  createInvite,
  claimInvite,
  cancelInvite,
  commitInvite,
} from '../services/invites.js';
```

- [ ] **Step 3: Add POST /invites/commit route**

Insert after the create route (`POST /`) and before the claim route (`POST /claim`), in `packages/node/src/routes/invites.ts`:

```ts
  // POST /invites/commit — commit to an invite (bind invitee identity to BondBox)
  router.post('/commit', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.commitInvite(deps, tx, currentHeight);

      // Broadcast commit tx to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast commit tx: ${err.message}`);
        });
      }

      res.status(201).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
        bondBoxId: result.bondBoxId,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('already committed')) {
        res.status(409).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });
```

- [ ] **Step 4: Update server wiring — add commitInvite to deps**

In `packages/node/src/server.ts`, line 17, change:
```ts
import { createInvite, claimInvite, cancelInvite } from './services/invites.js';
```
to:
```ts
import { createInvite, claimInvite, cancelInvite, commitInvite } from './services/invites.js';
```

In `packages/node/src/server.ts`, after line 118 (`cancelInvite,`), add:
```ts
      commitInvite,
```

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```
Expected: zero errors. Tests will fail — that's for the next tasks.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/routes/invites.ts packages/node/src/server.ts
git commit -m "feat(routes): add POST /invites/commit endpoint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Note: Step 4 requires reading `packages/node/src/server.ts` to find the exact location for wiring. The implementer should check the exact line before editing.

---

### Task 6: Service Tests — Add commitInvite tests, update fixtures

**Files:**
- Modify: `packages/node/test/services/invites.test.ts`
- Modify: `packages/node/test/helpers.ts` (no changes needed, but verify)

**Interfaces:**
- Consumes: all changes from Tasks 1-5
- Produces: updated/added test coverage

- [ ] **Step 1: Update insertInviteBox helper — change guard**

In `packages/node/test/services/invites.test.ts`, lines 66-78, replace the `insertInviteBox` function:
```ts
function insertInviteBox(
  value: number,
  createdAtBlock: number,
  secretHash: Uint8Array,
  inviterId: Uint8Array,
): InviteBox {
  const box: Omit<InviteBox, 'id'> & { id?: string } = {
    boxType: 'invite',
    value,
    createdAtBlock,
    secretHash,
    inviterId,
    guard: 'hash_preimage',
  };
  const id = computeBoxId(box);
  const full: InviteBox = { ...box, id, boxType: 'invite', guard: 'hash_preimage' };
  storeInsertBox(full);
  return full;
}
```
with:
```ts
function insertInviteBox(
  value: number,
  createdAtBlock: number,
  secretHash: Uint8Array,
  inviterId: Uint8Array,
): InviteBox {
  const box: Omit<InviteBox, 'id'> & { id?: string } = {
    boxType: 'invite',
    value,
    createdAtBlock,
    secretHash,
    inviterId,
    guard: 'hash_preimage_with_bond',
  };
  const id = computeBoxId(box);
  const full: InviteBox = { ...box, id, boxType: 'invite', guard: 'hash_preimage_with_bond' };
  storeInsertBox(full);
  return full;
}
```

- [ ] **Step 2: Update insertBondBox helper — add inviteBoxId, change guard**

In `packages/node/test/services/invites.test.ts`, lines 81-100, replace:
```ts
function insertBondBox(
  value: number,
  createdAtBlock: number,
  inviterId: Uint8Array,
): BondBox {
  const box: Omit<BondBox, 'id'> & { id?: string } = {
    boxType: 'bond',
    value,
    createdAtBlock,
    inviterId,
    inviteePublicKey: new Uint8Array(0),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'inviter_signature',
  };
  const id = computeBoxId(box);
  const full: BondBox = { ...box, id, boxType: 'bond', guard: 'inviter_signature' };
  storeInsertBox(full);
  return full;
}
```
with:
```ts
function insertBondBox(
  value: number,
  createdAtBlock: number,
  inviterId: Uint8Array,
  inviteBoxId: string,
): BondBox {
  const box: Omit<BondBox, 'id'> & { id?: string } = {
    boxType: 'bond',
    value,
    createdAtBlock,
    inviterId,
    inviteBoxId,
    inviteePublicKey: new Uint8Array(0),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'bond_dual',
  };
  const id = computeBoxId(box);
  const full: BondBox = { ...box, id, boxType: 'bond', guard: 'bond_dual' };
  storeInsertBox(full);
  return full;
}
```

- [ ] **Step 3: Update test 1 (createInvite) — change guards and add inviteBoxId**

In the `createInvite returns pending` test (around lines 191-212), update the invite box guard and bond box guard + add inviteBoxId. The inviteBox variable needs `guard: 'hash_preimage_with_bond'` and the bondBox needs `guard: 'bond_dual'` and `inviteBoxId`. Since the inviteBoxId is computed, we need to compute it first:

After computing `inviteBoxId = computeBoxId(inviteBox)`, update the bondBox definition:
```ts
    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteBoxId: inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
```
And inviteBox:
```ts
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 1,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
```

- [ ] **Step 4: Update test 2 (claimInvite) — use committed BondBox, add commit step**

This test needs to be restructured. The claim now requires the BondBox to be committed first. Replace the test (lines 243-316) with a two-step test:

1. First, create and commit the BondBox (via commitInvite)
2. Then, claim via claimInvite

```ts
  it('commit + reveal full lifecycle', () => {
    const karma = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    // Manually insert invite and bond boxes into UTXO (simulating confirmed create)
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // ---- Step 1: Commit ----
    const bondOutCommitted: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutCommittedId = computeBoxId(bondOutCommitted);

    const commitTx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOutCommitted, id: bondOutCommittedId }],
      signatures: {},
      preimages: { [bondBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(commitTx, inviteePrivKey, inviteePubKeyHex);

    const commitResult = commitInvite(deps, commitTx, 3);
    expect(commitResult.status).toBe('pending');
    expect(commitResult.bondBoxId).toBe(bondBox.id);

    // ---- Step 2: Reveal (claim) ----
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 5,
      owner: inviteePubKey,
      guard: 'owner_signature',
      proofSource: `invite-claim:${inviteBox.id}`,
      lastTouchBlock: 5,
    };
    const karmaOutId = computeBoxId(karmaOut);

    // BondOut preserves commitment fields
    const bondOutReveal: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutRevealId = computeBoxId(bondOutReveal);

    const revealTx: UtxoTransaction = {
      inputs: [inviteBox.id!, bondBox.id!],
      outputs: [
        { ...karmaOut, id: karmaOutId },
        { ...bondOutReveal, id: bondOutRevealId },
      ],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(revealTx, inviteePrivKey, inviteePubKeyHex);

    const claimResult = claimInvite(deps, revealTx, 5);

    expect(claimResult.status).toBe('pending');
    expect(claimResult.txId).toBeDefined();
    expect(claimResult.userId).toEqual(inviteePubKey);
    expect(claimResult.karmaBoxId).toBeDefined();
  });
```

- [ ] **Step 5: Add commit-only test**

```ts
  it('commitInvite returns pending and inserts into mempool', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 5,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutId = computeBoxId(bondOut);

    const tx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOut, id: bondOutId }],
      signatures: {},
      preimages: { [bondBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    const result = commitInvite(deps, tx, 5);

    expect(result.status).toBe('pending');
    expect(result.txId).toBeDefined();
    expect(typeof result.txId).toBe('string');
    expect(result.expiresAtHeight).toBe(5 + 720);
    expect(result.bondBoxId).toBe(bondBox.id);

    // Verify mempool has the commit entry
    const entries = getPendingEntries(100);
    const matching = entries.filter((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const storedTx = decodeTx(e.utxoTxCbor);
      return storedTx.inputs.length === 1 && storedTx.outputs.length === 1;
    });
    expect(matching.length).toBe(1);
  });
```

- [ ] **Step 6: Add commit-failure tests**

```ts
  it('Commit fails with wrong secret', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const wrongSecret = new Uint8Array(32).fill(0xff);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 5,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOut, id: computeBoxId(bondOut) }],
      signatures: {},
      preimages: { [bondBox.id!]: wrongSecret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    expect(() => commitInvite(deps, tx, 5)).toThrow('Invalid commit transaction');
  });

  it('Commit fails if BondBox already committed', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate confirmed commit by marking bond box as spent
    const db = getDb();
    db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(3, bondBox.id);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 5,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOut, id: computeBoxId(bondOut) }],
      signatures: {},
      preimages: { [bondBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    expect(() => commitInvite(deps, tx, 5)).toThrow('already committed');
  });
```

- [ ] **Step 7: Add reveal-failure test (pubkey mismatch / frontrun attempt)**

```ts
  it('Reveal fails if BondBox committed to different pubkey', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate BondBox committed to a different pubkey (attacker's)
    const attackerKeys = generateKeyPairSync('ed25519');
    const attackerPubKey = rawPublicKey(attackerKeys.publicKey);
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(attackerPubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 5,
      owner: inviteePubKey,
      guard: 'owner_signature',
      proofSource: `invite-claim:${inviteBox.id}`,
      lastTouchBlock: 5,
    };
    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: attackerPubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [inviteBox.id!, bondBox.id!],
      outputs: [
        { ...karmaOut, id: computeBoxId(karmaOut) },
        { ...bondOut, id: computeBoxId(bondOut) },
      ],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    // Invitee signs, but bond is committed to attacker
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    expect(() => claimInvite(deps, tx, 5)).toThrow('Invalid invite claim transaction');
  });
```

- [ ] **Step 8: Add cancel-on-committed-bond test**

```ts
  it('Cancel succeeds on committed BondBox', () => {
    const karmaIn = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0xaa);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate committed BondBox by updating extra_data
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

    const totalValue = 100 + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      createdAtBlock: 10,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBox.id}`,
      lastTouchBlock: 10,
    };

    const tx: UtxoTransaction = {
      inputs: [karmaIn.id!, inviteBox.id!, bondBox.id!],
      outputs: [{ ...newKarma, id: computeBoxId(newKarma) }],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    const result = cancelInvite(deps, tx, 10);
    expect(result.status).toBe('pending');
  });
```

- [ ] **Step 9: Update all remaining test fixtures**

Update tests 4, 5, 6, 7, 8, 9 to use `guard: 'hash_preimage_with_bond'` on invite boxes, `guard: 'bond_dual'` on bond boxes, and `inviteBoxId` on bond boxes.

For test 4 (MAX_PENDING_INVITES), each bondBox needs `inviteBoxId` pointing to its paired inviteBox.

For test 5 (Create accepts karma below invite cost), same fixture updates.

For test 6 (Claim fails with wrong secret), the test needs a committed BondBox — simulate via DB update or restructure.

For test 7 (Claim fails if pubkey already account), restructure with committed BondBox.

For test 8 (Cancel fails if already claimed — spent), same fixture updates.

For test 9 (Cancel fails with wrong signature), same fixture updates.

The exact code for each is repetitive — follow the pattern from Steps 3-8. The key pattern: every `insertBondBox` call needs the `inviteBoxId` third argument.

- [ ] **Step 10: Add `commitInvite` import**

At the top of the test file, add to the imports:
```ts
import { createInvite, claimInvite, cancelInvite, commitInvite } from '../../src/services/invites.js';
```

- [ ] **Step 11: Run tests**

```bash
pnpm test
```
Expected: all 15+ invite service tests pass (9 original + ~6 new).

- [ ] **Step 12: Commit**

```bash
git add packages/node/test/services/invites.test.ts
git commit -m "test(invites): add commitInvite tests, update fixtures for commit-reveal

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Route Tests — Add commit route tests

**Files:**
- Modify: `packages/node/test/routes/invites.test.ts`

**Interfaces:**
- Consumes: all changes from Tasks 1-5
- Produces: route-level test coverage for POST /invites/commit

- [ ] **Step 1: Add commitInvite to imports**

In `packages/node/test/routes/invites.test.ts`, line 9-13, add `commitInvite`:
```ts
import {
  createInvite,
  claimInvite,
  cancelInvite,
  commitInvite,
} from '../../src/services/invites.js';
```

- [ ] **Step 2: Add commitInvite to deps**

In the `request` helper function, add `commitInvite` to the deps object (around line 49-52):
```ts
      createInvite,
      claimInvite,
      cancelInvite,
      commitInvite,
```

- [ ] **Step 3: Update existing test fixtures for new guards/inviteBoxId**

In all existing route tests, update:
- InviteBox guard: `'hash_preimage'` → `'hash_preimage_with_bond'`
- BondBox guard: `'inviter_signature'` → `'bond_dual'`
- BondBox: add `inviteBoxId` field (pointing to the paired InviteBox's computed ID)

This affects the create test, claim test, both cancel tests. The key change for the claim test is that the BondBox needs `inviteePublicKey` set to 32 bytes (committed) before claim. Since the route test inserts directly into the DB, update the bondBox fixture.

- [ ] **Step 4: Add commit route test**

Add a new test after the missing-tx test and before the claim test:
```ts
  it('POST /invites/commit commits to BondBox and returns 201 with pending', async () => {
    const secret = new Uint8Array(32).fill(0x66);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 1,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);
    storeInsertBox({ ...inviteBox, id: inviteBoxId, boxType: 'invite', guard: 'hash_preimage_with_bond' } as InviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteBoxId: inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
    const bondBoxId = computeBoxId(bondBox);
    storeInsertBox({ ...bondBox, id: bondBoxId, boxType: 'bond', guard: 'bond_dual' } as BondBox);

    const newKp = generateKeyPair();
    const inviteePubKey = newKp.publicKey;
    const inviteePubKeyHex = Buffer.from(inviteePubKey).toString('hex');
    const inviteePrivKeyObj = createPrivateKey({
      key: Buffer.from(newKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 5,
      inviterId,
      inviteBoxId: inviteBoxId,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutId = computeBoxId(bondOut);

    const tx: UtxoTransaction = {
      inputs: [bondBoxId],
      outputs: [{ ...bondOut, id: bondOutId }],
      signatures: {},
      preimages: { [bondBoxId]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKeyObj, inviteePubKeyHex);

    const res = await request('/commit', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect(typeof body.bondBoxId).toBe('string');
  });
```

- [ ] **Step 5: Add commit missing-tx test**

```ts
  it('POST /invites/commit with missing tx returns 400', async () => {
    const res = await request('/commit', 'POST', {});
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 6: Run route tests**

```bash
pnpm test -- packages/node/test/routes/invites.test.ts
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/node/test/routes/invites.test.ts
git commit -m "test(routes): add POST /invites/commit route tests, update fixtures

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Demo UI — Update redeem flow to commit → reveal

**Files:**
- Modify: `packages/node/public/index.html`

**Interfaces:**
- Consumes: POST /invites/commit, POST /invites/claim (modified)
- Produces: Updated UI with two-step redeem (commit → wait → reveal)

- [ ] **Step 1: Update buildCreateInviteTx — new guards and inviteBoxId**

In `packages/node/public/index.html`, in the `buildCreateInviteTx` function (around lines 572-616), update:
```js
  const inviteOutput = {
    boxType: 'invite',
    value: INVITE_KARMA_AMOUNT,
    createdAtBlock: now,
    secretHash: secretHashHex,
    inviterId: pubKeyHex,
    guard: 'hash_preimage_with_bond',   // was: 'hash_preimage'
  };

  const bondOutput = {
    boxType: 'bond',
    value: INVITE_BOND_KARMA,
    createdAtBlock: now,
    inviterId: pubKeyHex,
    inviteBoxId: '',  // placeholder — will be set after we know the inviteBoxId
    inviteePublicKey: '00'.repeat(32),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'bond_dual',                 // was: 'inviter_signature'
  };
```

Since the `inviteBoxId` depends on the `computeBoxId` of the invite output (which needs the ID first), compute the invite output's ID on the client side, then set `inviteBoxId` on the bond output. The client already has a `computeBoxId` JS implementation — use it:

```js
  const inviteOutput = { ... };
  const inviteBoxId = computeBoxId(inviteOutput);
  inviteOutput.id = inviteBoxId;

  const bondOutput = {
    ...
    inviteBoxId: inviteBoxId,
    ...
  };
```

- [ ] **Step 2: Add buildCommitTx helper**

Add a new function after `buildClaimInviteTx` (around line 656):
```js
/**
 * Build a commit tx: BondBox(unclaimed) → BondBox(committed).
 * @param {Object} bondBox - { id, value, inviterId, inviteBoxId }
 * @param {string} inviteePubKeyHex
 * @param {string} secretHex - raw hex preimage for bond_dual's hash_preimage path
 */
function buildCommitTx(bondBox, inviteePubKeyHex, secretHex) {
  const now = currentBlockHeight;

  const bondOutput = {
    boxType: 'bond',
    value: bondBox.value,
    createdAtBlock: now,
    inviterId: bondBox.inviterId,
    inviteBoxId: bondBox.inviteBoxId,
    inviteePublicKey: inviteePubKeyHex,
    probationStartBlock: now,
    probationEndBlock: now + INVITE_PROBATION_BLOCKS,
    guard: 'bond_dual',
  };

  return {
    inputs: [bondBox.id],
    outputs: [bondOutput],
    signatures: {},
    preimages: { [bondBox.id]: secretHex },
    protocolVersion: PROTOCOL_VERSION,
  };
}
```

- [ ] **Step 3: Update buildClaimInviteTx — new guards**

In `packages/node/public/index.html`, in `buildClaimInviteTx` (around lines 625-656), update:
```js
  const bondOutput = {
    boxType: 'bond',
    value: bondBox.value,
    createdAtBlock: now,
    inviterId: inviteBox.inviterId,
    inviteBoxId: inviteBox.inviteBoxId || '',  // carry forward from commit
    inviteePublicKey: inviteePubKeyHex,
    probationStartBlock: bondBox.probationStartBlock || now,
    probationEndBlock: bondBox.probationEndBlock || (now + INVITE_PROBATION_BLOCKS),
    guard: 'bond_dual',                      // was: 'inviter_signature'
  };
```

Note: the claim tx's BondBox output must preserve the commit step's fields (inviteePublicKey, probation timers). The reveal tx now has the InviteBox's `preimages` keyed by `inviteBox.id` (unchanged — the InviteBox still has the `hash_preimage_with_bond` guard).

- [ ] **Step 4: Update redeem button handler — two-step flow**

Replace the redeem button handler (around lines 1556-1613) with a two-step flow. The UI needs:
1. Build commit tx, submit to POST /invites/commit
2. Store secret in sessionStorage
3. Wait for block inclusion (poll or fixed delay)
4. Build reveal tx, submit to POST /invites/claim
5. Clear sessionStorage on success

```js
document.getElementById('redeemInviteBtn').addEventListener('click', async () => {
  const btn = document.getElementById('redeemInviteBtn');
  const result = document.getElementById('redeemResult');
  const inviteBoxId = document.getElementById('inviteBoxIdInput').value.trim();
  const bondBoxId = document.getElementById('bondBoxIdForClaimInput').value.trim();
  const inviterId = document.getElementById('inviterIdForClaimInput').value.trim();
  const secretHex = document.getElementById('inviteSecretInput').value.trim();

  if (!inviteBoxId || !bondBoxId || !inviterId || !secretHex) {
    result.innerHTML = '<span class="result-msg err">All fields are required</span>';
    return;
  }

  btn.disabled = true;

  try {
    const inviteePubKeyHex = buf2hex(pubKeyRaw);

    const inviteBox = { id: inviteBoxId, value: INVITE_KARMA_AMOUNT, inviterId };

    // ---- Step 1: Commit ----
    result.innerHTML = '<span class="result-msg">Committing...</span>';

    const bondBox = {
      id: bondBoxId,
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteBoxId: inviteBoxId,
    };

    const commitTx = buildCommitTx(bondBox, inviteePubKeyHex, secretHex);
    const { signature: commitSig } = await signTxId(commitTx);
    commitTx.signatures[inviteePubKeyHex] = commitSig;

    const commitRes = await fetch(API + '/invites/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: commitTx }),
    });
    const commitData = await commitRes.json();
    if (!commitRes.ok) {
      result.innerHTML = `<span class="result-msg err">Commit failed: ${esc(commitData.error || 'unknown error')}</span>`;
      return;
    }

    // Store secret for reveal step (survives page refresh)
    sessionStorage.setItem('reveal_' + inviteBoxId, JSON.stringify({
      secretHex,
      bondBoxId,
      inviterId,
      inviteePubKeyHex,
      bondInviteBoxId: inviteBoxId,
    }));

    // ---- Step 2: Wait then reveal ----
    result.innerHTML = '<span class="result-msg">Committed — waiting for block inclusion...</span>';

    // Poll for block height change (or use fixed delay)
    const startHeight = currentBlockHeight;
    const checkReveal = async () => {
      await loadStatus(); // refreshes currentBlockHeight
      if (currentBlockHeight > startHeight) {
        // Block advanced — proceed to reveal
        result.innerHTML = '<span class="result-msg">Revealing...</span>';

        const revealTx = buildClaimInviteTx(inviteBox, bondBox, inviteePubKeyHex, secretHex);
        const { signature: revealSig } = await signTxId(revealTx);
        revealTx.signatures[inviteePubKeyHex] = revealSig;

        const revealRes = await fetch(API + '/invites/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx: revealTx }),
        });
        const revealData = await revealRes.json();
        if (revealRes.ok) {
          sessionStorage.removeItem('reveal_' + inviteBoxId);
          result.innerHTML = `
            <span class="result-msg ok">Invite claimed!</span>
            <div style="font-size:11px;color:#8b949e;margin:4px 0">User ID:</div>
            <pre>${esc(revealData.userId)}</pre>
            <div style="font-size:11px;color:#8b949e;margin:4px 0">Karma Box ID:</div>
            <pre>${esc(revealData.karmaBoxId)}</pre>
          `;
          loadStatus();
          loadIdentityStatus();
        } else {
          result.innerHTML = `<span class="result-msg err">Reveal failed: ${esc(revealData.error || 'unknown error')}</span>`;
        }
      } else {
        // Not yet — poll again in 5 seconds
        setTimeout(checkReveal, 5000);
      }
    };

    setTimeout(checkReveal, 3000); // Start polling after 3s
  } catch (e) {
    result.innerHTML = `<span class="result-msg err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});
```

- [ ] **Step 5: Add sessionStorage recovery on page load**

Add at the bottom of the init section (before `loadIdentities()`):
```js
// Check for in-progress reveals from a previous page load
const revealKeys = Object.keys(sessionStorage).filter(k => k.startsWith('reveal_'));
if (revealKeys.length > 0) {
  const key = revealKeys[0];
  const stored = JSON.parse(sessionStorage.getItem(key));
  document.getElementById('inviteBoxIdInput').value = stored.inviteBoxId || key.replace('reveal_', '');
  document.getElementById('bondBoxIdForClaimInput').value = stored.bondBoxId;
  document.getElementById('inviterIdForClaimInput').value = stored.inviterId;
  document.getElementById('inviteSecretInput').value = stored.secretHex;
  document.getElementById('redeemResult').innerHTML = '<span class="result-msg">Committed invite pending reveal — click Redeem to continue</span>';
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/node/public/index.html
git commit -m "feat(ui): two-step invite redeem (commit → reveal) with session storage

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Final Verification

After all tasks are complete, run:

```bash
pnpm build
pnpm test
pnpm typecheck
```

Expected: clean build, all tests pass (622+ tests), zero type errors.
