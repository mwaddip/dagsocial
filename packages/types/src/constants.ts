// Protocol
export const PROTOCOL_VERSION = 1;

// Content limits
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;

// PoW
export const POST_POW_TARGET_BITS = 20;
export const CHALLENGE_WINDOW_BLOCKS = 10;

// Karma
export const KARMA_POSTING_MINIMUM = 1;
export const KARMA_DECAY_RATE = 0.0001;
export const KARMA_DECAY_GRACE_BLOCKS = 100;
export const KARMA_FLOOR = 0;

// Likes
export const LIKE_COST = 2;
export const LIKE_THRESHOLD = 5;
export const LIKE_MAX_AUTHOR_REWARD = 10;
export const LIKE_FREE_THRESHOLD = 10;  // 10x LIKE_THRESHOLD; beyond this, likes are free

// Epoch
export const EPOCH_BLOCKS = 60;  // Like processing every N ordering blocks

// Invites
export const MAX_PENDING_INVITES = 5;
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
export const INVITE_BOND_KARMA = 10;
export const INVITE_PROBATION_BLOCKS = 1000;
export const INVITE_KARMA_THRESHOLD = 20;

// Genesis
export const GENESIS_COMMITTEE_KEYS: string[] = [];
export const GENESIS_KARMA_PER_MEMBER = 1000;
export const GENESIS_CREDITS_PER_MEMBER = 10000;
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;  // Blocks before committee dissolution

// Validators
export const ORDERING_BLOCK_REWARD_CREDITS = 100;
