import { describe, it, expect } from 'vitest';
import {
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  computeBoxId,
} from '../src/index.js';
import type { VouchBox } from '../src/index.js';

// Provenance is REQUIRED on every box (Spec G phase G3a): `computeBoxId`
// derives the id from `txId ‖ index`, so a box without it is not a box.
// These fixtures predate G3a, and an unchecked test tree let them stand.
const FIXTURE_TX_ID = 'd'.repeat(64);

describe('VouchBox', () => {
  it('VOUCH_KARMA_AMOUNT is 1n', () => {
    expect(VOUCH_KARMA_AMOUNT).toBe(1n);
  });

  it('VOUCH_MIN_BALANCE is 11n', () => {
    expect(VOUCH_MIN_BALANCE).toBe(11n);
  });

  it('VOUCH_COOLDOWN_BLOCKS is 60', () => {
    expect(VOUCH_COOLDOWN_BLOCKS).toBe(60);
  });

  it('computeBoxId produces deterministic id for VouchBox', () => {
    const voucherId = new Uint8Array(32).fill(1);
    const targetId = new Uint8Array(32).fill(2);
    const box: Omit<VouchBox, 'id'> = {
      boxType: 'vouch',
      value: 1n,
      voucherId,
      targetId,
      guard: 'owner_signature',
      txId: FIXTURE_TX_ID,
      index: 0,
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
    // Identical provenance on both, deliberately: the claim is that the
    // voucher/target PAIR moves the id. Differing txId or index would make the
    // test pass for the wrong reason.
    // Typed as `Omit<VouchBox, 'id'>` rather than passed as bare literals:
    // `computeBoxId` takes the BASE `Omit<BoxBase, 'id'>`, so excess-property
    // checking rejects per-type fields (`voucherId`) written straight into a
    // call-site literal. Naming the real type is the accurate fix.
    const boxA: Omit<VouchBox, 'id'> = {
      boxType: 'vouch', value: 1n,
      voucherId, targetId: target1, guard: 'owner_signature',
      txId: FIXTURE_TX_ID, index: 0,
    };
    const boxB: Omit<VouchBox, 'id'> = {
      boxType: 'vouch', value: 1n,
      voucherId, targetId: target2, guard: 'owner_signature',
      txId: FIXTURE_TX_ID, index: 0,
    };
    const id1 = computeBoxId(boxA);
    const id2 = computeBoxId(boxB);
    expect(id1).not.toBe(id2);
  });
});
