import { createHash } from 'crypto';
import { Encoder } from 'cbor-x';
const hashEncoder = new Encoder({ tagUint8Array: false, useRecords: false, mapsAsObjects: true });
import type { UserId } from './identity.js';
import type { PostId } from './post.js';
import { PROTOCOL_VERSION } from './constants.js';

// ---------------------------------------------------------------------------
// Box identity
// ---------------------------------------------------------------------------

export type BoxId = string;

/**
 * Deterministic box ID from canonical CBOR encoding of the box (excluding the
 * `id` field itself). Same box bytes = same ID.
 */
/** cbor-x returns Buffer; cast to Uint8Array for hash.update compatibility. */
function encodeForHash(data: unknown): Uint8Array {
  return hashEncoder.encode(data) as unknown as Uint8Array;
}

export function computeBoxId(box: Omit<BoxBase, 'id'>): BoxId {
  // Strip `id` at runtime if present (TS Omit<> doesn't enforce at runtime)
  const { id: _, ...rest } = box as BoxBase;
  return createHash('blake2b512').update(encodeForHash(rest)).digest().subarray(0, 32).toString('hex');
}

// ---------------------------------------------------------------------------
// Box types
// ---------------------------------------------------------------------------

export type BoxGuard = 'owner_signature' | 'epoch_tally' | 'hash_preimage' | 'inviter_signature' | 'bond_dual' | 'hash_preimage_with_bond';

export interface BoxBase {
  id?: BoxId;           // Computed via computeBoxId; optional during construction
  boxType: 'karma' | 'credit' | 'like' | 'invite' | 'bond' | 'post_lock';
  value: number;
  createdAtBlock: number;
}

// --- Karma ---

export interface KarmaBox extends BoxBase {
  boxType: 'karma';
  owner: Uint8Array;          // 32 raw bytes — Ed25519 public key
  guard: 'owner_signature';
  proofSource: string;        // PostId | StumpHash | InviteTxId
  lastTouchBlock: number;     // = createdAtBlock on creation
  decayBurn?: boolean;
}

// --- Credit ---

export interface CreditBox extends BoxBase {
  boxType: 'credit';
  owner: Uint8Array;          // 32 raw bytes
  guard: 'owner_signature';
  proofSource: number;        // Ordering block height that minted these credits
  lockedUntilBlock?: number;  // Block height before which credits cannot be spent
}

// --- Like ---

export interface LikeBox extends BoxBase {
  boxType: 'like';
  value: 2;                   // LIKE_COST — always 2
  likerId: UserId;
  targetPostId: PostId;
  guard: 'epoch_tally';       // Locked until epoch tally
}

// --- Invite ---

export interface InviteBox extends BoxBase {
  boxType: 'invite';
  value: number;                    // N karma transferred
  secretHash: Uint8Array;           // 32 bytes — H(s) = blake2b512(s).subarray(0,32)
  inviterId: UserId;
  guard: 'hash_preimage_with_bond'; // Unlocked by preimage + committed BondBox
}

// --- Bond ---

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

// --- Post Lock ---

export interface PostLockBox extends BoxBase {
  boxType: 'post_lock';
  value: number;              // Current locked karma (decreases each epoch as likes accumulate)
  originalValue: number;      // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
  owner: Uint8Array;          // 32 raw bytes — post author's Ed25519 public key
  targetPostId: PostId;       // The post this lock secures
  guard: 'epoch_tally';       // Only consumable by epoch processing
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type AnyBox = KarmaBox | CreditBox | LikeBox | InviteBox | BondBox | PostLockBox;

// ---------------------------------------------------------------------------
// UTXO transaction
// ---------------------------------------------------------------------------

export type TxId = string;

export interface UtxoTransaction {
  inputs: BoxId[];
  outputs: AnyBox[];
  signatures: Record<string, Uint8Array>;  // publicKey (hex) → Ed25519 sig (64 bytes) over txId
  preimages?: Record<string, Uint8Array>;  // boxId → hash preimage for hash_preimage guards
  protocolVersion: number;
}

/**
 * Deterministic transaction ID. Hashes inputs, serialized outputs (excluding
 * per-output `id`), preimages (sorted by boxId) when present, and
 * protocolVersion.
 */
export function computeTxId(tx: UtxoTransaction): TxId {
  const h = createHash('blake2b512');
  for (const input of tx.inputs) {
    h.update(input);
  }
  for (const output of tx.outputs) {
    // Exclude id from output hashing (it's computed from the output itself)
    const { id, ...rest } = output;
    h.update(encodeForHash(rest));
  }
  // Include preimages in tx identity for hash_preimage guard validation
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

// ---------------------------------------------------------------------------
// Box selection
// ---------------------------------------------------------------------------

/**
 * Largest-first UTXO selection. Returns the minimal subset of boxes whose
 * combined value covers `requiredAmount`. Assumes boxes are pre-sorted by
 * value descending. Throws if the total value of all boxes is insufficient.
 */
export function selectBoxes<T extends { value: number }>(
  boxes: T[],
  requiredAmount: number,
): T[] {
  if (requiredAmount <= 0) return [];

  let accumulated = 0;
  const selected: T[] = [];
  for (const box of boxes) {
    accumulated += box.value;
    selected.push(box);
    if (accumulated >= requiredAmount) break;
  }

  if (accumulated < requiredAmount) {
    throw new Error('Insufficient total value');
  }

  return selected;
}
