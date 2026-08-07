import { createHash, verify as cryptoVerify } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  INVITE_KARMA_THRESHOLD,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import type { UtxoTransaction, AnyBox, AnyBoxCandidate, KarmaBox, BondBox, InviteBox, LikeBox } from '@dagsocial/types';

// A local `computeTxIdLocal` lived here — a second implementation of
// `computeTxId` with its own cbor-x `Encoder` — and was **deleted** by Spec G
// phase G3b. It was not a helper: it produced the hash signatures are verified
// against (`checkGuards`) and the `txId` every output is materialized under
// (`validateTx`), while every *builder* and `block-apply` used types'
// `computeTxId`. Two consensus-critical hash implementations that agreed only by
// coincidence — identical `Encoder` options, neither applying a domain tag, and
// no output carrying `txId`/`index` at runtime, since the strip rules differed
// (types routes outputs through `canonicalBoxBytes`; this stripped `id` only,
// the same defect in its sixth location).
//
// Its stated justification — "avoiding module-resolution drift between the types
// dist and the node runtime" — guarded a problem that does not exist: the store
// holds exactly one cbor-x. It bought no safety and cost a divergence surface
// that G3b would have detonated, since applying `TX_ID_DOMAIN` to types alone
// would leave builders signing a tagged id while this verified an untagged one.

import { ed25519PublicKeyToKeyObject } from '@dagsocial/validation';

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface UtxoEngineDeps {
  /** Return the box if it exists AND is unspent. Return null for spent or missing boxes. */
  getBox: (id: string) => AnyBox | null;
  /**
   * Resolve a box by its creating-transaction provenance. Backed by
   * `UNIQUE(tx_id, output_index)`, so it names at most one box. Used by the bond
   * commit path to find the InviteBox its bond shipped with.
   */
  getBoxByProvenance: (txId: string, index: number) => AnyBox | null;
  insertBox: (box: AnyBox) => void;
  consumeBox: (id: string, atBlock: number) => void;
  getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
  /**
   * Summed value of every unspent KarmaBox owned by `owner`.
   *
   * Consensus input, not a convenience read: the bond settlement unlock is a
   * spend-time predicate on the invitee's *current* karma
   * (NODE_INTERFACE → "Bond transition rules"). Summed rather than
   * `getKarmaBox().value` because multiple unspent karma boxes per owner is
   * reachable — a faucet grant alongside a mint, or a plain karma split — and
   * reading one box would let an invitee's threshold be evaded, or met, by how
   * their karma happens to be partitioned.
   */
  getKarmaValue: (owner: Uint8Array) => bigint;
  /** Wrap fn in a better-sqlite3 transaction. */
  runInTransaction: (fn: () => void) => void;
  /** Return true if the box is the system karma box (faucet source). */
  isSystemBox?: (boxId: string) => boolean;
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
    const keyObj = ed25519PublicKeyToKeyObject(pubKey);
    return Boolean(cryptoVerify(null, txHash, keyObj, Buffer.from(signature)));
  } catch {
    return false;
  }
}

/**
 * Check legal box transitions for a given set of inputs and outputs.
 * Assumes all inputs have the same boxType (pre-checked).
 *
 * Height-aware since P2-B phase 1: the bond commit and settlement rules are
 * predicates on the height the transaction settles at, not on its contents
 * alone.
 */
function checkTransitions(
  inputs: AnyBox[],
  outputs: AnyBoxCandidate[],
  currentBlockHeight: number,
  deps: UtxoEngineDeps,
): { valid: boolean; error?: string } {
  // Handle invite cancel: KarmaBox + InviteBox + BondBox → KarmaBox
  if (inputs.length === 3) {
    const hasKarma = inputs.some((b) => b.boxType === 'karma');
    const hasInvite = inputs.some((b) => b.boxType === 'invite');
    const hasBond = inputs.some((b) => b.boxType === 'bond');
    if (hasKarma && hasInvite && hasBond) {
      const karmaOuts = outputs.filter((o) => o.boxType === 'karma');
      if (karmaOuts.length === 1 && outputs.length === 1) {
        // The cancel returns the bond, so its value must land on the inviter —
        // pinned to BOTH the bond's and the invite's `inviterId`, not merely to
        // the karma input's owner (audit F-consensus-1, the "cancel absorb"
        // leg). Same-owner alone let a committed invitee who already held karma
        // sweep invite + bond into their own box: their signature satisfies
        // `bond_dual` Path 2, the preimage satisfies the invite guard, and
        // `karmaOut.owner == karmaIn.owner` is trivially true when both are
        // theirs. The inviter authorised nothing.
        const karmaIn = inputs.find((b) => b.boxType === 'karma') as KarmaBox;
        const bondIn = inputs.find((b) => b.boxType === 'bond') as BondBox;
        const inviteIn = inputs.find((b) => b.boxType === 'invite') as InviteBox;
        const karmaOut = karmaOuts[0] as KarmaBox;
        const karmaInOwner = Buffer.from(karmaIn.owner).toString('hex');
        if (karmaInOwner !== Buffer.from(karmaOut.owner).toString('hex')) {
          return { valid: false, error: 'Cancel output karma must go to same owner' };
        }
        if (karmaInOwner !== Buffer.from(bondIn.inviterId).toString('hex')) {
          return {
            valid: false,
            error: 'Cancel karma owner must be the bond inviterId',
          };
        }
        if (karmaInOwner !== Buffer.from(inviteIn.inviterId).toString('hex')) {
          return {
            valid: false,
            error: 'Cancel karma owner must be the invite inviterId',
          };
        }
        return { valid: true };
      }
      return {
        valid: false,
        error: 'Invite cancel must produce exactly 1 KarmaBox output',
      };
    }
  }

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
        const karmaOut = karmaOuts[0] as KarmaBox;
        // BondOut must preserve commitment fields from commit step
        if (bondOut.inviteePublicKey.length === 32 &&
            Buffer.from(bondOut.inviteePublicKey).toString('hex') ===
              Buffer.from(bondIn.inviteePublicKey).toString('hex') &&
            bondOut.probationStartBlock === bondIn.probationStartBlock &&
            bondOut.probationEndBlock === bondIn.probationEndBlock &&
            bondOut.inviteOutputIndex === bondIn.inviteOutputIndex &&
            Buffer.from(bondOut.inviterId).toString('hex') ===
              Buffer.from(bondIn.inviterId).toString('hex') &&
            Buffer.from(karmaOut.owner).toString('hex') ===
              Buffer.from(bondIn.inviteePublicKey).toString('hex')) {
          return { valid: true };
        }
      }
      return {
        valid: false,
        error: `Invalid invite reveal: BondBox must be committed and preservation fields must match`,
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
      const vouchOutputs = outputs.filter((o) => o.boxType === 'vouch');

      const totalOutputs =
        karmaOutputs.length + inviteOutputs.length + bondOutputs.length + likeOutputs.length + postLockOutputs.length + vouchOutputs.length;

      if (totalOutputs !== outputs.length) {
        return {
          valid: false,
          error: `Illegal karma transition: outputs contain non-karma/invite/bond/like/post_lock/vouch boxes`,
        };
      }

      // All karma outputs must belong to the same owner as the consumed karma.
      // Exception: system box faucet grant — 2 karma outputs, one same-owner
      // (system change), one different-owner (faucet beneficiary).
      const inputKarma = inputs[0] as KarmaBox;
      if (karmaOutputs.length === 2 && inputs.length === 1 &&
          outputs.length === 2 && deps?.isSystemBox?.(inputKarma.id!)) {
        const sameOwner = karmaOutputs.filter(
          (ko) => Buffer.from((ko as KarmaBox).owner).toString('hex') ===
                  Buffer.from(inputKarma.owner).toString('hex'),
        );
        if (sameOwner.length !== 1) {
          return {
            valid: false,
            error: `Faucet grant must produce exactly one same-owner karma output (system change)`,
          };
        }
        // Faucet grant: allowed. Skip the strict same-owner check below.
      } else {
        for (const ko of karmaOutputs) {
          const k = ko as KarmaBox;
          if (Buffer.from(k.owner).toString('hex') !== Buffer.from(inputKarma.owner).toString('hex')) {
            return {
              valid: false,
              error: `Karma cannot be transferred (owner change on karma box)`,
            };
          }
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
        if (likeOutputs.length !== 1 || inviteOutputs.length > 0 || bondOutputs.length > 0 || postLockOutputs.length > 0 || vouchOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid like transition: exactly 1 karma + 1 like output expected`,
          };
        }
      } else if (postLockOutputs.length > 0) {
        // karma → karma + post_lock (post creation lock)
        if (postLockOutputs.length !== 1 || inviteOutputs.length > 0 || bondOutputs.length > 0 || likeOutputs.length > 0 || vouchOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid post-lock transition: exactly 1 karma + 1 post_lock output expected`,
          };
        }
      } else if (vouchOutputs.length > 0) {
        // karma → karma + vouch
        if (vouchOutputs.length !== 1 || inviteOutputs.length > 0 ||
            bondOutputs.length > 0 || likeOutputs.length > 0 ||
            postLockOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid vouch transition: exactly 1 karma + 1 vouch output expected`,
          };
        }
      } else if (inviteOutputs.length > 0 || bondOutputs.length > 0) {
        // karma → karma + invite + bond
        if (inviteOutputs.length !== 1 || bondOutputs.length !== 1 || vouchOutputs.length > 0) {
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
    // BondBox → BondBox (commit) OR BondBox(committed) → KarmaBox (settlement)
    //
    // Those are the only two shapes. There is no burn, and an uncommitted bond
    // has no standalone spend at all — its exits are the commit above and the
    // 3-input cancel handled at the top of this function.
    // ------------------------------------------------------------------
    case 'bond': {
      // Bond commit: BondBox(unclaimed) → BondBox(committed)
      const bondOuts = outputs.filter((o) => o.boxType === 'bond');
      if (bondOuts.length === 1 && outputs.length === 1) {
        const bondIn = inputs[0] as BondBox;
        const bondOut = bondOuts[0] as BondBox;
        // The probation window is pinned at commit. Without both bounds the
        // committing invitee picks the window freely and locks the inviter's
        // bond for as long as they like — directly via `probationEndBlock`, or
        // by future-dating the start under a pinned length. Past-dating the
        // start stays legal: it only shortens the effective probation, which
        // favours the inviter's unlock and evades nothing while forfeiture does
        // not exist. A strict `== currentBlockHeight` would instead break on the
        // delay between building a commit and its being mined.
        if (inputs.length === 1 &&
            bondIn.inviteePublicKey.length === 0 &&
            bondOut.inviteePublicKey.length === 32 &&
            bondOut.probationStartBlock > 0 &&
            bondOut.probationStartBlock <= currentBlockHeight &&
            bondOut.probationEndBlock - bondOut.probationStartBlock ===
              INVITE_PROBATION_BLOCKS &&
            bondOut.inviteOutputIndex === bondIn.inviteOutputIndex &&
            Buffer.from(bondOut.inviterId).toString('hex') ===
              Buffer.from(bondIn.inviterId).toString('hex')) {
          return { valid: true };
        }
        return {
          valid: false,
          error:
            `Invalid bond commit: inviteePublicKey must go from empty to 32 bytes ` +
            `with a probation window of exactly ${INVITE_PROBATION_BLOCKS} blocks ` +
            `starting at or before the settle height`,
        };
      }

      // No burn shape. Conservation rejects this first through `validateTx`
      // (the zero-output exemption is vouch-only as of P2-B phase 1), so this
      // arm is the second of two independent layers rather than the reachable
      // one — kept because a transition table that *accepts* `bond → ∅` is a
      // consensus rule waiting to be re-exposed by any future reordering.
      if (outputs.length === 0) {
        return {
          valid: false,
          error: `Illegal bond transition: bond forfeiture is not implemented; no burn shape exists`,
        };
      }

      // Settlement: BondBox(committed) → 1 KarmaBox owned by the inviter.
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      if (karmaOutputs.length !== 1 || outputs.length !== 1) {
        return {
          valid: false,
          error: `BondBox can only be spent to create exactly 1 KarmaBox or 1 committed BondBox`,
        };
      }
      // One bond per settlement. With several, only `inputs[0]`'s inviter and
      // probation would be checked and the rest would ride along — an invitee
      // committed on two inviters' bonds satisfies both `bond_dual` guards with
      // one signature, so a second bond could be routed to the first bond's
      // inviter. The contract's settlement row is singular for this reason.
      if (inputs.length !== 1) {
        return {
          valid: false,
          error: `Bond settlement must consume exactly one BondBox`,
        };
      }
      const bondIn = inputs[0] as BondBox;
      if (bondIn.inviteePublicKey.length !== 32) {
        return {
          valid: false,
          error:
            `Uncommitted BondBox has no standalone spend: its exits are the commit ` +
            `and cancel shapes`,
        };
      }
      // The bond's value only ever returns to the inviter (audit
      // F-consensus-1). Before this pin, the committed invitee — whose
      // signature satisfies `bond_dual` Path 2 — could sign `bond → own
      // KarmaBox` and take the deposit outright.
      const karmaOut = karmaOutputs[0] as KarmaBox;
      if (Buffer.from(karmaOut.owner).toString('hex') !==
          Buffer.from(bondIn.inviterId).toString('hex')) {
        return {
          valid: false,
          error: `Bond settlement karma output must be owned by the inviter`,
        };
      }
      // Spend-time unlock: probation expired, or the invitee's karma stands at
      // the threshold *now*. "Reached the threshold within probation" is a
      // claim about history that a spend-time check cannot see; the early-unlock
      // leg is inviter-favourable timing, not a weakening.
      const probationExpired = currentBlockHeight > bondIn.probationEndBlock;
      const thresholdMet =
        deps.getKarmaValue(bondIn.inviteePublicKey) >= INVITE_KARMA_THRESHOLD;
      if (!probationExpired && !thresholdMet) {
        return {
          valid: false,
          error:
            `Bond settlement is locked: probation runs to block ` +
            `${bondIn.probationEndBlock} and the invitee has not reached ` +
            `${INVITE_KARMA_THRESHOLD} karma`,
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

    // ------------------------------------------------------------------
    // VouchBox → (none) — unvouch, karma returned via cooldown
    // ------------------------------------------------------------------
    case 'vouch': {
      if (outputs.length !== 0) {
        return {
          valid: false,
          error: `VouchBox can only be spent to produce no outputs (unvouch)`,
        };
      }
      return { valid: true };
    }

    default:
      return { valid: false, error: `Unknown box type: ${inputType}` };
  }
}

// ---------------------------------------------------------------------------
// Internal validation helpers (extracted from validateAndApplyTx)
// ---------------------------------------------------------------------------

/**
 * Reject output values that cannot take part soundly in conservation
 * arithmetic: non-bigint, negative, or at/above 2^64 (the bound that keeps
 * every value in the uniform CBOR uint64 encoding).
 *
 * Outputs are attacker-controlled, so this is a security boundary rather than
 * input hygiene: a negative value lets a transaction balance its sums while
 * minting into a sibling box — `K(10) → K(15) + Like(-5)` sums to 10 == 10.
 * `json-to-tx.ts` applies the same rule at the HTTP edge so clients get a
 * clear error; this check covers every other entry point (gossip, blocks).
 * This is the tight apply-side twin of validation's loose coinbase pre-filter.
 */
function checkOutputValues(outputs: AnyBoxCandidate[]): UtxoResult {
  for (const box of outputs) {
    const value = box.value as unknown;
    if (typeof value !== 'bigint' || value < 0n || value >= (1n << 64n)) {
      return {
        valid: false,
        error: `Invalid box value: expected a non-negative bigint < 2^64, got ${String(value)}`,
      };
    }
  }
  return { valid: true };
}

/**
 * Enforce strict face-value conservation — `sum(inputs) == sum(outputs)` for
 * **every** box type.
 *
 * Karma and credits are minted or burned only in block-application paths (like
 * rewards, decay, coinbase), never inside a user transaction, so no box type
 * gets a blanket exemption. **One** zero-output spend is the deliberate
 * exception:
 *
 * - **VouchBox burn (unvouch)** — the staked karma is escrowed in the
 *   `vouch_cooldowns` table and re-minted to the voucher at maturity by
 *   `processVouchCooldowns` (block-apply). An escrow round-trip, not a burn.
 *   `checkTransitions` *requires* unvouch to have zero outputs, so this is the
 *   shape of every legal unvouch, not a loophole. The escrow living outside the
 *   UTXO set (and therefore outside the AVL+ state root) is a known wart —
 *   modelling it as a maturing box is tracked separately.
 *
 * The BondBox once shared that exemption and **lost it** in P2-B phase 1.
 * Forfeiture is not implemented and no legal transition destroys a bond, so an
 * exemption here bought nothing but a burn shape — one the *committed invitee*
 * could reach, since their signature satisfies `bond_dual`, letting them torch
 * the inviter's stake out of spite. The karma-econ vesting design owns
 * forfeiture and will define its burn path when it lands.
 */
function checkValueConservation(
  inputBoxes: AnyBox[],
  outputs: AnyBoxCandidate[],
): UtxoResult {
  const outputValueCheck = checkOutputValues(outputs);
  if (!outputValueCheck.valid) return outputValueCheck;

  const inputType = inputBoxes[0]!.boxType;
  if (outputs.length === 0 && inputType === 'vouch') {
    return { valid: true };
  }

  const totalInputValue = inputBoxes.reduce((sum, b) => sum + b.value, 0n);
  const totalOutputValue = outputs.reduce((sum, b) => sum + b.value, 0n);

  if (totalInputValue !== totalOutputValue) {
    return {
      valid: false,
      error: `Value non-conservation: inputs=${totalInputValue}, outputs=${totalOutputValue}`,
    };
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
        const ownerBox = box as { owner?: Uint8Array; voucherId?: Uint8Array };
        const pubKey = ownerBox.owner ?? ownerBox.voucherId;
        if (!pubKey || !verifyGuardSignature(tx, txHash, pubKey)) {
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

      case 'hash_preimage_with_bond': {
        // Cross-box check: a BondBox input in the same tx is required
        const bondInput = inputBoxes.find((b): b is BondBox => b.boxType === 'bond');
        if (!bondInput) {
          return {
            valid: false,
            error: `Invite reveal requires a BondBox input alongside the InviteBox`,
          };
        }
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
        if (bondInput.inviteePublicKey.length === 32) {
          // Bond is committed — either reveal (invitee signs) or cancel (inviter signs)
          if (
            !verifyGuardSignature(tx, txHash, bondInput.inviteePublicKey) &&
            !verifyGuardSignature(tx, txHash, bondInput.inviterId)
          ) {
            return {
              valid: false,
              error: `Reveal must be signed by the committed invitee or the inviter`,
            };
          }
        }
        // If not committed, just the preimage suffices (cancel path)
        break;
      }

      case 'bond_dual': {
        const bondBox = box as BondBox;
        // Path 1: inviter_signature — inviter reclaims the bond (cancel)
        if (verifyGuardSignature(tx, txHash, bondBox.inviterId)) {
          break;
        }
        // Path 2: invitee_signature — invitee reveals after commit
        if (
          bondBox.inviteePublicKey.length === 32 &&
          verifyGuardSignature(tx, txHash, bondBox.inviteePublicKey)
        ) {
          break;
        }
        // Path 3: hash_preimage — invitee commits their identity
        const bondPreimage = tx.preimages?.[box.id!];
        if (!bondPreimage) {
          return {
            valid: false,
            error: `Bond box ${box.id} requires inviter signature, committed invitee signature, or preimage for commit`,
          };
        }
        // Look up the paired InviteBox to get the expected secretHash.
        //
        // Resolved from `(bond.txId, bond.inviteOutputIndex)` rather than from a
        // stored box id (user decision, 2026-08-06): a box id here would be
        // circular, since it derives from the very txId that hashes this field.
        // The pair is confined to one transaction by construction, so this
        // cannot reach an invite the bond did not ship with — the old
        // `getBox(inviteBoxId)` could name any box in the world.
        const pairedInviteBox = deps.getBoxByProvenance(
          bondBox.txId,
          bondBox.inviteOutputIndex,
        );
        if (!pairedInviteBox || pairedInviteBox.boxType !== 'invite') {
          return {
            valid: false,
            error:
              `InviteBox at (${bondBox.txId}, ${bondBox.inviteOutputIndex}) ` +
              `not found for bond commit`,
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
        // H-2: bind the commit to the key it names. The committed invitee is the
        // OUTPUT BondBox's inviteePublicKey; require a VALID signature from it.
        // A non-empty signatures map — or a signature from any other key — no
        // longer authorizes the commit. (This does NOT stop a front-runner who
        // commits under their own key; that needs invitee-binding at invite
        // creation, deferred to the karma-econ emission model.)
        const committedBondOut = tx.outputs.find(
          (o): o is BondBox => o.boxType === 'bond',
        );
        if (!committedBondOut || committedBondOut.inviteePublicKey.length !== 32) {
          return {
            valid: false,
            error: `Bond commit must produce a committed BondBox output`,
          };
        }
        if (!verifyGuardSignature(tx, txHash, committedBondOut.inviteePublicKey)) {
          return {
            valid: false,
            error: `Bond commit must be signed by the committed invitee`,
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

// ---------------------------------------------------------------------------
// Public API: validateTx, revalidateTxInContext, applyTx, validateAndApplyTx
// ---------------------------------------------------------------------------

/**
 * Validate a transaction without applying it (read-only).
 *
 * Performs 6 validation steps:
 * 1. No duplicate input IDs
 * 2. All inputs exist and are unspent
 * 3. All inputs have the same boxType
 * 4. Face-value conservation — sum(in) == sum(out) for every box type, plus
 *    non-negative integer output values (sole exception: the zero-output
 *    VouchBox spend)
 * 5. Guard satisfaction (signatures)
 * 6. Legal box transitions (height-aware — bond commit and settlement)
 *
 * Karma decay is handled by the periodic decay engine, not at transaction
 * validation time.
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
  const transitionCheck = checkTransitions(
    inputBoxes,
    tx.outputs,
    currentBlockHeight,
    deps,
  );
  if (!transitionCheck.valid) return transitionCheck;

  // Compute output IDs for the caller (so applyTx doesn't re-compute)
  const txId = computeTxId(tx);
  const computedOutputs = tx.outputs.map((box, index) =>
    materializeOutput(box, txId, index),
  );

  return {
    valid: true,
    computedOutputs,
    txId,
  };
}

/**
 * Turn a transaction output candidate into the box that goes into the ledger:
 * the creating transaction's real id, the output's position within
 * `tx.outputs`, and the derived box id (Spec G phase C3).
 *
 * The `txId` is passed in rather than recomputed. `computeTxId` hashes outputs
 * through `canonicalBoxBytes`, so it does not *observe* provenance — which
 * means re-deriving it from a box that already carries some would be silently
 * wrong rather than an error.
 *
 * Any client-supplied `id`/`txId`/`index` is **stripped before** the canonical
 * pair is appended, not overwritten in place. cbor-x emits map keys in
 * insertion order under `variableMapSize: false`, so overwriting would leave
 * the keys wherever the client's CBOR happened to put them — and `rowToBox`
 * always appends them last. The two shapes would then serialize to different
 * bytes, so a node that restarted and re-bootstrapped its prover from SQLite
 * would compute a different `stateRoot` than one that stayed up. Outputs are
 * attacker-controlled CBOR, so this is reachable rather than theoretical.
 *
 * Exported because `block-apply.ts` materializes the outputs of block-embedded
 * transactions on its own path. One rule for both, so the pool path and the
 * block path cannot derive different ids for the same transaction.
 */
export function materializeOutput(box: AnyBoxCandidate, txId: string, index: number): AnyBox {
  // The destructure still names all three keys even though `AnyBoxCandidate`
  // declares none of them: outputs are decoded from attacker-supplied CBOR, so
  // the runtime shape is not bound by the type.
  const { id: _id, txId: _txId, index: _index, ...candidate } = box as AnyBox;
  const withProvenance = { ...candidate, txId, index } as AnyBox;
  return { ...withProvenance, id: computeBoxId(withProvenance) } as AnyBox;
}

/**
 * Revalidate a previously-validated transaction at a later height.
 *
 * Skips expensive checks (signatures, transitions) and only verifies:
 * - Inputs are still unspent (liveness)
 *
 * Karma decay is handled by the periodic decay engine.
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
      // The box goes in exactly as `materializeOutput` built it. This used to
      // rewrite `createdAtBlock` to the settled height while leaving the id
      // committed to the client's *declared* height — that discrepancy **was**
      // M-11, and phase G3b closes it by deleting the field rather than by
      // rewriting it here. The settled height still reaches the
      // `created_at_block` store column; `insertBox` takes it from the open
      // journal, which is the only place it can now come from.
      //
      // Spreading the box would also be wrong now for a second reason: any key
      // added or reordered here changes the id, since `computeBoxId` hashes the
      // box itself.
      deps.insertBox(box);
    }
  });
}

