// Network profiles — TYPES_INTERFACE §Network profiles, ARCHITECTURE §Network Identity.
//
// A network is the pairing of a parameter profile with a genesis block, selected by the
// single `NETWORK_TYPE` setting (class `network-identity`). Two operators who differ on it
// are on different networks; two who agree cannot differ on anything below it.
//
// The per-network set covers timescale, difficulty and genesis ONLY. Every other constant
// — format limits and every karma/credit cost — is universal: compress time, never
// economics. Adding a field here weakens every test that runs on devnet; the burden is on
// the addition.
//
// P2-A phase 1: this table is purely additive — nothing consumes it yet. The node still
// reads per-process environment values until later phases re-point it.

import {
  ORDERING_BLOCK_POW_TARGET_BITS,
  POST_POW_TARGET_BITS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_STALE_THRESHOLD_BLOCKS,
  VOUCH_COOLDOWN_BLOCKS,
  INVITE_PROBATION_BLOCKS,
  CREDIT_MINER_REWARD_DELAY,
  BOOTSTRAP_PERIOD_BLOCKS,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_EPOCH_BLOCKS,
  GENESIS_KARMA_PER_MEMBER,
  GENESIS_CREDITS_PER_MEMBER,
} from './constants.js';

export type NetworkType = 'mainnet' | 'testnet' | 'devnet';

export interface NetworkProfile {
  readonly networkType: NetworkType;
  readonly magic: number;              // wire frame magic — one per network

  // Difficulty
  readonly orderingBlockPowTargetBits: number;
  readonly postPowTargetBits: number;

  // Block-denominated durations
  readonly karmaDecayIntervalBlocks: number;
  readonly karmaStaleThresholdBlocks: number;
  readonly vouchCooldownBlocks: number;
  readonly inviteProbationBlocks: number;
  readonly creditMinerRewardDelay: number;
  readonly bootstrapPeriodBlocks: number;

  // Emission schedule
  readonly creditFixedRateBlocks: number;
  readonly creditEpochBlocks: number;

  // Genesis
  readonly genesisCommitteeKeys: readonly string[];
  readonly genesisKarmaPerMember: bigint;
  readonly genesisCreditsPerMember: bigint;
  readonly treasuryPubKey: string;
}

// The network magics live here, not in @dagsocial/wire: wire has zero runtime dependencies
// and keeps them, so types cannot import from wire and wire must not import from types.
// Until P2-A phase 5 deletes wire's copies, MAGIC_MAINNET and MAGIC_TESTNET are deliberate
// duplicates of packages/wire/src/frame.ts and MUST stay byte-identical to them.
export const MAGIC_MAINNET = 0x4d444147; // "MDAG"
export const MAGIC_TESTNET = 0x54444147; // "TDAG"
export const MAGIC_DEVNET = 0x44444147; // "DDAG"

/** The canonical set. `net` must derive its frame-magic check from this, never a local literal. */
export const KNOWN_FRAME_MAGICS: readonly number[] = Object.freeze([
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
]);

// ⚠ PROVISIONAL VALUES — every number below is a placeholder pending the constants-pinning
// session (TYPES_INTERFACE §Network profiles: "Do not read any number in this contract as
// decided"). Genesis committee keys and treasury keys are empty placeholders on all three
// networks until real chains launch.

// mainnet: today's constants (constants.ts is the single source while both surfaces exist).
const MAINNET_PROFILE: NetworkProfile = Object.freeze({
  networkType: 'mainnet',
  magic: MAGIC_MAINNET,

  orderingBlockPowTargetBits: ORDERING_BLOCK_POW_TARGET_BITS,
  postPowTargetBits: POST_POW_TARGET_BITS,

  karmaDecayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  karmaStaleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  vouchCooldownBlocks: VOUCH_COOLDOWN_BLOCKS,
  inviteProbationBlocks: INVITE_PROBATION_BLOCKS,
  creditMinerRewardDelay: CREDIT_MINER_REWARD_DELAY,
  bootstrapPeriodBlocks: BOOTSTRAP_PERIOD_BLOCKS,

  creditFixedRateBlocks: CREDIT_FIXED_RATE_BLOCKS,
  creditEpochBlocks: CREDIT_EPOCH_BLOCKS,

  genesisCommitteeKeys: Object.freeze([] as string[]),
  genesisKarmaPerMember: GENESIS_KARMA_PER_MEMBER,
  genesisCreditsPerMember: GENESIS_CREDITS_PER_MEMBER,
  treasuryPubKey: '',
} satisfies NetworkProfile);

// testnet: identical to mainnet except network identity, genesis and treasury — deliberate
// (a testnet that differs from mainnet cannot catch a mainnet bug; the burden is on the
// difference). The spread makes identity structural: a mainnet parameter change cannot
// silently leave testnet behind.
const TESTNET_PROFILE: NetworkProfile = Object.freeze({
  ...MAINNET_PROFILE,
  networkType: 'testnet',
  magic: MAGIC_TESTNET,

  genesisCommitteeKeys: Object.freeze([] as string[]),
  treasuryPubKey: '',
} satisfies NetworkProfile);

// devnet: compressed timescale, same economics. The four values marked (harness) are the
// ones the parked e2e harness ran on (packages/node/test/harness/node-manager.ts) — except
// postPowTargetBits, which the harness could not override without desynchronising the
// challenge endpoint from the verifier (the exact defect the profile removes) and which is
// set to the value it wanted. The remaining durations are compressed roughly two orders of
// magnitude, preserving mainnet's orderings (probation < bootstrap < stale threshold,
// epoch < fixed-rate period).
const DEVNET_PROFILE: NetworkProfile = Object.freeze({
  networkType: 'devnet',
  magic: MAGIC_DEVNET,

  orderingBlockPowTargetBits: 4, // (harness)
  postPowTargetBits: 4, // (harness intent — see above)

  karmaDecayIntervalBlocks: 3, // (harness)
  karmaStaleThresholdBlocks: 500, // (harness)
  vouchCooldownBlocks: 3, // shortest wait that still spans block boundaries
  inviteProbationBlocks: 10, // 1000 ÷ 100
  creditMinerRewardDelay: 10, // 720 ÷ 72 — small enough to spend, large enough to observe immaturity
  bootstrapPeriodBlocks: 100, // 10000 ÷ 100

  creditFixedRateBlocks: 1000, // ~÷1000 so the fixed-rate → decay transition is reachable
  creditEpochBlocks: 100, // keeps fixed-rate ≈ 10 × epoch (mainnet: ≈ 8×)

  genesisCommitteeKeys: Object.freeze([] as string[]),
  genesisKarmaPerMember: GENESIS_KARMA_PER_MEMBER,
  genesisCreditsPerMember: GENESIS_CREDITS_PER_MEMBER,
  treasuryPubKey: '',
} satisfies NetworkProfile);

export const NETWORK_PROFILES: Readonly<Record<NetworkType, NetworkProfile>> = Object.freeze({
  mainnet: MAINNET_PROFILE,
  testnet: TESTNET_PROFILE,
  devnet: DEVNET_PROFILE,
});

/**
 * Resolve a network profile. Throws on an unknown network — an unrecognised value is a
 * misconfigured node, not a mainnet one. Never falls back (see NET_INTERFACE §Magic Bytes
 * for the `?? MAGIC_MAINNET` defect this replaces).
 */
export function profileFor(network: NetworkType): NetworkProfile {
  if (!Object.hasOwn(NETWORK_PROFILES, network)) {
    throw new Error(
      `Unknown network type ${JSON.stringify(network)} — expected 'mainnet' | 'testnet' | 'devnet'`,
    );
  }
  return NETWORK_PROFILES[network];
}
