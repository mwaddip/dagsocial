import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  KARMA_DECAY_RATE,
  KARMA_DECAY_GRACE_BLOCKS,
  KARMA_FLOOR,
} from '@dagsocial/types';
import type { UtxoTransaction, AnyBox, KarmaBox, BondBox, InviteBox, LikeBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Ed25519 SPKI prefix for raw 32-byte public keys
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);

function publicKeyToKeyObject(pubKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKey)]),
    format: 'der',
    type: 'spki',
  });
}

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface UtxoEngineDeps {
  /** Return the box if it exists AND is unspent. Return null for spent or missing boxes. */
  getBox: (id: string) => AnyBox | null;
  insertBox: (box: AnyBox) => void;
  consumeBox: (id: string, atBlock: number) => void;
  getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
  /** Return identity info containing at least the publicKey. */
  getIdentity: (userId: Uint8Array) => { publicKey: Uint8Array } | null;
  /** Wrap fn in a better-sqlite3 transaction. */
  runInTransaction: (fn: () => void) => void;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface UtxoResult {
  valid: boolean;
  error?: string;
  computedOutputs?: AnyBox[];
  txId?: string;
}

// ---------------------------------------------------------------------------
// Stateless validation helpers
// ---------------------------------------------------------------------------

/**
 * Compute the effective karma value after decay for a box consumed at
 * currentBlockHeight.
 */
function effectiveKarmaValue(box: KarmaBox, currentBlockHeight: number): number {
  const age = currentBlockHeight - box.createdAtBlock;
  const graceAge = Math.max(0, age - KARMA_DECAY_GRACE_BLOCKS);
  const decay = Math.floor(box.value * KARMA_DECAY_RATE * graceAge);
  return Math.max(box.value - decay, KARMA_FLOOR);
}

/**
 * Verify a signature for a given public key.
 * Returns true if a valid signature exists in tx.signatures for that key.
 */
function verifyGuardSignature(
  tx: UtxoTransaction,
  txHash: Buffer,
  pubKey: Uint8Array,
): boolean {
  const hexKey = Buffer.from(pubKey).toString('hex');
  const signature = tx.signatures[hexKey];
  if (!signature) return false;
  try {
    const keyObj = publicKeyToKeyObject(pubKey);
    return Boolean(cryptoVerify(null, txHash, keyObj, Buffer.from(signature)));
  } catch {
    return false;
  }
}

/**
 * Check legal box transitions for a given set of inputs and outputs.
 * Assumes all inputs have the same boxType (pre-checked).
 */
function checkTransitions(
  inputs: AnyBox[],
  outputs: AnyBox[],
): { valid: boolean; error?: string } {
  // Handle invite cancel: KarmaBox + InviteBox + BondBox → KarmaBox
  if (inputs.length === 3) {
    const hasKarma = inputs.some((b) => b.boxType === 'karma');
    const hasInvite = inputs.some((b) => b.boxType === 'invite');
    const hasBond = inputs.some((b) => b.boxType === 'bond');
    if (hasKarma && hasInvite && hasBond) {
      const karmaOuts = outputs.filter((o) => o.boxType === 'karma');
      if (karmaOuts.length === 1 && outputs.length === 1) {
        return { valid: true };
      }
      return {
        valid: false,
        error: 'Invite cancel must produce exactly 1 KarmaBox output',
      };
    }
  }

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

  switch (inputType) {
    // ------------------------------------------------------------------
    // KarmaBox → KarmaBox (same owner, balance change)
    // KarmaBox → KarmaBox + InviteBox + BondBox (invite creation)
    // KarmaBox → KarmaBox + LikeBox (like cast)
    // ------------------------------------------------------------------
    case 'karma': {
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      const inviteOutputs = outputs.filter((o) => o.boxType === 'invite');
      const bondOutputs = outputs.filter((o) => o.boxType === 'bond');
      const likeOutputs = outputs.filter((o) => o.boxType === 'like');
      const postLockOutputs = outputs.filter((o) => o.boxType === 'post_lock');

      const totalOutputs =
        karmaOutputs.length + inviteOutputs.length + bondOutputs.length + likeOutputs.length + postLockOutputs.length;

      if (totalOutputs !== outputs.length) {
        return {
          valid: false,
          error: `Illegal karma transition: outputs contain non-karma/invite/bond/like/post_lock boxes`,
        };
      }

      // All karma outputs must belong to the same owner as the consumed karma
      const inputKarma = inputs[0] as KarmaBox;
      for (const ko of karmaOutputs) {
        const k = ko as KarmaBox;
        if (Buffer.from(k.owner).toString('hex') !== Buffer.from(inputKarma.owner).toString('hex')) {
          return {
            valid: false,
            error: `Karma cannot be transferred (owner change on karma box)`,
          };
        }
      }

      // At least one karma output required
      if (karmaOutputs.length === 0) {
        return {
          valid: false,
          error: `Karma transition must produce at least one karma output`,
        };
      }

      if (likeOutputs.length > 0) {
        // karma → karma + like
        if (likeOutputs.length !== 1 || inviteOutputs.length > 0 || bondOutputs.length > 0 || postLockOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid like transition: exactly 1 karma + 1 like output expected`,
          };
        }
      } else if (postLockOutputs.length > 0) {
        // karma → karma + post_lock (post creation lock)
        if (postLockOutputs.length !== 1 || inviteOutputs.length > 0 || bondOutputs.length > 0 || likeOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid post-lock transition: exactly 1 karma + 1 post_lock output expected`,
          };
        }
      } else if (inviteOutputs.length > 0 || bondOutputs.length > 0) {
        // karma → karma + invite + bond
        if (inviteOutputs.length !== 1 || bondOutputs.length !== 1) {
          return {
            valid: false,
            error: `Invite creation requires exactly 1 invite + 1 bond output`,
          };
        }
      }
      // else: karma → karma only, which is always valid

      return { valid: true };
    }

    // ------------------------------------------------------------------
    // InviteBox → KarmaBox (new owner via claim)
    // Note: hash_preimage guard rejected in guard check — this path is
    // only reachable via specialised claim handler, not generic validation.
    // ------------------------------------------------------------------
    case 'invite': {
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      if (karmaOutputs.length !== 1 || outputs.length !== 1) {
        return {
          valid: false,
          error: `InviteBox can only be spent to create exactly 1 KarmaBox`,
        };
      }
      return { valid: true };
    }

    // ------------------------------------------------------------------
    // BondBox → KarmaBox (to inviter) OR burn (no output)
    // ------------------------------------------------------------------
    case 'bond': {
      if (outputs.length === 0) {
        // Burn — valid
        return { valid: true };
      }
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      if (karmaOutputs.length !== 1 || outputs.length !== 1) {
        return {
          valid: false,
          error: `BondBox can only be spent to create exactly 1 KarmaBox or burned`,
        };
      }
      return { valid: true };
    }

    // ------------------------------------------------------------------
    // CreditBox → CreditBox(es) (any owner)
    // ------------------------------------------------------------------
    case 'credit': {
      const creditOutputs = outputs.filter((o) => o.boxType === 'credit');
      if (creditOutputs.length === 0 || creditOutputs.length !== outputs.length) {
        return {
          valid: false,
          error: `CreditBox can only be spent to create CreditBox outputs`,
        };
      }
      return { valid: true };
    }

    // ------------------------------------------------------------------
    // LikeBox → KarmaBox (unlike by liker)
    // LikeBox consumed by epoch tally (handled in epoch code)
    // ------------------------------------------------------------------
    case 'like': {
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      if (karmaOutputs.length >= 1 && karmaOutputs.length === outputs.length) {
        // Unlike: liker consumes their LikeBox, gets karma back
        return { valid: true };
      }
      return {
        valid: false,
        error: `LikeBox must produce karma outputs (unlike) or be consumed by epoch tally`,
      };
    }

    // ------------------------------------------------------------------
    // PostLockBox — consumed by epoch only, rejected in guard check
    // ------------------------------------------------------------------
    case 'post_lock': {
      return {
        valid: false,
        error: `PostLockBox can only be consumed by epoch tally (not user transactions)`,
      };
    }

    default:
      return { valid: false, error: `Unknown box type: ${inputType}` };
  }
}

// ---------------------------------------------------------------------------
// Internal validation helpers (extracted from validateAndApplyTx)
// ---------------------------------------------------------------------------

/**
 * Check face-value conservation for non-karma box types.
 * Karma is decay-aware (checked in checkKarmaDecay). Bond burns skip conservation.
 */
function checkValueConservation(
  inputBoxes: AnyBox[],
  outputs: AnyBox[],
): UtxoResult {
  const inputType = inputBoxes[0]!.boxType;
  const totalInputValue = inputBoxes.reduce((sum, b) => sum + b.value, 0);
  const totalOutputValue = outputs.reduce((sum, b) => sum + b.value, 0);

  if (inputType === 'bond' && outputs.length === 0) {
    // BondBox burn — no outputs, value deliberately destroyed. Skip conservation.
  } else if (inputType === 'karma' || inputType === 'like') {
    // Karma conservation is checked in checkKarmaDecay via effective values (decay-aware).
    // Face values differ legitimately — decay destroys karma, and like/invite
    // creation splits value across multiple output boxes.
  } else {
    // Credit, non-burn bond, invite: strict face-value conservation
    if (totalInputValue !== totalOutputValue) {
      return {
        valid: false,
        error: `Value non-conservation: inputs=${totalInputValue}, outputs=${totalOutputValue}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check guard satisfaction (signatures, hash preimages, epoch tally) for all inputs.
 */
function checkGuards(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  inputBoxes: AnyBox[],
): UtxoResult {
  const txHash = Buffer.from(computeTxId(tx), 'hex');

  for (const box of inputBoxes) {
    switch (box.guard) {
      case 'owner_signature': {
        const ownerBox = box as { owner: Uint8Array };
        if (!verifyGuardSignature(tx, txHash, ownerBox.owner)) {
          return {
            valid: false,
            error: `Missing or invalid owner signature for box ${box.id}`,
          };
        }
        break;
      }

      case 'epoch_tally': {
        const likeBox = box as LikeBox;
        // Allow liker to consume their own LikeBox (unlike)
        if (likeBox.boxType === 'like' && likeBox.likerId) {
          if (verifyGuardSignature(tx, txHash, likeBox.likerId)) {
            break; // Liker-authorized unlike
          }
          return {
            valid: false,
            error: `LikeBox can only be consumed by its liker or epoch tally`,
          };
        }
        // PostLockBox and other epoch_tally boxes: epoch only
        return {
          valid: false,
          error: `Box with epoch_tally guard can only be consumed by epoch tally`,
        };
      }

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

      case 'inviter_signature': {
        const bondBox = box as BondBox;
        const identity = deps.getIdentity(bondBox.inviterId);
        if (!identity) {
          return {
            valid: false,
            error: `Inviter identity not found: ${bondBox.inviterId}`,
          };
        }
        if (!verifyGuardSignature(tx, txHash, identity.publicKey)) {
          return {
            valid: false,
            error: `Missing or invalid inviter signature for box ${box.id}`,
          };
        }
        break;
      }

      default:
        return { valid: false, error: `Unknown guard type: ${(box as AnyBox).guard}` };
    }
  }

  return { valid: true };
}

/**
 * Check karma decay: effective value at current height must cover output values.
 * Shared between validateTx and revalidateTxInContext.
 */
function checkKarmaDecay(
  inputBoxes: AnyBox[],
  outputs: AnyBox[],
  currentBlockHeight: number,
): UtxoResult {
  if (inputBoxes.length === 0) return { valid: true };
  if (inputBoxes[0]!.boxType !== 'karma') return { valid: true };

  // Compute effective karma from consumed boxes (after decay).
  // Non-karma inputs (invite, bond, like) contribute their face value, which
  // handles transitions like invite cancel where invite/bond boxes are consumed
  // alongside a karma box.
  let totalEffective = 0;
  for (const box of inputBoxes) {
    if (box.boxType === 'karma') {
      totalEffective += effectiveKarmaValue(box as KarmaBox, currentBlockHeight);
    } else {
      totalEffective += box.value;
    }
  }

  // Sum up outputs by type
  const karmaOutputValue = outputs
    .filter((o) => o.boxType === 'karma')
    .reduce((sum, o) => sum + o.value, 0);
  const inviteOutputValue = outputs
    .filter((o) => o.boxType === 'invite')
    .reduce((sum, o) => sum + o.value, 0);
  const bondOutputValue = outputs
    .filter((o) => o.boxType === 'bond')
    .reduce((sum, o) => sum + o.value, 0);
  const likeOutputValue = outputs
    .filter((o) => o.boxType === 'like')
    .reduce((sum, o) => sum + o.value, 0);
  const postLockOutputValue = outputs
    .filter((o) => o.boxType === 'post_lock')
    .reduce((sum, o) => sum + o.value, 0);

  const totalSplit =
    karmaOutputValue + inviteOutputValue + bondOutputValue + likeOutputValue + postLockOutputValue;

  if (totalSplit > totalEffective) {
    return {
      valid: false,
      error: `Insufficient effective karma: need ${totalSplit}, have ${totalEffective} (after decay)`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Public API: validateTx, revalidateTxInContext, applyTx, validateAndApplyTx
// ---------------------------------------------------------------------------

/**
 * Validate a transaction without applying it (read-only).
 *
 * Performs steps 1-7 of the original validateAndApplyTx:
 * 1. No duplicate input IDs
 * 2. All inputs exist and are unspent
 * 3. All inputs have the same boxType
 * 4. Face-value conservation (non-karma types)
 * 5. Guard satisfaction (signatures)
 * 6. Legal box transitions
 * 7. Karma decay check
 *
 * Does NOT call runInTransaction, consumeBox, or insertBox.
 * Returns computedOutputs and txId on success for use by applyTx.
 */
export function validateTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  // ---- 1. No duplicate input box IDs ----
  const inputSet = new Set(tx.inputs);
  if (inputSet.size !== tx.inputs.length) {
    return { valid: false, error: 'Duplicate input box IDs' };
  }

  if (tx.inputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one input' };
  }

  // ---- 2. Every input box exists and is unspent ----
  const inputBoxes: AnyBox[] = [];
  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (!box) {
      return { valid: false, error: `Input box not found or already spent: ${inputId}` };
    }
    inputBoxes.push(box);
  }

  // ---- 3. All inputs must be same box_type (except invite+bond claim and invite cancel) ----
  const isInviteBondClaim =
    inputBoxes.length === 2 &&
    inputBoxes.some((b) => b.boxType === 'invite') &&
    inputBoxes.some((b) => b.boxType === 'bond');
  const isInviteCancel =
    inputBoxes.length === 3 &&
    inputBoxes.some((b) => b.boxType === 'karma') &&
    inputBoxes.some((b) => b.boxType === 'invite') &&
    inputBoxes.some((b) => b.boxType === 'bond');
  if (!isInviteBondClaim && !isInviteCancel) {
    const inputType = inputBoxes[0]!.boxType;
    for (const box of inputBoxes) {
      if (box.boxType !== inputType) {
        return {
          valid: false,
          error: `Mixed input types not allowed: ${inputType} vs ${box.boxType}`,
        };
      }
    }
  }

  // ---- 4. Value conservation ----
  const valueCheck = checkValueConservation(inputBoxes, tx.outputs);
  if (!valueCheck.valid) return valueCheck;

  // ---- 5. Guard satisfaction ----
  const guardCheck = checkGuards(deps, tx, inputBoxes);
  if (!guardCheck.valid) return guardCheck;

  // ---- 6. Legal box transitions ----
  const transitionCheck = checkTransitions(inputBoxes, tx.outputs);
  if (!transitionCheck.valid) return transitionCheck;

  // ---- 7. Karma decay ----
  const decayCheck = checkKarmaDecay(inputBoxes, tx.outputs, currentBlockHeight);
  if (!decayCheck.valid) return decayCheck;

  // Compute output IDs for the caller (so applyTx doesn't re-compute)
  const computedOutputs = tx.outputs.map((box) => ({
    ...box,
    id: computeBoxId(box),
  })) as AnyBox[];

  return {
    valid: true,
    computedOutputs,
    txId: computeTxId(tx),
  };
}

/**
 * Revalidate a previously-validated transaction at a later height.
 *
 * Skips expensive checks (signatures, transitions) and only verifies:
 * - Inputs are still unspent (liveness)
 * - Karma decay hasn't expired at the new height
 *
 * Used by the mempool to detect stale transactions.
 */
export function revalidateTxInContext(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  // Only check liveness — are inputs still unspent?
  for (const id of tx.inputs) {
    const box = deps.getBox(id);
    if (!box) {
      return { valid: false, error: `Input box not found or already spent: ${id}` };
    }
  }

  // Check karma decay hasn't expired (height-dependent)
  const inputBoxes = tx.inputs
    .map((id) => deps.getBox(id)!)
    .filter(Boolean);
  const decayCheck = checkKarmaDecay(inputBoxes, tx.outputs, currentBlockHeight);
  if (!decayCheck.valid) return decayCheck;

  return { valid: true };
}

/**
 * Apply a previously-validated transaction (write).
 *
 * Consumes all input boxes and inserts all output boxes inside a transaction.
 * Call validateTx first — applyTx performs no validation.
 */
export function applyTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  outputsWithIds: AnyBox[],
  currentBlockHeight: number,
): void {
  deps.runInTransaction(() => {
    for (const id of tx.inputs) {
      deps.consumeBox(id, currentBlockHeight);
    }
    for (const box of outputsWithIds) {
      deps.insertBox(box);
    }
  });
}

/**
 * Validate AND apply a transaction in one call (convenience wrapper).
 *
 * Preserved for backward compatibility during the mempool migration.
 * Delegates to validateTx + applyTx. For new code, prefer the split functions.
 */
export function validateAndApplyTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) return result;

  applyTx(deps, tx, result.computedOutputs!, currentBlockHeight);
  return result;
}
