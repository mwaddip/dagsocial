// Protocol
export const PROTOCOL_VERSION = 1;

// Content limits
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;

// PoW
export const POST_POW_TARGET_BITS = 20;
export const CHALLENGE_WINDOW_BLOCKS = 10;

// Karma decay (periodic burn model)
export const KARMA_POSTING_MINIMUM = 1;
export const KARMA_STALE_THRESHOLD_BLOCKS = 20160; // 28 days at 2m blocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 720;    // 24 hours at 2m blocks
export const KARMA_DECAY_AMOUNT = 5;               // karma burned per interval
export const KARMA_MINIMUM = 10;                   // floor — decay never reduces below this

// Post lock
export const POST_LOCK_THREAD_COST = 5;   // Karma locked for new threads
export const POST_LOCK_REPLY_COST = 3;    // Karma locked for replies
export const POST_LOCK_UNLOCK_PER_LIKES = 10;  // Every N likes unlocks 1 karma

// Likes
export const LIKE_COST = 2;
export const LIKE_THRESHOLD = 5;
export const LIKE_MAX_AUTHOR_REWARD = 10;
export const LIKE_FREE_THRESHOLD = 10;  // 10x LIKE_THRESHOLD; beyond this, likes are free

// Vouch
export const VOUCH_KARMA_AMOUNT = 1;          // Karma locked per vouch
export const VOUCH_MIN_BALANCE = 11;           // Must have >= this to vouch
export const VOUCH_COOLDOWN_BLOCKS = 60;       // Blocks before karma returned

// Epoch
export const EPOCH_BLOCKS = 60;  // Like processing every N ordering blocks

// Invites
export const MAX_PENDING_INVITES = 5;
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
export const INVITE_KARMA_AMOUNT = 25;        // Karma transferred in InviteBox
export const INVITE_BOND_KARMA = 25;           // was 10
export const INVITE_PROBATION_BLOCKS = 1000;
export const INVITE_KARMA_THRESHOLD = 20;

// Genesis
export const GENESIS_COMMITTEE_KEYS: string[] = [];
export const GENESIS_KARMA_PER_MEMBER = 1000;
export const GENESIS_CREDITS_PER_MEMBER = 10000;
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;  // Blocks before committee dissolution

// Credit emission (Ergo-style linear decay)
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;    // ~2 years at 60s blocks
export const CREDIT_INITIAL_REWARD = 100;              // Credits per block in fixed-rate period
export const CREDIT_EPOCH_BLOCKS = 129_600;            // ~90 days — reward reduction interval
export const CREDIT_REWARD_REDUCTION = 2;              // Credits reduced per epoch
export const CREDIT_TAIL_REWARD = 2;                   // Flat reward after emission ends
export const CREDIT_MINER_REWARD_DELAY = 720;          // Blocks before coinbase is spendable (~12h)
export const MEMPOOL_EXPIRY_BLOCKS = 720;               // Blocks before mempool entries expire (~12h)
export const CREDIT_TREASURY_PCT = 10;                 // Percent of each reward to treasury

// Ordering block PoW
export const ORDERING_BLOCK_POW_TARGET_BITS = 12;       // Initial difficulty (12 bits = ~4K hashes)
export const ORDERING_BLOCK_POW_TARGET_FLOOR = 4;       // Sanity floor

// Crypto
/** DER-encoded SPKI prefix for raw Ed25519 32-byte public keys (RFC 8410). */
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
