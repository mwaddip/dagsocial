import { describe, it, expect } from 'vitest';
import { serializeBox, deserializeBox, deserializeBoxWithId } from '../../src/state/serialize-box.js';

/**
 * Helper: strip `id` from a box for comparison against deserializeBox output.
 */
function withoutId(box: Record<string, unknown>) {
  const { id: _id, ...rest } = box;
  return rest;
}

describe('serializeBox', () => {
  it('roundtrips a KarmaBox', () => {
    const box = {
      id: 'ab'.repeat(32),
      boxType: 'karma' as const,
      value: 100n,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
      proofSource: 'mint-1',
    };
    const serialized = serializeBox(box);
    const deserialized = deserializeBoxWithId(box.id, serialized);
    expect(deserialized).toEqual(box);
  });

  it('roundtrips a CreditBox', () => {
    const box = {
      id: 'cd'.repeat(32),
      boxType: 'credit' as const,
      value: 50n,
      owner: new Uint8Array(32).fill(0xbb),
      guard: 'owner_signature' as const,
      proofSource: 10,
      lockedUntilBlock: 20,
    };
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips a LikeBox', () => {
    const box = {
      id: 'ef'.repeat(32),
      boxType: 'like' as const,
      value: 2n,
      likerId: new Uint8Array(32).fill(0x11),
      targetPostId: 'post-1',
      guard: 'epoch_tally' as const,
    };
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips an InviteBox', () => {
    const box = {
      id: 'gh'.repeat(32),
      boxType: 'invite' as const,
      value: 10n,
      secretHash: new Uint8Array(32).fill(0x22),
      inviterId: new Uint8Array(32).fill(0x33),
      guard: 'hash_preimage_with_bond' as const,
    };
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips a BondBox', () => {
    const box = {
      id: 'ij'.repeat(32),
      boxType: 'bond' as const,
      value: 5n,
      inviterId: new Uint8Array(32).fill(0x33),
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(32),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips a PostLockBox', () => {
    const box = {
      id: 'kl'.repeat(32),
      boxType: 'post_lock' as const,
      value: 5n,
      originalValue: 5n,
      owner: new Uint8Array(32).fill(0x44),
      targetPostId: 'post-2',
      guard: 'block_apply' as const,
    };
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('is deterministic — same input produces identical bytes', () => {
    const box = {
      id: 'mn'.repeat(32),
      boxType: 'karma' as const,
      value: 42n,
      owner: new Uint8Array(32).fill(0x55),
      guard: 'owner_signature' as const,
      proofSource: 'mint-0',
    };
    const a = serializeBox(box);
    const b = serializeBox({ ...box });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('deserializeBox returns fields without id', () => {
    const box = {
      id: 'op'.repeat(32),
      boxType: 'karma' as const,
      value: 1n,
      owner: new Uint8Array(32),
      guard: 'owner_signature' as const,
      proofSource: '',
    };
    const fields = deserializeBox(serializeBox(box));
    expect(fields).not.toHaveProperty('id');
    expect(fields).toEqual(withoutId(box));
  });

  it('deserializeBox throws on truncated bytes', () => {
    const box = {
      id: 'qr'.repeat(32),
      boxType: 'karma' as const,
      value: 1n,
      owner: new Uint8Array(32),
      guard: 'owner_signature' as const,
      proofSource: '',
    };
    const bytes = serializeBox(box);
    expect(() => deserializeBox(bytes.slice(0, 3))).toThrow();
  });

  it('deserializeBox throws on unknown box type byte', () => {
    expect(() => deserializeBox(new Uint8Array([0xff, ...new Array(100).fill(0)]))).toThrow();
  });
});
