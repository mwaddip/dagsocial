import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';

import {
  initDb,
  closeDb,
  insertVouchCooldown,
  getVouchCooldowns,
  getMaturedVouchCooldowns,
  deleteVouchCooldown,
  hasActiveVouchCooldown,
  getKarmaBox,
} from '../../src/store/index.js';
import { mintKarma } from '../../src/services/karma.js';
import { vouchSettleContext } from '../../src/mint-provenance.js';
import { rawPublicKey } from '../helpers.js';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vouch cooldowns', () => {
  let voucherId: Uint8Array;
  let targetId: Uint8Array;
  let otherTargetId: Uint8Array;

  beforeEach(() => {
    initDb(':memory:');

    // Generate deterministic identities for predictable test assertions
    const voucherKeys = generateKeyPairSync('ed25519');
    voucherId = rawPublicKey(voucherKeys.publicKey);

    const targetKeys = generateKeyPairSync('ed25519');
    targetId = rawPublicKey(targetKeys.publicKey);

    const otherKeys = generateKeyPairSync('ed25519');
    otherTargetId = rawPublicKey(otherKeys.publicKey);
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // Insert + get roundtrip
  // -----------------------------------------------------------------------

  it('insertVouchCooldown + getVouchCooldowns roundtrip', () => {
    const releaseAtBlock = 100;
    insertVouchCooldown(voucherId, targetId, releaseAtBlock, VOUCH_KARMA_AMOUNT);

    const cooldowns = getVouchCooldowns(voucherId);
    expect(cooldowns.length).toBe(1);
    expect(cooldowns[0]!.targetId).toEqual(targetId);
    expect(cooldowns[0]!.releaseAtBlock).toBe(releaseAtBlock);
    expect(cooldowns[0]!.karmaAmount).toBe(VOUCH_KARMA_AMOUNT);
  });

  it('getVouchCooldowns returns empty array for voucher with no cooldowns', () => {
    const cooldowns = getVouchCooldowns(voucherId);
    expect(cooldowns.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // hasActiveVouchCooldown
  // -----------------------------------------------------------------------

  it('hasActiveVouchCooldown returns true after insert', () => {
    insertVouchCooldown(voucherId, targetId, 200, VOUCH_KARMA_AMOUNT);

    expect(hasActiveVouchCooldown(voucherId, targetId)).toBe(true);
  });

  it('hasActiveVouchCooldown returns false for unknown pair', () => {
    expect(hasActiveVouchCooldown(voucherId, targetId)).toBe(false);
  });

  it('hasActiveVouchCooldown distinguishes targets', () => {
    insertVouchCooldown(voucherId, targetId, 200, VOUCH_KARMA_AMOUNT);

    expect(hasActiveVouchCooldown(voucherId, targetId)).toBe(true);
    expect(hasActiveVouchCooldown(voucherId, otherTargetId)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // getMaturedVouchCooldowns
  // -----------------------------------------------------------------------

  it('getMaturedVouchCooldowns returns only matured rows', () => {
    // Insert cooldown maturing at block 50
    insertVouchCooldown(voucherId, targetId, 50, VOUCH_KARMA_AMOUNT);

    // Not yet mature at block 49
    const before = getMaturedVouchCooldowns(49);
    expect(before.length).toBe(0);

    // Mature at block 50 (release_at_block <= currentHeight)
    const at = getMaturedVouchCooldowns(50);
    expect(at.length).toBe(1);
    expect(at[0]!.voucherId).toEqual(voucherId);
    expect(at[0]!.targetId).toEqual(targetId);
    expect(at[0]!.karmaAmount).toBe(VOUCH_KARMA_AMOUNT);

    // Still returned after maturity
    const after = getMaturedVouchCooldowns(100);
    expect(after.length).toBe(1);
  });

  it('getMaturedVouchCooldowns returns multiple matured rows', () => {
    insertVouchCooldown(voucherId, targetId, 30, VOUCH_KARMA_AMOUNT);
    insertVouchCooldown(voucherId, otherTargetId, 40, VOUCH_KARMA_AMOUNT);

    // At block 35: only targetId is mature
    const at35 = getMaturedVouchCooldowns(35);
    expect(at35.length).toBe(1);
    expect(at35[0]!.targetId).toEqual(targetId);

    // At block 50: both are mature
    const at50 = getMaturedVouchCooldowns(50);
    expect(at50.length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // deleteVouchCooldown
  // -----------------------------------------------------------------------

  it('deleteVouchCooldown removes the row', () => {
    insertVouchCooldown(voucherId, targetId, 100, VOUCH_KARMA_AMOUNT);
    expect(hasActiveVouchCooldown(voucherId, targetId)).toBe(true);

    deleteVouchCooldown(voucherId, targetId);
    expect(hasActiveVouchCooldown(voucherId, targetId)).toBe(false);
  });

  it('deleteVouchCooldown does not affect other cooldowns', () => {
    insertVouchCooldown(voucherId, targetId, 100, VOUCH_KARMA_AMOUNT);
    insertVouchCooldown(voucherId, otherTargetId, 200, VOUCH_KARMA_AMOUNT);

    deleteVouchCooldown(voucherId, targetId);

    expect(hasActiveVouchCooldown(voucherId, targetId)).toBe(false);
    expect(hasActiveVouchCooldown(voucherId, otherTargetId)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // End-to-end: cooldown insert → mature → mint karma → verify → delete
  // -----------------------------------------------------------------------

  it('end-to-end cooldown processing mints karma and deletes cooldown', () => {
    const currentHeight = 100;

    // 1. Insert a cooldown that matures at current height
    insertVouchCooldown(voucherId, targetId, currentHeight, VOUCH_KARMA_AMOUNT);

    // 2. Get matured cooldowns
    const matured = getMaturedVouchCooldowns(currentHeight);
    expect(matured.length).toBe(1);
    expect(matured[0]!.voucherId).toEqual(voucherId);
    expect(matured[0]!.karmaAmount).toBe(VOUCH_KARMA_AMOUNT);

    // 3. Process each matured cooldown: mint karma back to voucher
    for (const cooldown of matured) {
      mintKarma(cooldown.voucherId, cooldown.karmaAmount, currentHeight, vouchSettleContext(cooldown.voucherId, cooldown.targetId));
      deleteVouchCooldown(cooldown.voucherId, cooldown.targetId);
    }

    // 4. Verify karma was returned to the voucher
    const karmaBox = getKarmaBox(voucherId);
    expect(karmaBox).not.toBeNull();
    expect(karmaBox!.value).toBe(VOUCH_KARMA_AMOUNT);

    // 5. Verify cooldown was deleted
    expect(hasActiveVouchCooldown(voucherId, targetId)).toBe(false);
    expect(getVouchCooldowns(voucherId).length).toBe(0);
  });

  it('end-to-end: mintKarma accumulates with existing karma', () => {
    const currentHeight = 100;

    // Preload voucher with some existing karma (not via mint, via direct insert)
    // This simulates a user who already has karma when the cooldown matures

    // Insert a cooldown
    insertVouchCooldown(voucherId, targetId, currentHeight, VOUCH_KARMA_AMOUNT);

    // Process the cooldown
    const matured = getMaturedVouchCooldowns(currentHeight);
    for (const cooldown of matured) {
      mintKarma(cooldown.voucherId, cooldown.karmaAmount, currentHeight, vouchSettleContext(cooldown.voucherId, cooldown.targetId));
      deleteVouchCooldown(cooldown.voucherId, cooldown.targetId);
    }

    // First mint gives VOUCH_KARMA_AMOUNT karma
    let karmaBox = getKarmaBox(voucherId);
    expect(karmaBox!.value).toBe(VOUCH_KARMA_AMOUNT);

    // Insert a second cooldown and process it
    insertVouchCooldown(voucherId, otherTargetId, currentHeight + 10, VOUCH_KARMA_AMOUNT);
    const matured2 = getMaturedVouchCooldowns(currentHeight + 10);
    for (const cooldown of matured2) {
      mintKarma(cooldown.voucherId, cooldown.karmaAmount, currentHeight + 10, vouchSettleContext(cooldown.voucherId, cooldown.targetId));
      deleteVouchCooldown(cooldown.voucherId, cooldown.targetId);
    }

    // Karma should accumulate
    karmaBox = getKarmaBox(voucherId);
    expect(karmaBox!.value).toBe(VOUCH_KARMA_AMOUNT * 2n);
  });
});
