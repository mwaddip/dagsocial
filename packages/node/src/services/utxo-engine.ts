import { createHash, verify as cryptoVerify } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  INVITE_KARMA_THRESHOLD,
  INVITE_PROBATION_BLOCKS,
  LIKE_KARMA_COST,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type { UtxoTransaction, AnyBox, AnyBoxCandidate, BoxGuard, KarmaBox, BondBox, InviteBox, VouchBox } from '@dagsocial/types';

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
  /**
   * True while a cooldown row exists for `(voucherId, targetId)`.
   *
   * Consensus input (P2-B phase 2): a vouch cast is invalid while the pair is
   * cooling down. Without the gate a block-embedded vouch→unvouch pair for a
   * pair with a live cooldown reaches `insertVouchCooldown`'s INSERT OR
   * REPLACE and destroys the first escrow's pending re-mint on the forward
   * path. Backed by the store's `hasActiveVouchCooldown` at every production
   * site — row existence IS activity, since matured rows are deleted by
   * `processVouchCooldowns` in the same block application that mints them.
   */
  hasActiveVouchCooldown: (voucherId: Uint8Array, targetId: Uint8Array) => boolean;
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
  likeTarget: string | undefined,
): { valid: boolean; error?: string } {
  // P2-D: a like transaction (`likeTarget` present) has exactly one legal
  // shape — the liker's karma boxes in, one karma box out (the arm in the
  // karma case below). Gated here so the mixed-input shapes (invite claim,
  // invite cancel) cannot carry a bolted-on `likeTarget` through their own
  // handlers; the conservation carve independently requires all-karma inputs.
  if (likeTarget !== undefined && inputs.some((b) => b.boxType !== 'karma')) {
    return {
      valid: false,
      error: `likeTarget is only legal on an all-karma burn transaction`,
    };
  }

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
    // KarmaBox → KarmaBox (same owner, balance change; the P2-D like burn
    //                      when `likeTarget` is present)
    // KarmaBox → KarmaBox + InviteBox + BondBox (invite creation)
    // ------------------------------------------------------------------
    case 'karma': {
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      const inviteOutputs = outputs.filter((o) => o.boxType === 'invite');
      const bondOutputs = outputs.filter((o) => o.boxType === 'bond');
      const postLockOutputs = outputs.filter((o) => o.boxType === 'post_lock');
      const vouchOutputs = outputs.filter((o) => o.boxType === 'vouch');

      // A 'like'-type output is an illegal transition as of P2-D: a like is a
      // burn transaction named by `likeTarget`, never a box.
      const totalOutputs =
        karmaOutputs.length + inviteOutputs.length + bondOutputs.length + postLockOutputs.length + vouchOutputs.length;

      if (totalOutputs !== outputs.length) {
        return {
          valid: false,
          error: `Illegal karma transition: outputs contain non-karma/invite/bond/post_lock/vouch boxes`,
        };
      }

      // All karma inputs must share one owner (P2-B phase 4). Every karma
      // output is pinned to `inputKarma.owner` below, but nothing bound the
      // inputs to each other — validateTx step 3 only requires a common
      // boxType — so [karmaA, karmaB] → karmaA validated with both owners
      // co-signing, and B's karma became A's. Consensual, but karma is
      // non-transferable by rule: a consensual transfer is still a transfer,
      // and it prices off-chain. Self-consolidation of one owner's boxes is
      // the legitimate multi-input case and stays legal; credits are
      // deliberately exempt — tradeable, so multi-owner credit inputs are an
      // ordinary multi-party payment.
      const inputKarma = inputs[0] as KarmaBox;
      const inputOwnerHex = Buffer.from(inputKarma.owner).toString('hex');
      for (const box of inputs) {
        if (Buffer.from((box as KarmaBox).owner).toString('hex') !== inputOwnerHex) {
          return {
            valid: false,
            error: `Karma cannot be transferred (karma inputs have different owners)`,
          };
        }
      }

      // All karma outputs must belong to the same owner as the consumed karma.
      // Exception: system box faucet grant — 2 karma outputs, one same-owner
      // (system change), one different-owner (faucet beneficiary).
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

      if (likeTarget !== undefined) {
        // P2-D like arm: `likeTarget` present ⇒ this exact shape and nothing
        // else. All inputs are karma boxes sharing one owner (pinned above),
        // the single output is a karma box with that same owner (pinned
        // above), and the transaction burns exactly LIKE_KARMA_COST. The
        // conservation carve enforces the deficit independently — two layers,
        // the same pattern as the bond-burn rejection.
        if (outputs.length !== 1 || karmaOutputs.length !== 1) {
          return {
            valid: false,
            error: `Invalid like transition: exactly one karma output and no other outputs expected`,
          };
        }
        const totalIn = inputs.reduce((sum, b) => sum + b.value, 0n);
        const deficit = totalIn - (karmaOutputs[0] as KarmaBox).value;
        if (deficit !== LIKE_KARMA_COST) {
          return {
            valid: false,
            error: `Like must burn exactly ${LIKE_KARMA_COST} karma, got a deficit of ${deficit}`,
          };
        }
      } else if (postLockOutputs.length > 0) {
        // karma → karma + post_lock (post creation lock)
        if (postLockOutputs.length !== 1 || inviteOutputs.length > 0 || bondOutputs.length > 0 || vouchOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid post-lock transition: exactly 1 karma + 1 post_lock output expected`,
          };
        }
      } else if (vouchOutputs.length > 0) {
        // karma → karma + vouch
        if (vouchOutputs.length !== 1 || inviteOutputs.length > 0 ||
            bondOutputs.length > 0 ||
            postLockOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid vouch transition: exactly 1 karma + 1 vouch output expected`,
          };
        }
        const vouchOut = vouchOutputs[0] as VouchBox;
        // The stake is pinned at cast: a vouch is one vote and always stakes
        // exactly VOUCH_KARMA_AMOUNT (audit F-consensus-3). Before the pin,
        // value was bounded only by conservation and `checkOutputValues` —
        // which permits 0n — while unvouch escrowed the constant: a 0-value
        // vouch matured into 1 karma minted from nothing, and a 100-value
        // vouch destroyed 99.
        if (vouchOut.value !== VOUCH_KARMA_AMOUNT) {
          return {
            valid: false,
            error:
              `Vouch cast must stake exactly ${VOUCH_KARMA_AMOUNT} karma, ` +
              `got ${vouchOut.value}`,
          };
        }
        // voucherId is pinned to the karma input's owner. `checkGuards`
        // resolves a VouchBox's signer as `owner ?? voucherId`, so a box
        // carrying a foreign voucherId is guarded by that foreign key: A
        // stakes their karma, B unvouches it, and the escrow matures to B — a
        // karma transfer with no invite, the property the whole invite/bond
        // mechanism protects.
        if (Buffer.from(vouchOut.voucherId).toString('hex') !==
            Buffer.from(inputKarma.owner).toString('hex')) {
          return {
            valid: false,
            error: `Vouch voucherId must be the karma input's owner`,
          };
        }
        // No re-vouch while the pair's escrow is cooling down (B6, promoted
        // from mempool policy to a consensus rule). The overwrite this blocks
        // is `insertVouchCooldown`'s INSERT OR REPLACE destroying a live
        // escrow's pending re-mint.
        if (deps.hasActiveVouchCooldown(vouchOut.voucherId, vouchOut.targetId)) {
          return {
            valid: false,
            error:
              `Vouch cast is locked: an active cooldown exists for this ` +
              `voucher/target pair`,
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
        // A bond is born uncommitted; committed state is reachable only
        // through the commit transition (P2-B phase 2). Without this pin an
        // inviter emits a bond *born committed* with a zeroed window, and the
        // settlement rule accepts an immediate reclaim to themselves — every
        // clause satisfied, the expiry leg vacuously true — while the
        // InviteBox stays live and claimable. The bond, the network's only
        // sybil cost, would cost nothing. This is what makes the commit-time
        // window pin mean anything: with it, every committed bond has passed
        // through the pinned commit path by construction.
        const bondOut = bondOutputs[0] as BondBox;
        if (bondOut.inviteePublicKey.length !== 0 ||
            bondOut.probationStartBlock !== 0 ||
            bondOut.probationEndBlock !== 0) {
          return {
            valid: false,
            error:
              `Invite creation must emit an uncommitted bond: ` +
              `inviteePublicKey empty and both probation fields zero`,
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
    // PostLockBox — consumed by block application only, rejected in guard check
    // ------------------------------------------------------------------
    case 'post_lock': {
      return {
        valid: false,
        error: `PostLockBox can only be consumed by block application (not user transactions)`,
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
      // An unvouch consumes exactly one VouchBox (P2-B phase 4). Block
      // application walks the inputs for a VouchBox, writes ONE escrow row,
      // and stops — while conservation exempts zero-output vouch spends
      // wholesale, however many inputs. A two-VouchBox unvouch therefore
      // consumed both stakes and escrowed one, destroying the other. Burning
      // several stakes in one transaction has no meaning in the design, so
      // the shape is inexpressible rather than handled — the same reasoning
      // as the bond settlement's single-input bound.
      if (inputs.length !== 1) {
        return {
          valid: false,
          error: `Unvouch must consume exactly one VouchBox`,
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

// `checkOutputValues` lived here and retired with the field-type pin: the
// schema's `u64` spec on every `value` (and `originalValue`) is the same
// bound with the same owner-per-rule discipline — one table, not a value
// check here and a type table there. `json-to-tx.ts`'s `assertValidBoxValue`
// stays as the HTTP-edge ergonomics twin, not the consensus gate.

/**
 * The one canonical guard per boxType. A guard is a pure function of the
 * discriminant — it carries zero information of its own — so any other value
 * on an output is a lie about the bytes, not an alternative spend policy.
 *
 * `rowToBox` (store/utxo.ts) fabricates these same constants when it rebuilds
 * a box from its row. The two tables must never disagree: this one decides
 * what enters the committed bytes (id preimage, AVL leaf), that one decides
 * what every later read reconstructs, and the store invariant
 * `computeBoxId(rowToBox(row)) === row.id` holds only while they match.
 * Deliberately NOT imported from the store — the engine owns the consensus
 * rule, the store mirrors it.
 *
 * Scheduled retirement (P2-C bundle): when `guard` leaves the consensus bytes
 * entirely, this table retires with it and the key-set half of the shape
 * check below keeps the schema closed.
 */
const CANONICAL_GUARD: Record<AnyBox['boxType'], BoxGuard> = {
  karma: 'owner_signature',
  credit: 'owner_signature',
  vouch: 'owner_signature',
  invite: 'hash_preimage_with_bond',
  bond: 'bond_dual',
  post_lock: 'block_apply',
};

/**
 * Runtime type vocabulary for output fields (field-type pin). Every `ok`
 * predicate is total on any JS value — `validateTx`'s totality claim rides on
 * that. The schema owns every field-content rule that is a TYPE; which VALUES
 * are legal per transition (probation windows, the vouch stake,
 * committed-vs-uncommitted key length) stays in the arms.
 */
type FieldType =
  | 'u64'
  | 'bytes32'
  | 'bytes0or32'
  | 'heightOrTransfer'
  | 'uint'
  | 'u32'
  | 'string'
  | 'boolean';

const U64_BOUND = 1n << 64n;

const FIELD_TYPE_CHECK: Record<FieldType, { ok: (v: unknown) => boolean; expected: string }> = {
  // The bound absorbed from the retired `checkOutputValues`: a negative value
  // balances conservation sums while minting into a sibling box, and at/above
  // 2^64 cbor-x leaves the uniform uint64 encoding for a tag-2 bignum.
  u64: {
    ok: (v) => typeof v === 'bigint' && v >= 0n && v < U64_BOUND,
    expected: 'a non-negative bigint < 2^64',
  },
  bytes32: {
    ok: (v) => v instanceof Uint8Array && v.length === 32,
    expected: 'a 32-byte Uint8Array',
  },
  // inviteePublicKey: empty = uncommitted, 32 bytes = committed.
  bytes0or32: {
    ok: (v) => v instanceof Uint8Array && (v.length === 0 || v.length === 32),
    expected: 'a Uint8Array of length 0 or 32',
  },
  // Exactly one field: credit `proofSource` — a block height, or -1, the
  // "transfer" sentinel every user-path credit transfer and faucet grant
  // stamps (routes/utxo.ts). The value set is closed — {-1} ∪ heights — so a
  // -5 is a lie, not a type; `v >= 0` admits -0, hence the Object.is guard.
  // P2-C row C8 deletes `proofSource` from the consensus bytes entirely; this
  // spec retires with it.
  heightOrTransfer: {
    ok: (v) =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      !Object.is(v, -0) &&
      (v === -1 || v >= 0),
    expected: 'a block height (non-negative safe integer) or -1 (the transfer sentinel)',
  },
  // Never -0: it is JSON- and CBOR-reachable and breaks byte round-trips —
  // cbor-x encodes -0 as a float where the store's JSON round-trip returns
  // integer 0. (`Number.isSafeInteger(-0)` and `-0 >= 0` both hold, so the
  // `Object.is` guard is load-bearing.)
  uint: {
    ok: (v) =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0),
    expected: 'a non-negative safe integer',
  },
  u32: {
    ok: (v) =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      v >= 0 &&
      !Object.is(v, -0) &&
      v <= 0xffffffff,
    expected: 'a non-negative safe integer <= 0xFFFFFFFF',
  },
  string: { ok: (v) => typeof v === 'string', expected: 'a string' },
  boolean: { ok: (v) => typeof v === 'boolean', expected: 'a boolean' },
};

/**
 * Total description of a rejected value for error messages. Never throws,
 * unlike `String(v)`, which invokes a caller-controlled `toString`. Decoded
 * CBOR/JSON only produces plain data, but the totality of `validateTx` should
 * not depend on that.
 */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof Uint8Array) return `bytes(${v.length})`;
  switch (typeof v) {
    case 'bigint':
      return `${v}n`;
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v);
    case 'string':
      return JSON.stringify(v.length > 64 ? `${v.slice(0, 64)}…` : v);
    case 'boolean':
      return String(v);
    default:
      return typeof v; // 'object' | 'function' | 'symbol' | 'undefined'
  }
}

// ---------------------------------------------------------------------------
// Transaction envelope shape — the step-0 gate
// ---------------------------------------------------------------------------

/**
 * 64 lowercase hex characters — the closed live set of ids. `computeBoxId`,
 * `computeTxId` and `computePostId` all emit `digest().subarray(0,32)` as
 * lowercase hex and nothing else, so an uppercase or short id names no box
 * that can ever exist.
 */
const HEX64 = /^[0-9a-f]{64}$/;

const ENVELOPE_REQUIRED = ['inputs', 'outputs', 'signatures', 'protocolVersion'] as const;

/** Closed: `computeTxId` hashes only these, so any other key is free malleability. */
const ENVELOPE_ALLOWED: ReadonlySet<string> = new Set<string>([
  ...ENVELOPE_REQUIRED,
  'preimages',
  'likeTarget',
]);

/**
 * A plain object: not null, not an array, and its prototype is
 * `Object.prototype` or null.
 *
 * The prototype clause is load-bearing, not decoration. Every downstream read
 * is `tx.likeTarget` / `tx.signatures[hexKey]` / `tx.preimages?.[id]` — plain
 * property reads that walk the prototype chain — while this gate decides
 * presence with `Object.hasOwn`. Pinning the prototype is what makes those two
 * agree: without it an object carrying the four required keys but inheriting a
 * `likeTarget` would pass a hasOwn-based gate and still drive `computeTxId`
 * and the conservation carve-out off the inherited value.
 *
 * Measured (2026-08-08), correcting the contracted rationale: cbor-x does NOT
 * set the prototype from a `__proto__` map key — it renames the key to
 * `__proto_` on decode, leaving `Object.prototype` intact. So the CBOR path
 * lands in the closed-key-set reject below, and `JSON.parse` (Express's body
 * parser) likewise defines `__proto__` as an own key rather than assigning it.
 * Both clauses stay anyway: they close the class structurally instead of
 * resting on a decoder's internal sanitizing staying the way it is today.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Shared shape for the two hex-keyed byte maps: `signatures` (values exactly
 * 64 bytes — a raw Ed25519 signature) and `preimages` (values any length —
 * the bytes are already in memory post-decode and secret length was never a
 * consensus rule).
 */
function checkHexKeyedByteMap(
  map: Record<string, unknown>,
  field: 'signatures' | 'preimages',
  byteLength: number | null,
): UtxoResult {
  for (const key of Object.keys(map)) {
    if (!HEX64.test(key)) {
      return {
        valid: false,
        error: `Invalid tx envelope: ${field} key must be 64 lowercase hex characters, got ${describeValue(key)}`,
      };
    }
    const value = map[key];
    if (!(value instanceof Uint8Array)) {
      return {
        valid: false,
        error: `Invalid tx envelope: ${field}['${key}'] must be a Uint8Array, got ${describeValue(value)}`,
      };
    }
    if (byteLength !== null && value.length !== byteLength) {
      return {
        valid: false,
        error:
          `Invalid tx envelope: ${field}['${key}'] must be ${byteLength} bytes, ` +
          `got ${describeValue(value)}`,
      };
    }
  }
  return { valid: true };
}

/**
 * Transaction envelope shape (NODE_INTERFACE → "Transaction envelope shape").
 *
 * The outer twin of `checkOutputShape`: that check pins what is INSIDE
 * `tx.outputs`, this one pins that `tx` has the four fields at all and that
 * every one of them is the type its readers assume. Both exist for the same
 * reason — the transaction is attacker-controlled structure arriving over HTTP
 * JSON, gossip CBOR, and block-embedded CBOR — and until this gate landed the
 * envelope was the half nobody checked: measured on the pre-gate tree,
 * `inputs: null` threw at step 1's `.length`, `inputs: 5` at `new Set(5)`,
 * `inputs: [{}]` at the SQLite bind inside `getBox`, `outputs: null` inside
 * `checkOutputShape` itself, a non-array `outputs` OBJECT slipped that loop
 * (`length` undefined) and threw at conservation's `.reduce`, a missing or
 * `null` `signatures` threw at `tx.signatures[hexKey]`, and `likeTarget: null`
 * plus non-`Uint8Array` `preimages` values threw inside `computeTxId` — which
 * `checkGuards` calls on its first line, so the whole envelope reached the
 * hasher. Every one was an HTTP 500 or, through the block funnel, a
 * whole-block rejection logged as an unexpected failure.
 *
 * **Total**: returns `{valid: false}` and never throws for any decoded-CBOR
 * value. Error strings quote input through `describeValue`, never bare
 * `String(v)` — which would invoke a caller-controlled `toString`.
 *
 * The key set is **closed**. `computeTxId` hashes only the known fields, so an
 * extra envelope key is free malleability: two distinct CBOR byte strings
 * carrying one txId. Measured pre-gate — `{…, bogusKey: 'free'}` and the clean
 * tx hash identically, and the junk rode through validation into the store.
 * A key present with the value `undefined` rejects for the twin reason: CBOR
 * encodes `undefined`, `computeTxId`'s presence test is `!== undefined`, so a
 * present-`undefined` `likeTarget` hashes as absent (also measured) — the gate
 * refuses the ambiguity rather than picking a side.
 *
 * Presence is decided with `Object.hasOwn`, never truthiness or `in` — see
 * `isPlainObject` for what that buys and what it does not.
 *
 * Exported for direct testing. Call sites are `validateTx` step 0 and the
 * block funnel in `block-apply.ts`; gossip and the HTTP routes inherit it
 * through `validateTx`.
 */
export function checkTxEnvelope(tx: unknown): UtxoResult {
  // ---- 1. A plain, non-null, non-array object ----
  if (!isPlainObject(tx)) {
    return {
      valid: false,
      error: `Invalid tx envelope: expected a plain object, got ${
        Array.isArray(tx) ? 'array' : describeValue(tx)
      }`,
    };
  }

  // ---- 2. Closed key set; a present-undefined key rejects ----
  for (const key of Object.keys(tx)) {
    if (!ENVELOPE_ALLOWED.has(key)) {
      return { valid: false, error: `Invalid tx envelope: unexpected key '${key}'` };
    }
    if (tx[key] === undefined) {
      return {
        valid: false,
        error: `Invalid tx envelope: key '${key}' is present with value undefined`,
      };
    }
  }
  for (const key of ENVELOPE_REQUIRED) {
    if (!Object.hasOwn(tx, key)) {
      return { valid: false, error: `Invalid tx envelope: missing required key '${key}'` };
    }
  }

  // ---- 3. inputs: an array of box ids ----
  // Emptiness is step 1's rule ("at least one input"), not the gate's — the
  // gate owns shape, `validateTx` owns the semantic minimum.
  const inputs = tx.inputs;
  if (!Array.isArray(inputs)) {
    return {
      valid: false,
      error: `Invalid tx envelope: inputs must be an array, got ${describeValue(inputs)}`,
    };
  }
  for (let i = 0; i < inputs.length; i++) {
    const id: unknown = inputs[i];
    if (typeof id !== 'string' || !HEX64.test(id)) {
      return {
        valid: false,
        error:
          `Invalid tx envelope: inputs[${i}] must be 64 lowercase hex characters, ` +
          `got ${describeValue(id)}`,
      };
    }
  }

  // ---- 4. outputs: an array ----
  // Entries are NOT typed here — that is step 4's closed per-boxType schema.
  // This clause only guarantees the iteration and `.reduce` sites are total.
  if (!Array.isArray(tx.outputs)) {
    return {
      valid: false,
      error: `Invalid tx envelope: outputs must be an array, got ${describeValue(tx.outputs)}`,
    };
  }

  // ---- 5. signatures: a hex-keyed map of 64-byte signatures ----
  // An EMPTY map is legal: the uncommitted-bond cancel path is guard-satisfied
  // by preimage alone. Extra well-formed keys are shape-legal too — guards only
  // look keys up, nothing iterates, and the like path's exactly-one-signature
  // rule is `castLike` policy, not envelope shape.
  const signatures = tx.signatures;
  if (!isPlainObject(signatures)) {
    return {
      valid: false,
      error: `Invalid tx envelope: signatures must be a plain object, got ${describeValue(signatures)}`,
    };
  }
  const sigCheck = checkHexKeyedByteMap(signatures, 'signatures', 64);
  if (!sigCheck.valid) return sigCheck;

  // ---- 6. preimages: absent, or a NON-EMPTY hex-keyed map of byte strings ----
  // Present-but-empty rejects: `computeTxId` guards on truthiness then
  // iterates, so `{}` contributes nothing to the hash — measured pre-gate,
  // `preimages: {}` and absence produce the identical txId, the same
  // malleability clause 2 exists to kill. `jsonToTx` already normalizes `{}`
  // to absent on the HTTP edge, so this closes the CBOR paths behind it.
  if (Object.hasOwn(tx, 'preimages')) {
    const preimages = tx.preimages;
    if (!isPlainObject(preimages)) {
      return {
        valid: false,
        error: `Invalid tx envelope: preimages must be a plain object, got ${describeValue(preimages)}`,
      };
    }
    if (Object.keys(preimages).length === 0) {
      return {
        valid: false,
        error: 'Invalid tx envelope: preimages is present but empty (omit it instead)',
      };
    }
    const preimageCheck = checkHexKeyedByteMap(preimages, 'preimages', null);
    if (!preimageCheck.valid) return preimageCheck;
  }

  // ---- 7. protocolVersion: strictly PROTOCOL_VERSION ----
  // The same strict-equality posture as posts and block headers. No
  // version-keyed dispatch exists (repo-root CLAUDE.md warning) and this gate
  // does not pretend otherwise. Measured pre-gate: a tx SIGNED with
  // `protocolVersion: "x"` validated, pooled and applied end-to-end, with the
  // string `String()`-coerced into its own id preimage.
  if (tx.protocolVersion !== PROTOCOL_VERSION) {
    return {
      valid: false,
      error:
        `Invalid tx envelope: protocolVersion must be ${PROTOCOL_VERSION}, ` +
        `got ${describeValue(tx.protocolVersion)}`,
    };
  }

  // ---- 8. likeTarget: absent, or a post id ----
  if (Object.hasOwn(tx, 'likeTarget')) {
    const likeTarget = tx.likeTarget;
    if (typeof likeTarget !== 'string' || !HEX64.test(likeTarget)) {
      return {
        valid: false,
        error:
          `Invalid tx envelope: likeTarget must be 64 lowercase hex characters, ` +
          `got ${describeValue(likeTarget)}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Closed key set and per-field runtime types per boxType, in candidate form —
 * the `@dagsocial/types` box interfaces with `id`/`txId`/`index` removed
 * (`TYPES_INTERFACE` box definitions are authoritative). `required` keys must
 * be present; `optional` keys may be present or absent; nothing else may
 * appear; every present field must satisfy its `FieldType`.
 *
 * `boxType` and `guard` carry `null` specs: the discriminant is pinned by the
 * own-property table lookup itself, and `guard` by the CANONICAL_GUARD
 * equality — both stricter than any type check.
 */
const OUTPUT_SHAPE: Record<
  AnyBox['boxType'],
  {
    required: readonly string[];
    optional: readonly string[];
    allowed: ReadonlySet<string>;
    types: Readonly<Record<string, FieldType>>;
  }
> = (() => {
  const shape = (
    required: Readonly<Record<string, FieldType | null>>,
    optional: Readonly<Record<string, FieldType>> = {},
  ) => ({
    required: Object.keys(required),
    optional: Object.keys(optional),
    allowed: new Set([...Object.keys(required), ...Object.keys(optional)]),
    types: Object.fromEntries(
      [...Object.entries(required), ...Object.entries(optional)].filter(
        (e): e is [string, FieldType] => e[1] !== null,
      ),
    ),
  });
  return {
    karma: shape(
      { boxType: null, value: 'u64', owner: 'bytes32', guard: null, proofSource: 'string' },
      { decayBurn: 'boolean' },
    ),
    credit: shape(
      // `proofSource` is height-or-sentinel, not 'uint': production stamps -1
      // on every user-path transfer/faucet credit box — see the note above.
      {
        boxType: null,
        value: 'u64',
        owner: 'bytes32',
        guard: null,
        proofSource: 'heightOrTransfer',
      },
      { lockedUntilBlock: 'uint' },
    ),
    invite: shape({
      boxType: null,
      value: 'u64',
      secretHash: 'bytes32',
      inviterId: 'bytes32',
      guard: null,
    }),
    bond: shape({
      boxType: null,
      value: 'u64',
      inviterId: 'bytes32',
      inviteOutputIndex: 'u32',
      inviteePublicKey: 'bytes0or32',
      probationStartBlock: 'uint',
      probationEndBlock: 'uint',
      guard: null,
    }),
    post_lock: shape({
      boxType: null,
      value: 'u64',
      originalValue: 'u64',
      owner: 'bytes32',
      targetPostId: 'string',
      guard: null,
    }),
    vouch: shape({
      boxType: null,
      value: 'u64',
      voucherId: 'bytes32',
      targetId: 'bytes32',
      guard: null,
    }),
  };
})();

/**
 * Output shape — the closed per-boxType schema (guard-shape pin + field-type
 * pin, NODE_INTERFACE → "Output shape").
 *
 * Outputs are attacker-controlled structure (HTTP JSON via `jsonToTx`, gossip
 * and block-embedded CBOR), and both bytes-level consumers hash whatever keys
 * the object carries: `canonicalBoxBytes` (the id preimage) strips only
 * `id`/`txId`/`index`, `serializeBox` (the AVL leaf, so the `stateRoot`)
 * strips only `id`/`boxType`. An accepted key the schema does not pin — or a
 * lying `guard`, or a mistyped field — becomes a committed byte that
 * `rowToBox`'s reconstruction (canonical guard, typed columns, no stray keys)
 * can never reproduce: the store and the tree then permanently disagree about
 * the box's bytes, the divergence surface under journal replay and any future
 * snapshot sync. A mistyped field can also poison the row itself — a string
 * `originalValue` stored once made every later `rowToBox` of that box throw.
 *
 * Four rules per output:
 * - a key outside the closed set is a REJECT, never a silent strip — a
 *   stripped key would change the bytes the client signed, so their txId and
 *   signature would refer to an object the node never stored;
 * - `guard` must equal the boxType's one canonical guard;
 * - every present field's runtime type matches its `FieldType` spec in
 *   OUTPUT_SHAPE (`TYPES_INTERFACE` box definitions are the authority);
 * - an unknown `boxType` — or a `null`/non-object entry — is a reject here,
 *   not a late throw downstream, and the table lookup is an OWN-PROPERTY
 *   lookup (`Object.hasOwn`): `boxType: 'constructor'` lands in this reject
 *   instead of retrieving `Object.prototype.constructor` and throwing.
 *
 * Client-supplied `id`/`txId`/`index` keys are skipped rather than rejected:
 * they are structurally outside every committed byte (`canonicalBoxBytes`
 * strips them from the txId and box-id preimages, `materializeOutput` strips
 * them before appending the real provenance), so the schema is compared in
 * candidate form.
 *
 * A key that is present with the value `undefined` is a reject in both
 * positions: cbor-x encodes the key into the id preimage (`"decayBurn" f7`),
 * while `insertBox`/`rowToBox` treat `undefined` as absence and drop it — the
 * exact bytes-vs-store divergence this check closes. Presence means "own
 * enumerable key with a defined value".
 *
 * Exported for direct testing. Through `validateTx` this check runs at step 4
 * — the first consumer of `tx.outputs` — so it is the PRIMARY gate for every
 * malformed output, unknown boxTypes included. The transition arms' own
 * unknown-type rejections (the karma/credit totality counts, the
 * `outputs.length` pins), which made the unknown-boxType arm here unreachable
 * while the check ran at step 7, are now the defense-in-depth layer behind
 * it: they fire only if this gate regresses.
 */
export function checkOutputShape(outputs: AnyBoxCandidate[]): UtxoResult {
  for (let i = 0; i < outputs.length; i++) {
    const raw: unknown = outputs[i];
    // A null/non-object entry rejects through the unknown-boxType arm below
    // (its boxType read is undefined), never a throw.
    const box = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const boxTypeValue = box.boxType;
    if (typeof boxTypeValue !== 'string' || !Object.hasOwn(OUTPUT_SHAPE, boxTypeValue)) {
      return {
        valid: false,
        error: `Invalid output shape at index ${i}: unknown boxType ${
          typeof boxTypeValue === 'string' ? boxTypeValue : describeValue(boxTypeValue)
        }`,
      };
    }
    const boxType = boxTypeValue as AnyBox['boxType'];
    const shape = OUTPUT_SHAPE[boxType];
    for (const key of Object.keys(box)) {
      if (key === 'id' || key === 'txId' || key === 'index') continue;
      if (!shape.allowed.has(key)) {
        return {
          valid: false,
          error: `Invalid output shape at index ${i} (${boxType}): unexpected key '${key}'`,
        };
      }
      if (box[key] === undefined) {
        return {
          valid: false,
          error:
            `Invalid output shape at index ${i} (${boxType}): key '${key}' ` +
            `is present with value undefined`,
        };
      }
    }
    for (const key of shape.required) {
      if (box[key] === undefined) {
        return {
          valid: false,
          error: `Invalid output shape at index ${i} (${boxType}): missing required key '${key}'`,
        };
      }
    }
    if (box.guard !== CANONICAL_GUARD[boxType]) {
      return {
        valid: false,
        error:
          `Invalid output shape at index ${i} (${boxType}): guard must be ` +
          `'${CANONICAL_GUARD[boxType]}', got ${describeValue(box.guard)}`,
      };
    }
    for (const [key, fieldType] of Object.entries(shape.types)) {
      const value = box[key];
      // Required presence is enforced above; an undefined read here is an
      // absent optional.
      if (value === undefined) continue;
      const check = FIELD_TYPE_CHECK[fieldType];
      if (!check.ok(value)) {
        return {
          valid: false,
          error:
            `Invalid output shape at index ${i} (${boxType}): field '${key}' ` +
            `must be ${check.expected}, got ${describeValue(value)}`,
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Enforce strict face-value conservation — `sum(inputs) == sum(outputs)` for
 * **every** box type.
 *
 * Karma and credits are minted or burned only in block-application paths (like
 * payouts, decay, coinbase), never inside a user transaction, so no box type
 * gets a blanket exemption. Two deliberate carve-outs exist:
 *
 * - **The like burn (P2-D)** — `likeTarget` present ⟺ the transaction burns
 *   exactly `LIKE_KARMA_COST` from karma inputs. This is the biconditional's
 *   value half: `likeTarget` absent ⇒ zero deficit as always (strict equality
 *   below), present ⇒ exactly that deficit — never more, never less, never a
 *   surplus. The only karma-burning user transaction. Checked before the vouch
 *   exemption so a zero-output unvouch with a bolted-on `likeTarget` cannot
 *   shelter under it.
 *
 * - **VouchBox burn (unvouch)** — the staked karma is escrowed in the
 *   `vouch_cooldowns` table and re-minted to the voucher at maturity by
 *   `processVouchCooldowns` (block-apply). An escrow round-trip, not a burn.
 *   `checkTransitions` *requires* unvouch to have zero outputs, so this is the
 *   shape of every legal unvouch, not a loophole. The escrow living outside the
 *   UTXO set (and therefore outside the AVL+ state root) is a known wart —
 *   modelling it as a maturing box is tracked separately.
 *
 * The BondBox once shared the zero-output exemption and **lost it** in P2-B
 * phase 1. Forfeiture is not implemented and no legal transition destroys a
 * bond, so an exemption here bought nothing but a burn shape — one the
 * *committed invitee* could reach, since their signature satisfies `bond_dual`,
 * letting them torch the inviter's stake out of spite. The karma-econ vesting
 * design owns forfeiture and will define its burn path when it lands.
 */
function checkValueConservation(
  inputBoxes: AnyBox[],
  outputs: AnyBoxCandidate[],
  likeTarget: string | undefined,
): UtxoResult {
  // Output `value` types are pinned by the step-4 schema before this runs
  // (field-type pin), so the bigint sums below are total — this function must
  // never run on outputs that have not passed `checkOutputShape`.

  // P2-D like carve. `likeTarget` names a like, and a like burns exactly
  // LIKE_KARMA_COST from the liker's karma — any other deficit, a surplus, a
  // conserving transaction, or non-karma inputs under this field are invalid.
  if (likeTarget !== undefined) {
    if (!inputBoxes.every((b) => b.boxType === 'karma')) {
      return {
        valid: false,
        error: `likeTarget is only legal on an all-karma burn transaction`,
      };
    }
    const totalIn = inputBoxes.reduce((sum, b) => sum + b.value, 0n);
    const totalOut = outputs.reduce((sum, b) => sum + b.value, 0n);
    if (totalIn - totalOut !== LIKE_KARMA_COST) {
      return {
        valid: false,
        error:
          `Like non-conservation: a like must burn exactly ${LIKE_KARMA_COST} ` +
          `karma (inputs=${totalIn}, outputs=${totalOut})`,
      };
    }
    return { valid: true };
  }

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
 * Check guard satisfaction (signatures, hash preimages, settlement guards) for all inputs.
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

      case 'block_apply': {
        // Settlement-guarded boxes (PostLockBox) are consumable only by block
        // application — no user transaction spends them.
        return {
          valid: false,
          error: `Box with ${box.guard} guard can only be consumed by block application`,
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
 * Performs 8 validation steps:
 * 0. Transaction envelope shape — `tx` is a plain object with the closed key
 *    set, hex input ids, array outputs, a hex-keyed 64-byte signature map, a
 *    non-empty preimage map if present, and `protocolVersion` strictly equal
 *    to `PROTOCOL_VERSION` (NODE_INTERFACE → "Transaction envelope shape").
 *    Ahead of every other read of `tx`, so steps 1–7 dereference envelope
 *    fields under a shape guarantee.
 * 1. No duplicate input IDs
 * 2. All inputs exist and are unspent
 * 3. All inputs have the same boxType
 * 4. Output shape — every output is a non-null object matching the closed
 *    per-boxType schema: exact key set, the boxType's one canonical guard,
 *    and every field's runtime type (guard-shape pin + field-type pin,
 *    NODE_INTERFACE → "Output shape"). This is the first step that reads
 *    `tx.outputs`, so steps 5–7 dereference output fields under a schema
 *    guarantee.
 * 5. Face-value conservation — sum(in) == sum(out) for every box type (two
 *    carve-outs: the P2-D like burn — `likeTarget` present ⟺ deficit exactly
 *    LIKE_KARMA_COST — and the zero-output VouchBox spend). The `value` TYPE
 *    bound lives in step 4's schema.
 * 6. Guard satisfaction (signatures)
 * 7. Legal box transitions (height-aware — bond commit and settlement;
 *    `likeTarget`-aware — the like burn shape)
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
  // ---- 0. Transaction envelope shape ----
  // Ahead of every other read of `tx`: steps 1–7 index `tx.inputs`, iterate
  // `tx.outputs`, and hash the whole envelope inside `computeTxId`, all of
  // which were throw sites for a malformed envelope before this gate.
  const envelopeCheck = checkTxEnvelope(tx);
  if (!envelopeCheck.valid) return envelopeCheck;

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

  // ---- 4. Output shape: the closed per-boxType schema (guard-shape pin +
  // field-type pin) ----
  // First consumer of `tx.outputs`, ahead of every semantic rule: steps 5–7
  // dereference output fields under the schema's key-set and type guarantees
  // instead of defending per-site. (The guard-shape pin had placed this at
  // step 7 to preserve arm-specific errors; the field-type pin moved it —
  // rejections of MALFORMED outputs now surface shape errors, the accepted
  // set for well-typed outputs is unchanged.)
  const shapeCheck = checkOutputShape(tx.outputs);
  if (!shapeCheck.valid) return shapeCheck;

  // ---- 5. Value conservation ----
  const valueCheck = checkValueConservation(inputBoxes, tx.outputs, tx.likeTarget);
  if (!valueCheck.valid) return valueCheck;

  // ---- 6. Guard satisfaction ----
  const guardCheck = checkGuards(deps, tx, inputBoxes);
  if (!guardCheck.valid) return guardCheck;

  // ---- 7. Legal box transitions ----
  const transitionCheck = checkTransitions(
    inputBoxes,
    tx.outputs,
    currentBlockHeight,
    deps,
    tx.likeTarget,
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

