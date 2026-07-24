import type { UserId } from './identity.js';
import type { Post, PostId } from './post.js';
import type { BoxId, TxId, LikeBox } from './utxo.js';
import type { StumpId } from './stump.js';

// ---------------------------------------------------------------------------
// Like reward (computed during epoch tally)
// ---------------------------------------------------------------------------

export interface LikeReward {
  targetPostId: PostId;
  likeCount: number;
  authorReward: number;
  likerRefunds: Record<string, number>;  // likerId → net karma refund
  postLockKarmaUnlocked?: number;         // Karma released from post lock this epoch
}

// ---------------------------------------------------------------------------
// Sub-block (user-produced)
// ---------------------------------------------------------------------------

export interface SubBlock {
  subBlockId: PostId;         // = post.postId (the post IS the sub-block)
  post: Post;                 // The post (with PoW = sub-block proof)
  likeBoxes: LikeBox[];       // Pending likes riding as sidecars
  producerId: UserId;         // = post.author
  protocolVersion: number;
}

// ---------------------------------------------------------------------------
// Epoch tally
// ---------------------------------------------------------------------------

export interface EpochTally {
  rewards: Record<PostId, LikeReward>;
}

// ---------------------------------------------------------------------------
// Coinbase output (block reward)
// ---------------------------------------------------------------------------

export interface CoinbaseOutput {
  owner: UserId;              // 32-byte recipient public key
  value: number;              // Credits minted
  lockedUntilBlock: number;   // Height at which credits become spendable
  isTreasury: boolean;        // Treasury or miner output
}

// ---------------------------------------------------------------------------
// Block header — what gets hashed for block ID and PoW
// ---------------------------------------------------------------------------

export interface BlockHeader {
  protocolVersion: number;
  height: number;
  prevBlockHash: string;        // hex(32) — hash of previous header
  subBlockRoot: string;         // hex(32) — Merkle root over DAG content
  utxoTxRoot: string;           // hex(32) — Merkle root over UTXO content
  stateRoot: string;            // hex(33) — AVL+ digest (zeroed for MVP)
  validatorId: UserId;
  powNonce: number;
  powTargetBits: number;
  createdAt: number;            // unix ms
}

/** 33 zero bytes — placeholder for future AVL+ state root. */
export const EMPTY_STATE_ROOT = '00'.repeat(33);

// ---------------------------------------------------------------------------
// Body sections (independently requestable)
// ---------------------------------------------------------------------------

export interface SubBlockTree {
  subBlockRefs: PostId[];       // sub-blocks anchored in this block
  stumpIds: StumpId[];          // stumps committed in this block
}

export interface UtxoTxTree {
  utxoTxIds: TxId[];            // UTXO transactions
  likeBoxIds: BoxId[];          // standalone likes (no sub-block to ride)
  coinbaseOutputs: CoinbaseOutput[];
  epochTallyResults?: EpochTally;
}

// ---------------------------------------------------------------------------
// Ordering block (validator-produced)
// ---------------------------------------------------------------------------

export interface OrderingBlock {
  header: BlockHeader;
  subBlockTree: SubBlockTree;
  utxoTxTree: UtxoTxTree;
  validatorSignature: Uint8Array;  // 64 bytes — Ed25519 over header hash
}
