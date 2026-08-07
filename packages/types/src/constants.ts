// Denomination (P0 — Spec B): amount constants are bigint; count/block/threshold/
// percentage/bits constants stay number. Credit amounts are integer base units of
// 10^-8 credit (rescaled ×10^8); karma amounts are indivisible bigint literals.
//
// P2-A: constants marked "→ profile: <field>" are per-network and now live on
// NetworkProfile (network.ts) as well. They stay exported from here until later
// P2-A phases re-point every consumer; deleting them now would break consumers.

// Protocol
export const PROTOCOL_VERSION = 1;

// Content limits
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;

// State format
export const AVL_KEY_LENGTH = 32; // bytes — AVL+ key width; sets the shape of every stateRoot

// PoW
export const POST_POW_TARGET_BITS = 20; // → profile: postPowTargetBits
export const CHALLENGE_WINDOW_BLOCKS = 10;

// Karma decay (periodic burn model)
export const KARMA_POSTING_MINIMUM = 1n;
export const KARMA_STALE_THRESHOLD_BLOCKS = 40320; // 28 days at 60s blocks (duration itself under review — constants-pinning) → profile: karmaStaleThresholdBlocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 1440;   // 24 hours at 60s blocks → profile: karmaDecayIntervalBlocks
export const KARMA_DECAY_AMOUNT = 5n;              // karma burned per interval
export const KARMA_MINIMUM = 10n;                  // floor — decay never reduces below this

// Post lock
export const POST_LOCK_THREAD_COST = 5n;  // Karma locked for new threads
export const POST_LOCK_REPLY_COST = 3n;   // Karma locked for replies
export const POST_LOCK_UNLOCK_PER_LIKES = 10;  // Every N likes unlocks 1 karma

// Likes
export const LIKE_COST = 2n;
export const LIKE_THRESHOLD = 5;
export const LIKE_MAX_AUTHOR_REWARD = 10n;
export const LIKE_FREE_THRESHOLD = 10;  // 10x LIKE_THRESHOLD; beyond this, likes are free
// P2-D likes — one-way burns settled per block. The four constants above are the
// retired two-phase system, kept only until consumers stop compiling against them.
export const LIKE_KARMA_COST = 1n;        // Karma burned by the liker per like (bigint)
export const LIKES_PER_KARMA_PAYOUT = 5;  // x: per x likes an author accrues x−1; 1 is burned

// Vouch
export const VOUCH_KARMA_AMOUNT = 1n;         // Karma locked per vouch
export const VOUCH_MIN_BALANCE = 11n;          // Must have >= this to vouch
export const VOUCH_COOLDOWN_BLOCKS = 60;       // Blocks before karma returned → profile: vouchCooldownBlocks

// Epoch
export const EPOCH_BLOCKS = 60;  // Like processing every N ordering blocks

// Invites
export const MAX_PENDING_INVITES = 5;
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
export const INVITE_KARMA_AMOUNT = 25n;       // Karma transferred in InviteBox
export const INVITE_BOND_KARMA = 25n;          // was 10
export const INVITE_PROBATION_BLOCKS = 1000;   // → profile: inviteProbationBlocks
export const INVITE_KARMA_THRESHOLD = 20n;

// Genesis
export const GENESIS_COMMITTEE_KEYS: string[] = []; // → profile: genesisCommitteeKeys
export const GENESIS_KARMA_PER_MEMBER = 1000n; // → profile: genesisKarmaPerMember
export const GENESIS_CREDITS_PER_MEMBER = 10000n * 10n ** 8n;  // 10000 credits in base units → profile: genesisCreditsPerMember
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;  // Blocks before committee dissolution → profile: bootstrapPeriodBlocks

// Credit emission (Ergo-style linear decay) — amounts in base units of 10^-8 credit
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;    // ~2 years at 60s blocks → profile: creditFixedRateBlocks
export const CREDIT_INITIAL_REWARD = 100n * 10n ** 8n; // 100 credits per block in fixed-rate period
export const CREDIT_EPOCH_BLOCKS = 129_600;            // ~90 days — reward reduction interval → profile: creditEpochBlocks
export const CREDIT_REWARD_REDUCTION = 2n * 10n ** 8n; // 2 credits reduced per epoch
export const CREDIT_TAIL_REWARD = 2n * 10n ** 8n;      // 2 credits flat reward after emission ends
export const CREDIT_MINER_REWARD_DELAY = 720;          // Blocks before coinbase is spendable (~12h) → profile: creditMinerRewardDelay
export const MEMPOOL_EXPIRY_BLOCKS = 720;               // Blocks before mempool entries expire (~12h)
export const CREDIT_TREASURY_PCT = 10;                 // Percent of each reward to treasury

// Ordering block PoW
export const ORDERING_BLOCK_POW_TARGET_BITS = 12;       // Initial difficulty (12 bits = ~4K hashes) → profile: orderingBlockPowTargetBits
export const ORDERING_BLOCK_POW_TARGET_FLOOR = 4;       // Sanity floor

// Crypto
/** DER-encoded SPKI prefix for raw Ed25519 32-byte public keys (RFC 8410). */
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
