// Protocol constants
export {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  KARMA_POSTING_MINIMUM,
  KARMA_DECAY_RATE,
  KARMA_DECAY_GRACE_BLOCKS,
  KARMA_FLOOR,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_FREE_THRESHOLD,
  EPOCH_BLOCKS,
  MAX_PENDING_INVITES,
  INVITE_MIN_KARMA,
  INVITE_BOND_KARMA,
  INVITE_PROBATION_BLOCKS,
  INVITE_KARMA_THRESHOLD,
  GENESIS_COMMITTEE_KEYS,
  GENESIS_KARMA_PER_MEMBER,
  GENESIS_CREDITS_PER_MEMBER,
  BOOTSTRAP_PERIOD_BLOCKS,
  ORDERING_BLOCK_REWARD_CREDITS,
} from './constants.js';

// Identity
export { generateKeyPair, getUserId } from './identity.js';
export type { KeyPair, UserId } from './identity.js';

// Base58
export { base58Encode, base58Decode } from './base58.js';

// Posts
export { signingHash, computePostId, getPostDiscriminator, buildProfileContent } from './post.js';
export type { Post, PostId } from './post.js';

// UTXO
export { computeBoxId, computeTxId } from './utxo.js';
export type {
  BoxId,
  BoxBase,
  BoxGuard,
  KarmaBox,
  CreditBox,
  LikeBox,
  InviteBox,
  BondBox,
  AnyBox,
  UtxoTransaction,
  TxId,
} from './utxo.js';

// Stumps
export { computeStumpId } from './stump.js';
export type { PruneIntent, KarmaDelta, Stump, StumpId } from './stump.js';

// Blocks
export type { SubBlock, OrderingBlock, EpochTally, LikeReward } from './block.js';

// Serialization
export {
  serializeBox,
  serializeTx,
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeSubBlock,
  decodeSubBlock,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from './serialization.js';
