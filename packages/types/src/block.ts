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
// Ordering block (validator-produced)
// ---------------------------------------------------------------------------

export interface OrderingBlock {
  height: number;                    // Monotonically increasing, starting from 1
  hash: string;                      // blake2b512(serializeBlock(...)).subarray(0,32).toString('hex')
  prevBlockHash: string;             // Previous ordering block hash
  subBlockRefs: PostId[];            // Sub-blocks anchored by this block
  likeBoxIds: BoxId[];               // Standalone likes (no sub-block to ride)
  utxoTxIds: TxId[];                 // UTXO transactions in this block
  stumpIds: StumpId[];               // Stumps committed in this block
  validatorId: UserId;               // Block producer
  validatorSignature: Uint8Array;    // 64 bytes — Ed25519 over block hash
  powNonce: number;                  // PoW solution
  powTargetBits: number;             // Difficulty target for this block
  coinbaseOutputs: CoinbaseOutput[]; // Block reward distribution
  epochTallyResults?: EpochTally;    // Present if epoch transition triggered
  protocolVersion: number;
  createdAt: number;                 // Unix ms
}
