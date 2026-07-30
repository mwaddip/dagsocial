import { describe, it, expect } from 'vitest';
import {
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  computeBoxId,
} from '../src/index.js';
import type { VouchBox } from '../src/index.js';

describe('VouchBox', () => {
  it('VOUCH_KARMA_AMOUNT is 1', () => {
    expect(VOUCH_KARMA_AMOUNT).toBe(1);
  });

  it('VOUCH_MIN_BALANCE is 11', () => {
    expect(VOUCH_MIN_BALANCE).toBe(11);
  });

  it('VOUCH_COOLDOWN_BLOCKS is 60', () => {
    expect(VOUCH_COOLDOWN_BLOCKS).toBe(60);
  });

  it('computeBoxId produces deterministic id for VouchBox', () => {
    const voucherId = new Uint8Array(32).fill(1);
    const targetId = new Uint8Array(32).fill(2);
    const box: Omit<VouchBox, 'id'> = {
      boxType: 'vouch',
      value: 1,
      createdAtBlock: 100,
      voucherId,
      targetId,
      guard: 'owner_signature',
    };
    const id1 = computeBoxId(box);
    const id2 = computeBoxId(box);
    expect(id1).toBe(id2);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBe(64);
  });

  it('VouchBox different pairs produce different IDs', () => {
    const voucherId = new Uint8Array(32).fill(1);
    const target1 = new Uint8Array(32).fill(2);
    const target2 = new Uint8Array(32).fill(3);
    const id1 = computeBoxId({
      boxType: 'vouch', value: 1, createdAtBlock: 100,
      voucherId, targetId: target1, guard: 'owner_signature',
    });
    const id2 = computeBoxId({
      boxType: 'vouch', value: 1, createdAtBlock: 100,
      voucherId, targetId: target2, guard: 'owner_signature',
    });
    expect(id1).not.toBe(id2);
  });
});
