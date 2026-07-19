import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { createSlotChallenge, claimSlot } from '../../src/services/slots.js';
import { solvePoW } from '../../src/services/pow.js';
import { config } from '../../src/config.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-slots-unit.sqlite';

describe('slot service', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM slots');
  });

  it('createSlotChallenge returns unique challenges', () => {
    expect(createSlotChallenge('user-1')).not.toBe(createSlotChallenge('user-1'));
  });

  it('claimSlot with valid PoW returns a token', () => {
    const challenge = createSlotChallenge('user-1');
    const nonce = solvePoW(challenge, config.pow.slotTargetBits);
    const token = claimSlot('user-1', challenge, nonce);
    expect(token).not.toBeNull();
    expect(token!.userId).toBe('user-1');
    expect(token!.hash).toBeTruthy();
  });

  it('claimSlot with invalid PoW returns null', () => {
    const challenge = createSlotChallenge('user-1');
    const validNonce = solvePoW(challenge, config.pow.slotTargetBits);
    // validNonce+1 should produce a different hash that almost certainly fails
    expect(claimSlot('user-1', challenge, validNonce + 1)).toBeNull();
  });

  it('claimSlot rejects already-claimed challenge', () => {
    const challenge = createSlotChallenge('user-1');
    const nonce = solvePoW(challenge, config.pow.slotTargetBits);
    expect(claimSlot('user-1', challenge, nonce)).not.toBeNull();
    expect(claimSlot('user-1', challenge, nonce)).toBeNull();
  });
});
