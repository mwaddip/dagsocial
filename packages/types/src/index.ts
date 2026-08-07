// Protocol constants
export {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  AVL_KEY_LENGTH,
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  KARMA_POSTING_MINIMUM,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
  POST_LOCK_UNLOCK_PER_LIKES,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_FREE_THRESHOLD,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  EPOCH_BLOCKS,
  MAX_PENDING_INVITES,
  INVITE_MIN_KARMA,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  INVITE_PROBATION_BLOCKS,
  INVITE_KARMA_THRESHOLD,
  GENESIS_COMMITTEE_KEYS,
  GENESIS_KARMA_PER_MEMBER,
  GENESIS_CREDITS_PER_MEMBER,
  BOOTSTRAP_PERIOD_BLOCKS,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  MEMPOOL_EXPIRY_BLOCKS,
  CREDIT_TREASURY_PCT,
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  ED25519_SPKI_PREFIX,
} from './constants.js';

// Network profiles (P2-A)
export {
  NETWORK_PROFILES,
  profileFor,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
} from './network.js';
export type { NetworkType, NetworkProfile } from './network.js';

// Identity
export { generateKeyPair } from './identity.js';
export type { KeyPair, UserId } from './identity.js';

// Base58
export { base58Encode, base58Decode } from './base58.js';

// Merkle tree
export { leafHash, nodeHash, buildMerkleRoot, hexToBuf } from './merkle.js';

// Posts
export { signingHash, computePostId, verifyPostId, getPostDiscriminator, buildProfileContent, postPowPreimage } from './post.js';
export type { Post, PostId } from './post.js';

// UTXO
export {
  computeBoxId,
  computeCandidateBoxId,
  computeMintTxId,
  computeTxId,
  canonicalBoxBytes,
  u32BE,
  selectBoxes,
  BOX_ID_DOMAIN,
  TX_ID_DOMAIN,
  MINT_ID_DOMAIN,
  IDENTITY_KEY_DOMAIN,
} from './utxo.js';
export type {
  BoxId,
  BoxCandidate,
  CandidateOf,
  AnyBoxCandidate,
  BoxBase,
  BoxGuard,
  MintReason,
  KarmaBox,
  CreditBox,
  LikeBox,
  InviteBox,
  BondBox,
  PostLockBox,
  VouchBox,
  AnyBox,
  UtxoTransaction,
  TxId,
} from './utxo.js';

// Stumps
export { computePruneEntryId, serializePruneEntry } from './stump.js';
export type { PruneIntent, KarmaDelta, Stump, StumpId, PruneEntry } from './stump.js';

// Blocks
export { EMPTY_STATE_ROOT, cumulativeWork, subBlockFromPost } from './block.js';
export type {
  SubBlock,
  SubBlockEntry,
  OrderingBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  CoinbaseOutput,
  EpochTally,
  LikeReward,
} from './block.js';

// Serialization
export {
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeSubBlock,
  decodeSubBlock,
  encodeHeader,
  decodeHeader,
  encodeSubBlockTree,
  decodeSubBlockTree,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from './serialization.js';
