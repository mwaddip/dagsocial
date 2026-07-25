import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import type {
  AnyBox,
  KarmaBox,
  CreditBox,
  LikeBox,
  InviteBox,
  BondBox,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers (reset module-level state between tests)
// ---------------------------------------------------------------------------

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

async function importUtxoFresh() {
  const mod = await import('../../src/store/utxo.js');
  return mod as {
    getBox: (boxId: string) => AnyBox | null;
    getUnspentBoxes: (owner: Uint8Array) => AnyBox[];
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getCreditBox: (owner: Uint8Array) => CreditBox | null;
    getCreditBoxes: (owner: Uint8Array) => CreditBox[];
    getUnlockedCreditBoxes: (owner: Uint8Array, blockHeight: number) => CreditBox[];
    getPendingInvites: (inviterId: Uint8Array) => InviteBox[];
    getPendingInviteCount: (inviterId: Uint8Array) => number;
    getBondBoxes: (inviterId: Uint8Array) => BondBox[];
    getLockedLikeBoxes: (targetPostId: string) => LikeBox[];
    getUnprocessedLockedLikeBoxes: () => LikeBox[];
    insertBox: (box: AnyBox) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    markLikeBoxesTallied: (boxIds: string[]) => void;
  };
}

async function importTypes() {
  const mod = await import('@dagsocial/types');
  return mod as {
    computeBoxId: (box: AnyBox) => string;
  };
}

// ---------------------------------------------------------------------------
// Box factory helpers
// ---------------------------------------------------------------------------

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

const OWNER_A = bytes(32);
const OWNER_B = bytes(32);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    id: '',
    boxType: 'karma',
    value: 100,
    createdAtBlock: 1,
    owner: OWNER_A,
    guard: 'owner_signature',
    proofSource: 'tx-genesis-001',
    lastTouchBlock: 1,
    ...overrides,
  };
}

function makeCreditBox(overrides: Partial<CreditBox> = {}): CreditBox {
  return {
    id: '',
    boxType: 'credit',
    value: 1000,
    createdAtBlock: 1,
    owner: OWNER_A,
    guard: 'owner_signature',
    proofSource: 1,
    ...overrides,
  };
}

function makeLikeBox(overrides: Partial<LikeBox> = {}): LikeBox {
  return {
    id: '',
    boxType: 'like',
    value: 2,
    createdAtBlock: 5,
    likerId: uid('liker123'),
    targetPostId: 'post456',
    guard: 'epoch_tally',
    ...overrides,
  };
}

function makeInviteBox(overrides: Partial<InviteBox> = {}): InviteBox {
  return {
    id: '',
    boxType: 'invite',
    value: 50,
    createdAtBlock: 3,
    secretHash: bytes(32),
    inviterId: uid('alice-inviter'),
    guard: 'hash_preimage',
    ...overrides,
  };
}

function makeBondBox(overrides: Partial<BondBox> = {}): BondBox {
  return {
    id: '',
    boxType: 'bond',
    value: 10,
    createdAtBlock: 3,
    inviterId: uid('alice-inviter'),
    inviteePublicKey: new Uint8Array(0),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'inviter_signature',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('utxo store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // --- insertBox + getBox round-trip for all 5 box types -------------------

  it('insertBox + getBox round-trip for KarmaBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 200, proofSource: 'tx-post-abc', lastTouchBlock: 7 });
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as KarmaBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('karma');
    expect(result.value).toBe(200);
    expect(result.createdAtBlock).toBe(1);
    expect(result.owner).toEqual(OWNER_A);
    expect(result.guard).toBe('owner_signature');
    expect(result.proofSource).toBe('tx-post-abc');
    expect(result.lastTouchBlock).toBe(7);
  });

  it('insertBox + getBox round-trip preserves decayBurn on KarmaBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 100, decayBurn: true });
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as KarmaBox;
    expect(result).not.toBeNull();
    expect(result.decayBurn).toBe(true);
  });

  it('insertBox + getBox round-trip for CreditBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeCreditBox({ value: 5000, proofSource: 42 });
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as CreditBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('credit');
    expect(result.value).toBe(5000);
    expect(result.owner).toEqual(OWNER_A);
    expect(result.guard).toBe('owner_signature');
    expect(result.proofSource).toBe(42);
  });

  it('insertBox + getBox round-trip for LikeBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeLikeBox({ likerId: uid('user-liker'), targetPostId: 'post-target-1' });
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as LikeBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('like');
    expect(result.value).toBe(2);
    expect(result.likerId).toEqual(uid('user-liker'));
    expect(result.targetPostId).toBe('post-target-1');
    expect(result.guard).toBe('epoch_tally');
  });

  it('insertBox + getBox round-trip for InviteBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const secretHash = bytes(32);
    const box = makeInviteBox({ value: 30, secretHash, inviterId: uid('inviter-alice') });
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as InviteBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('invite');
    expect(result.value).toBe(30);
    expect(result.secretHash).toEqual(secretHash);
    expect(result.inviterId).toEqual(uid('inviter-alice'));
    expect(result.guard).toBe('hash_preimage');
  });

  it('insertBox + getBox round-trip for BondBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const inviteePk = bytes(32);
    const box = makeBondBox({
      value: 10,
      inviterId: uid('inviter-bob'),
      inviteePublicKey: inviteePk,
      probationStartBlock: 100,
      probationEndBlock: 1100,
    });
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as BondBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('bond');
    expect(result.value).toBe(10);
    expect(result.inviterId).toEqual(uid('inviter-bob'));
    expect(result.inviteePublicKey).toEqual(inviteePk);
    expect(result.probationStartBlock).toBe(100);
    expect(result.probationEndBlock).toBe(1100);
    expect(result.guard).toBe('inviter_signature');
  });

  // --- getBox returns null for unknown id -----------------------------------

  it('getBox returns null for unknown id', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();

    initDb(':memory:');

    const result = getBox('nonexistent-box-id');
    expect(result).toBeNull();
  });

  // --- getUnspentBoxes filters by owner, excludes spent ---------------------

  it('getUnspentBoxes filters by owner and excludes spent boxes', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnspentBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    // Insert two karma boxes for owner A
    const boxA1 = makeKarmaBox({ value: 100, owner: OWNER_A });
    boxA1.id = computeBoxId(boxA1);
    insertBox(boxA1);

    const boxA2 = makeKarmaBox({ value: 200, owner: OWNER_A });
    boxA2.id = computeBoxId(boxA2);
    insertBox(boxA2);

    // Insert a karma box for owner B
    const boxB = makeKarmaBox({ value: 300, owner: OWNER_B });
    boxB.id = computeBoxId(boxB);
    insertBox(boxB);

    // Consume boxA2
    consumeBox(boxA2.id!, 5);

    // Only boxA1 should be returned for owner A (unspent)
    const results = getUnspentBoxes(OWNER_A);
    expect(results).toHaveLength(1);
    const karma = results[0] as KarmaBox;
    expect(karma.value).toBe(100);

    // Owner B still has boxB
    const resultsB = getUnspentBoxes(OWNER_B);
    expect(resultsB).toHaveLength(1);
    expect((resultsB[0] as KarmaBox).value).toBe(300);
  });

  // --- getKarmaBox returns single unspent karma box -------------------------

  it('getKarmaBox returns the single unspent karma box for an owner', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBox, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 75, owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);

    // Should find it before consumption
    const found = getKarmaBox(OWNER_A);
    expect(found).not.toBeNull();
    expect(found!.value).toBe(75);

    // Consume it
    consumeBox(box.id!, 10);

    // Should be gone now
    const gone = getKarmaBox(OWNER_A);
    expect(gone).toBeNull();
  });

  // --- getCreditBox returns single unspent credit box -----------------------

  it('getCreditBox returns the single unspent credit box for an owner', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getCreditBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeCreditBox({ value: 999, owner: OWNER_A, proofSource: 3 });
    box.id = computeBoxId(box);
    insertBox(box);

    const found = getCreditBox(OWNER_A);
    expect(found).not.toBeNull();
    expect(found!.value).toBe(999);
    expect(found!.proofSource).toBe(3);

    // Owner without a credit box returns null
    const none = getCreditBox(OWNER_B);
    expect(none).toBeNull();
  });

  // --- getPendingInvites returns unclaimed invite boxes ---------------------

  it('getPendingInvites returns unclaimed (unspent) invite boxes for an inviter', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getPendingInvites, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const inv1 = makeInviteBox({ value: 20, inviterId: uid('alice') });
    inv1.id = computeBoxId(inv1);
    insertBox(inv1);

    const inv2 = makeInviteBox({ value: 30, inviterId: uid('alice') });
    inv2.id = computeBoxId(inv2);
    insertBox(inv2);

    const inv3 = makeInviteBox({ value: 40, inviterId: uid('bob') });
    inv3.id = computeBoxId(inv3);
    insertBox(inv3);

    // Consume inv1
    consumeBox(inv1.id!, 7);

    const aliceInvites = getPendingInvites(uid('alice'));
    expect(aliceInvites).toHaveLength(1);
    expect(aliceInvites[0].value).toBe(30);

    const bobInvites = getPendingInvites(uid('bob'));
    expect(bobInvites).toHaveLength(1);
    expect(bobInvites[0].value).toBe(40);
  });

  // --- getPendingInviteCount returns correct count --------------------------

  it('getPendingInviteCount returns the correct count', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getPendingInviteCount, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    expect(getPendingInviteCount(uid('alice'))).toBe(0);

    const inv1 = makeInviteBox({ inviterId: uid('alice') });
    inv1.id = computeBoxId(inv1);
    insertBox(inv1);

    const inv2 = makeInviteBox({ inviterId: uid('alice') });
    inv2.id = computeBoxId(inv2);
    insertBox(inv2);

    expect(getPendingInviteCount(uid('alice'))).toBe(2);

    consumeBox(inv1.id!, 5);
    expect(getPendingInviteCount(uid('alice'))).toBe(1);
  });

  // --- getBondBoxes returns active bonds ------------------------------------

  it('getBondBoxes returns bond boxes for an inviter', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBondBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const bond1 = makeBondBox({ inviterId: uid('charlie'), value: 10 });
    bond1.id = computeBoxId(bond1);
    insertBox(bond1);

    const bond2 = makeBondBox({ inviterId: uid('charlie'), value: 15 });
    bond2.id = computeBoxId(bond2);
    insertBox(bond2);

    const bond3 = makeBondBox({ inviterId: uid('dave'), value: 20 });
    bond3.id = computeBoxId(bond3);
    insertBox(bond3);

    const charlieBonds = getBondBoxes(uid('charlie'));
    expect(charlieBonds).toHaveLength(2);
    expect(charlieBonds[0].value).toBe(10);
    expect(charlieBonds[1].value).toBe(15);

    const daveBonds = getBondBoxes(uid('dave'));
    expect(daveBonds).toHaveLength(1);
    expect(daveBonds[0].value).toBe(20);

    // No bonds for unknown inviter
    const none = getBondBoxes(uid('nobody'));
    expect(none).toHaveLength(0);
  });

  // --- getLockedLikeBoxes returns likes for a target post -------------------

  it('getLockedLikeBoxes returns like boxes for a specific target post', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getLockedLikeBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const like1 = makeLikeBox({ targetPostId: 'post-aaa', likerId: uid('user1') });
    like1.id = computeBoxId(like1);
    insertBox(like1);

    const like2 = makeLikeBox({ targetPostId: 'post-aaa', likerId: uid('user2') });
    like2.id = computeBoxId(like2);
    insertBox(like2);

    const like3 = makeLikeBox({ targetPostId: 'post-bbb', likerId: uid('user3') });
    like3.id = computeBoxId(like3);
    insertBox(like3);

    const forAaa = getLockedLikeBoxes('post-aaa');
    expect(forAaa).toHaveLength(2);
    expect(forAaa.map((l) => l.likerId).sort()).toEqual([uid('user1'), uid('user2')].sort());

    const forBbb = getLockedLikeBoxes('post-bbb');
    expect(forBbb).toHaveLength(1);
    expect(forBbb[0].likerId).toEqual(uid('user3'));

    const forNone = getLockedLikeBoxes('post-zzz');
    expect(forNone).toHaveLength(0);
  });

  // --- getUnprocessedLockedLikeBoxes returns pending epoch likes ------------

  it('getUnprocessedLockedLikeBoxes returns only unspent like boxes', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnprocessedLockedLikeBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const like1 = makeLikeBox({ targetPostId: 'p1', likerId: uid('u1') });
    like1.id = computeBoxId(like1);
    insertBox(like1);

    const like2 = makeLikeBox({ targetPostId: 'p2', likerId: uid('u2') });
    like2.id = computeBoxId(like2);
    insertBox(like2);

    // Consume like2
    consumeBox(like2.id!, 12);

    const unprocessed = getUnprocessedLockedLikeBoxes();
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].likerId).toEqual(uid('u1'));
  });

  // --- consumeBox marks as spent --------------------------------------------

  it('consumeBox marks a box as spent', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertBox, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 50 });
    box.id = computeBoxId(box);
    insertBox(box);

    consumeBox(box.id!, 99);

    const row = getDb()
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(box.id!) as { spent_at_block: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.spent_at_block).toBe(99);
  });

  // --- markLikeBoxesTallied bulk-consumes -----------------------------------

  it('markLikeBoxesTallied bulk-marks like boxes as tallied', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertBox, markLikeBoxesTallied } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const like1 = makeLikeBox({ likerId: uid('u1') });
    like1.id = computeBoxId(like1);
    insertBox(like1);

    const like2 = makeLikeBox({ likerId: uid('u2') });
    like2.id = computeBoxId(like2);
    insertBox(like2);

    const like3 = makeLikeBox({ likerId: uid('u3') });
    like3.id = computeBoxId(like3);
    insertBox(like3);

    // Bulk-consume like1 and like3
    markLikeBoxesTallied([like1.id!, like3.id!]);

    // like1 and like3 should be spent
    for (const id of [like1.id!, like3.id!]) {
      const row = getDb()
        .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
        .get(id) as { spent_at_block: number } | undefined;
      expect(row!.spent_at_block).toBe(-1);
    }

    // like2 should still be unspent
    const row2 = getDb()
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(like2.id!) as { spent_at_block: number | null } | undefined;
    expect(row2!.spent_at_block).toBeNull();
  });

  // --- markLikeBoxesTallied handles empty array -----------------------------

  it('markLikeBoxesTallied handles empty array gracefully', async () => {
    const { initDb } = await importDbFresh();
    const { markLikeBoxesTallied } = await importUtxoFresh();

    initDb(':memory:');

    // Should not throw
    expect(() => markLikeBoxesTallied([])).not.toThrow();
  });

  // --- getKarmaBoxes returns all unspent karma boxes sorted by value desc -----

  it('getKarmaBoxes returns all unspent karma boxes sorted value desc', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box1 = makeKarmaBox({ value: 100, owner });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeKarmaBox({ value: 200, owner });
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const box3 = makeKarmaBox({ value: 50, owner });
    box3.id = computeBoxId(box3);
    insertBox(box3);

    // Consume box2 — it should be excluded
    consumeBox(box2.id!, 5);

    const results = getKarmaBoxes(owner);
    expect(results).toHaveLength(2);
    // Sorted value desc: 100, 50
    expect(results[0]!.value).toBe(100);
    expect(results[1]!.value).toBe(50);
  });

  it('getKarmaBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getKarmaBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getKarmaBoxes(bytes(32));
    expect(results).toEqual([]);
  });

  it('getKarmaBoxes excludes boxes owned by other users', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const alice = bytes(32).fill(0xaa);
    const bob = bytes(32).fill(0xbb);

    const aliceBox = makeKarmaBox({ value: 100, owner: alice });
    aliceBox.id = computeBoxId(aliceBox);
    insertBox(aliceBox);

    const bobBox = makeKarmaBox({ value: 200, owner: bob });
    bobBox.id = computeBoxId(bobBox);
    insertBox(bobBox);

    const results = getKarmaBoxes(alice);
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe(100);
  });

  // --- getCreditBoxes return all unspent credit boxes sorted by value desc ----

  it('getCreditBoxes returns all unspent credit boxes sorted value desc', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getCreditBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box1 = makeCreditBox({ value: 300, owner });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeCreditBox({ value: 500, owner });
    box2.id = computeBoxId(box2);
    insertBox(box2);

    // Consume box1 — it should be excluded
    consumeBox(box1.id!, 5);

    const results = getCreditBoxes(owner);
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe(500);
  });

  it('getCreditBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getCreditBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getCreditBoxes(bytes(32));
    expect(results).toEqual([]);
  });

  // --- getUnlockedCreditBoxes filters out locked boxes ------------------------

  it('getUnlockedCreditBoxes excludes locked boxes', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnlockedCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const currentHeight = 100;

    const box1 = makeCreditBox({ value: 300, owner, proofSource: 1 });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeCreditBox({ value: 500, owner, proofSource: 2 });
    box2.lockedUntilBlock = 150;
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const box3 = makeCreditBox({ value: 200, owner, proofSource: 3 });
    box3.lockedUntilBlock = 50;
    box3.id = computeBoxId(box3);
    insertBox(box3);

    const box4 = makeCreditBox({ value: 100, owner, proofSource: 4 });
    box4.id = computeBoxId(box4);
    insertBox(box4);

    const results = getUnlockedCreditBoxes(owner, currentHeight);
    expect(results).toHaveLength(3);
    expect(results[0]!.value).toBe(300);
    expect(results[1]!.value).toBe(200);
    expect(results[2]!.value).toBe(100);
  });

  it('getUnlockedCreditBoxes returns empty array when all boxes are locked', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnlockedCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box = makeCreditBox({ value: 500, owner, proofSource: 2 });
    box.lockedUntilBlock = 200;
    box.id = computeBoxId(box);
    insertBox(box);

    const results = getUnlockedCreditBoxes(owner, 100);
    expect(results).toEqual([]);
  });

  it('getUnlockedCreditBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getUnlockedCreditBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getUnlockedCreditBoxes(bytes(32), 100);
    expect(results).toEqual([]);
  });
});
