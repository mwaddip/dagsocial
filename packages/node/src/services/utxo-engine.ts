import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  computeBoxId,
  serializeTx,
  KARMA_DECAY_RATE,
  KARMA_DECAY_GRACE_BLOCKS,
  KARMA_FLOOR,
} from '@dagsocial/types';
import type { UtxoTransaction, AnyBox, KarmaBox } from '@dagsocial/types';

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
// Transaction hash (for signature verification)
// ---------------------------------------------------------------------------

function computeTxHash(tx: UtxoTransaction): Buffer {
  return createHash('blake2b512')
    .update(Buffer.from(serializeTx(tx)))
    .digest()
    .subarray(0, 32);
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
  getIdentity: (userId: string) => { publicKey: Uint8Array } | null;
  /** Wrap fn in a better-sqlite3 transaction. */
  runInTransaction: (fn: () => void) => void;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface UtxoResult {
  valid: boolean;
  error?: string;
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

      const totalOutputs =
        karmaOutputs.length + inviteOutputs.length + bondOutputs.length + likeOutputs.length;

      if (totalOutputs !== outputs.length) {
        return {
          valid: false,
          error: `Illegal karma transition: outputs contain non-karma/invite/bond/like boxes`,
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
        if (likeOutputs.length !== 1 || inviteOutputs.length > 0 || bondOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid like transition: exactly 1 karma + 1 like output expected`,
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
    // LikeBox — consumed by epoch only, rejected in guard check
    // ------------------------------------------------------------------
    case 'like': {
      return {
        valid: false,
        error: `LikeBox can only be consumed by epoch tally (not user transactions)`,
      };
    }

    default:
      return { valid: false, error: `Unknown box type: ${inputType}` };
  }
}

// ---------------------------------------------------------------------------
// Main validation + apply function
// ---------------------------------------------------------------------------

export function validateAndApplyTx(
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
  const consumedBoxes: AnyBox[] = [];
  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (!box) {
      return { valid: false, error: `Input box not found or already spent: ${inputId}` };
    }
    consumedBoxes.push(box);
  }

  // ---- 3. All inputs must be same box_type ----
  const inputType = consumedBoxes[0]!.boxType;
  for (const box of consumedBoxes) {
    if (box.boxType !== inputType) {
      return {
        valid: false,
        error: `Mixed input types not allowed: ${inputType} vs ${box.boxType}`,
      };
    }
  }

  // ---- 4. Value conservation ----
  const totalInputValue = consumedBoxes.reduce((sum, b) => sum + b.value, 0);
  const totalOutputValue = tx.outputs.reduce((sum, b) => sum + b.value, 0);

  if (inputType === 'bond' && tx.outputs.length === 0) {
    // BondBox burn — no outputs, value deliberately destroyed. Skip conservation.
  } else if (inputType === 'karma') {
    // Karma conservation is checked in step 7 via effective values (decay-aware).
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

  // ---- 5. Guard satisfaction ----
  const txHash = computeTxHash(tx);

  for (const box of consumedBoxes) {
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

      case 'epoch_tally':
        return {
          valid: false,
          error: `LikeBox can only be consumed by epoch tally, not user transactions`,
        };

      case 'hash_preimage':
        return {
          valid: false,
          error: `hash_preimage guard handled by invite claim route, not generic validation`,
        };

      case 'inviter_signature': {
        const bondBox = box as import('@dagsocial/types').BondBox;
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

  // ---- 6. Legal box transitions ----
  const transitionResult = checkTransitions(consumedBoxes, tx.outputs);
  if (!transitionResult.valid) {
    return transitionResult;
  }

  // ---- 7. Stateful validation: karma decay ----
  if (inputType === 'karma') {
    // Compute effective karma from consumed boxes (after decay)
    let totalEffective = 0;
    for (const box of consumedBoxes) {
      totalEffective += effectiveKarmaValue(box as KarmaBox, currentBlockHeight);
    }

    // Sum up outputs by type
    const karmaOutputValue = tx.outputs
      .filter((o) => o.boxType === 'karma')
      .reduce((sum, o) => sum + o.value, 0);
    const inviteOutputValue = tx.outputs
      .filter((o) => o.boxType === 'invite')
      .reduce((sum, o) => sum + o.value, 0);
    const bondOutputValue = tx.outputs
      .filter((o) => o.boxType === 'bond')
      .reduce((sum, o) => sum + o.value, 0);
    const likeOutputValue = tx.outputs
      .filter((o) => o.boxType === 'like')
      .reduce((sum, o) => sum + o.value, 0);

    const totalSplit =
      karmaOutputValue + inviteOutputValue + bondOutputValue + likeOutputValue;

    if (totalSplit > totalEffective) {
      return {
        valid: false,
        error: `Insufficient effective karma: need ${totalSplit}, have ${totalEffective} (after decay)`,
      };
    }
  }

  // ---- 8. Apply ----
  deps.runInTransaction(() => {
    // Consume all input boxes
    for (const inputId of tx.inputs) {
      deps.consumeBox(inputId, currentBlockHeight);
    }

    // Compute IDs and insert all output boxes
    for (const output of tx.outputs) {
      const id = computeBoxId(output);
      const boxWithId = { ...output, id } as AnyBox;
      deps.insertBox(boxWithId);
    }
  });

  return { valid: true };
}
