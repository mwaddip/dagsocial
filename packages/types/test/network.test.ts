import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  NETWORK_PROFILES,
  profileFor,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
} from '../src/index.js';
import type { NetworkType, NetworkProfile } from '../src/index.js';

// The full contract field set — TYPES_INTERFACE §Network profiles. Guards both
// directions: a missing field and an added one (per-network creep is how a devnet
// test stops catching a mainnet bug).
const PROFILE_FIELDS = [
  'networkType',
  'magic',
  'orderingBlockPowTargetBits',
  'postPowTargetBits',
  'karmaDecayIntervalBlocks',
  'karmaStaleThresholdBlocks',
  'vouchCooldownBlocks',
  'inviteProbationBlocks',
  'creditMinerRewardDelay',
  'bootstrapPeriodBlocks',
  'creditFixedRateBlocks',
  'creditEpochBlocks',
  'genesisCommitteeKeys',
  'genesisKarmaPerMember',
  'genesisCreditsPerMember',
  'treasuryPubKey',
].sort();

function asciiOfMagic(magic: number): string {
  return String.fromCharCode(
    (magic >>> 24) & 0xff,
    (magic >>> 16) & 0xff,
    (magic >>> 8) & 0xff,
    magic & 0xff,
  );
}

describe('network magics', () => {
  it('spell MDAG / TDAG / DDAG', () => {
    expect(asciiOfMagic(MAGIC_MAINNET)).toBe('MDAG');
    expect(asciiOfMagic(MAGIC_TESTNET)).toBe('TDAG');
    expect(asciiOfMagic(MAGIC_DEVNET)).toBe('DDAG');
  });

  it('are pairwise distinct', () => {
    expect(new Set([MAGIC_MAINNET, MAGIC_TESTNET, MAGIC_DEVNET]).size).toBe(3);
  });

  it('KNOWN_FRAME_MAGICS is exactly the three magics, frozen', () => {
    expect(KNOWN_FRAME_MAGICS).toEqual([MAGIC_MAINNET, MAGIC_TESTNET, MAGIC_DEVNET]);
    expect(Object.isFrozen(KNOWN_FRAME_MAGICS)).toBe(true);
  });

  it('mainnet and testnet magics are byte-identical to the wire copies (until P2-A phase 5)', () => {
    // Deliberate duplication: wire keeps its copies until phase 5 deletes them. This
    // test pins the two literals to each other across packages; phase 5 removes it
    // together with wire's constants.
    const wireSrc = readFileSync(
      new URL('../../wire/src/frame.ts', import.meta.url),
      'utf8',
    );
    const wireMagic = (name: string): number => {
      const m = wireSrc.match(new RegExp(`export const ${name} = (0x[0-9a-fA-F]{8});`));
      if (!m) throw new Error(`${name} not found in wire/src/frame.ts — phase 5 landed? Remove this test with wire's copies.`);
      return Number(m[1]);
    };
    expect(MAGIC_MAINNET).toBe(wireMagic('MAGIC_MAINNET'));
    expect(MAGIC_TESTNET).toBe(wireMagic('MAGIC_TESTNET'));
  });
});

describe('NETWORK_PROFILES', () => {
  it('has exactly the three networks', () => {
    expect(Object.keys(NETWORK_PROFILES).sort()).toEqual(['devnet', 'mainnet', 'testnet']);
  });

  it('each profile carries its own key as networkType and its own magic', () => {
    expect(NETWORK_PROFILES.mainnet.networkType).toBe('mainnet');
    expect(NETWORK_PROFILES.mainnet.magic).toBe(MAGIC_MAINNET);
    expect(NETWORK_PROFILES.testnet.networkType).toBe('testnet');
    expect(NETWORK_PROFILES.testnet.magic).toBe(MAGIC_TESTNET);
    expect(NETWORK_PROFILES.devnet.networkType).toBe('devnet');
    expect(NETWORK_PROFILES.devnet.magic).toBe(MAGIC_DEVNET);
  });

  it('profiles carry exactly the contract field set — nothing added, nothing missing', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.keys(profile).sort()).toEqual(PROFILE_FIELDS);
    }
  });

  it('table and profiles are frozen', () => {
    expect(Object.isFrozen(NETWORK_PROFILES)).toBe(true);
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.genesisCommitteeKeys)).toBe(true);
    }
  });

  it('mainnet carries the corrected karma constants (60s-block units)', () => {
    expect(KARMA_STALE_THRESHOLD_BLOCKS).toBe(40320); // 28 days at 60s blocks
    expect(KARMA_DECAY_INTERVAL_BLOCKS).toBe(1440); // 24 hours at 60s blocks
    expect(NETWORK_PROFILES.mainnet.karmaStaleThresholdBlocks).toBe(40320);
    expect(NETWORK_PROFILES.mainnet.karmaDecayIntervalBlocks).toBe(1440);
  });

  it('testnet is identical to mainnet except identity, genesis and treasury', () => {
    const identityOrGenesis = new Set([
      'networkType',
      'magic',
      'genesisCommitteeKeys',
      'treasuryPubKey',
    ]);
    const { mainnet, testnet } = NETWORK_PROFILES;
    for (const field of PROFILE_FIELDS) {
      if (identityOrGenesis.has(field)) continue;
      expect(testnet[field as keyof NetworkProfile], field).toBe(
        mainnet[field as keyof NetworkProfile],
      );
    }
  });

  it('devnet runs the parked e2e harness values', () => {
    const devnet = NETWORK_PROFILES.devnet;
    expect(devnet.karmaDecayIntervalBlocks).toBe(3);
    expect(devnet.karmaStaleThresholdBlocks).toBe(500);
    expect(devnet.orderingBlockPowTargetBits).toBe(4);
    expect(devnet.postPowTargetBits).toBe(4);
  });

  it('devnet compresses the remaining durations, preserving mainnet orderings', () => {
    const devnet = NETWORK_PROFILES.devnet;
    expect(devnet.vouchCooldownBlocks).toBe(3);
    expect(devnet.inviteProbationBlocks).toBe(10);
    expect(devnet.creditMinerRewardDelay).toBe(10);
    expect(devnet.bootstrapPeriodBlocks).toBe(100);
    expect(devnet.creditFixedRateBlocks).toBe(1000);
    expect(devnet.creditEpochBlocks).toBe(100);
    // Orderings mainnet also satisfies: probation < bootstrap < stale, epoch < fixed-rate
    expect(devnet.inviteProbationBlocks).toBeLessThan(devnet.bootstrapPeriodBlocks);
    expect(devnet.bootstrapPeriodBlocks).toBeLessThan(devnet.karmaStaleThresholdBlocks);
    expect(devnet.creditEpochBlocks).toBeLessThan(devnet.creditFixedRateBlocks);
  });

  it('devnet keeps mainnet economics — genesis allocations are not compressed', () => {
    const { mainnet, devnet } = NETWORK_PROFILES;
    expect(devnet.genesisKarmaPerMember).toBe(mainnet.genesisKarmaPerMember);
    expect(devnet.genesisCreditsPerMember).toBe(mainnet.genesisCreditsPerMember);
  });
});

describe('profileFor', () => {
  it('resolves each known network to its profile', () => {
    expect(profileFor('mainnet')).toBe(NETWORK_PROFILES.mainnet);
    expect(profileFor('testnet')).toBe(NETWORK_PROFILES.testnet);
    expect(profileFor('devnet')).toBe(NETWORK_PROFILES.devnet);
  });

  it('throws on an unknown network — never falls back to mainnet', () => {
    for (const bad of ['regtest', '', 'MAINNET', 'Mainnet', 'main', 'localnet']) {
      expect(() => profileFor(bad as NetworkType), bad).toThrow(/[Uu]nknown network/);
    }
  });

  it('throws on prototype-chain keys', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() => profileFor(bad as NetworkType), bad).toThrow(/[Uu]nknown network/);
    }
  });
});
