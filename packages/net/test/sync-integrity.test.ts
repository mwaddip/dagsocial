import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encode } from 'cbor-x';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import {
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK,
} from '../src/types.js';
import type { NetConfig } from '../src/types.js';
import { MAX_INV_IDS } from '../src/msg-guards.js';
import { decodeFrame } from '../src/frame.js';
import { decodeModifierRequest } from '../src/sync-codec.js';
import type { Inv, ModifierRequest } from '../src/sync-types.js';

// ---------------------------------------------------------------------------
// Sync integrity (audit M-10)
//
// Response binding, request provenance, the outstanding-set lifecycle, and the
// chain-height-gated stall clock. Every drop/reject case has an accept control
// so a fix that over-drops fails here too.
// ---------------------------------------------------------------------------

/**
 * Sync-conversation outstanding-ids cap. Kept in lockstep with
 * MAX_OUTSTANDING_IDS in src/sync-machine.ts — deliberately not imported: the
 * cap tests must fail loudly if the implementation constant drifts, and this
 * file must still load against pre-fix sources for vacuity runs.
 */
const OUTSTANDING_CAP = 4 * MAX_INV_IDS;

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlock: () => null,
    serializeOrderingBlock: () => null,
    getOrderingBlockHeader: () => null,
    getOrderingBlockId: () => null,
    chainHeight: () => 0,
    cumulativeWork: () => 0n,
    getAnchors: () => [],
    appendHeaders: () => {},
    appendBlocks: () => {},
    setValidatedHeight: () => {},
    flush: () => {},
    ...overrides,
  };
}

const testConfig: NetConfig = {
  magic: 0x54444147,
  postPowTargetBits: 8,
  bootstrapPeers: [],
  listenAddrs: '',
  maxPeers: 10,
  minPeers: 3,
  peerDbCap: 100,
  outboundFillIntervalMs: 30000,
  outboundRedialCooldownMs: 60000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  syncRequestTimeoutMs: 10000,
};

interface SentMessage {
  peerId: string;
  data: Uint8Array;
}

/**
 * Machine with observable sends, applied blocks, and protocol violations.
 * `advanceOnAppend` makes appendBlocks move chainHeight — the difference
 * between real progress and junk in the stall-clock tests.
 */
function makeMachine(opts: { advanceOnAppend?: boolean } = {}): {
  machine: SyncMachine;
  sent: SentMessage[];
  appended: unknown[];
  violations: { peerId: string; reason: string }[];
} {
  let height = 0;
  const sent: SentMessage[] = [];
  const appended: unknown[] = [];
  const violations: { peerId: string; reason: string }[] = [];
  const machine = new SyncMachine(
    testConfig,
    stubStore({
      chainHeight: () => height,
      appendBlocks: (blocks: unknown[]) => {
        appended.push(...blocks);
        if (opts.advanceOnAppend) height += blocks.length;
      },
    }),
    (peerId, data) => sent.push({ peerId, data }),
    async () => [],
    (peerId, reason) => violations.push({ peerId, reason }),
  );
  return { machine, sent, appended, violations };
}

function peerActive(machine: SyncMachine, peerId: string, peerHeight: number): void {
  machine.onPeerActive(peerId, peerHeight);
  machine.flush();
}

function peerDisconnect(machine: SyncMachine, peerId: string): void {
  machine.onPeerDisconnect(peerId);
  machine.flush();
}

function sendInv(machine: SyncMachine, peerId: string, ids: string[]): void {
  const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids };
  machine.handleMessage(peerId, MSG_INV, new Uint8Array(encode(inv)));
  machine.flush();
}

function sendResponse(
  machine: SyncMachine,
  peerId: string,
  modifiers: { id: string; data: Uint8Array }[],
  typeId: number = MODIFIER_ORDERING_BLOCK,
): void {
  const body = new Uint8Array(encode({ typeId, modifiers }));
  machine.handleMessage(peerId, MSG_MODIFIER_RESPONSE, body);
  machine.flush();
}

/** A response modifier with the given payload bytes. */
function mod(id: string, ...bytes: number[]): { id: string; data: Uint8Array } {
  return { id, data: new Uint8Array(bytes) };
}

/** All ModifierRequests sent so far, in order (SyncInfo frames filtered out). */
function sentRequests(sent: SentMessage[]): { peerId: string; req: ModifierRequest }[] {
  const reqs: { peerId: string; req: ModifierRequest }[] = [];
  for (const msg of sent) {
    const { code, body } = decodeFrame(testConfig.magic!, msg.data);
    if (code !== MSG_MODIFIER_REQUEST) continue;
    const req = decodeModifierRequest(body);
    if (req) reqs.push({ peerId: msg.peerId, req });
  }
  return reqs;
}

/** n distinct ids sharing a tag prefix. */
function batch(tag: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${tag}_${i}`);
}

describe('sync integrity (audit M-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Response binding — injection (M-10a)
  // -----------------------------------------------------------------------

  describe('response binding — injection (M-10a)', () => {
    // PRE-FIX: this case FAILS — handleModifierResponseMsg ignored its peer id
    // and never checked for an outstanding request, so peer B's response
    // reached store.appendBlocks and reset the stall clock.
    it('drops a response from a non-sync peer while a request to the sync peer is outstanding', () => {
      const { machine, appended, violations } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x', 'y']); // request sent → {x, y} outstanding

      vi.advanceTimersByTime(30_000);
      sendResponse(machine, 'peerB', [mod('x', 9)]); // plausible, but from B

      expect(appended).toHaveLength(0); // never reached the apply pipeline
      expect(violations).toHaveLength(0); // dropped without penalty

      // The stall clock was not touched either: rotation still fires exactly
      // one window after entering sync.
      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();
      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().stalledPeers.has('peerA')).toBe(true);
    });

    it('control: the same response from the sync peer is applied', () => {
      const { machine, appended, violations } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x', 'y']);

      sendResponse(machine, 'peerA', [mod('x', 1), mod('y', 2)]);

      expect(appended).toHaveLength(2);
      expect(Array.from(appended[0] as Uint8Array)).toEqual([1]);
      expect(Array.from(appended[1] as Uint8Array)).toEqual([2]);
      expect(violations).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Response binding — unsolicited ids from the sync peer itself
  // -----------------------------------------------------------------------

  describe('response binding — unsolicited ids', () => {
    // PRE-FIX: this case FAILS — nothing checked whether an id was requested,
    // so the never-requested id reached store.appendBlocks.
    it('drops ids never requested, then still accepts the requested ones', () => {
      const { machine, appended, violations } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x']); // only x is outstanding

      sendResponse(machine, 'peerA', [mod('u', 7)]); // u was never requested
      expect(appended).toHaveLength(0);
      expect(violations).toHaveLength(0); // dropped without penalty

      // Control: the conversation is not poisoned — the requested id lands.
      sendResponse(machine, 'peerA', [mod('x', 1)]);
      expect(appended).toHaveLength(1);
      expect(Array.from(appended[0] as Uint8Array)).toEqual([1]);
    });

    it('does not consume outstanding ids on a response of a different modifier type', () => {
      const { machine, appended } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x']);

      sendResponse(machine, 'peerA', [mod('x', 9)], 999); // wrong typeId
      expect(appended).toHaveLength(0);

      // x is still outstanding — the real answer is accepted afterwards.
      sendResponse(machine, 'peerA', [mod('x', 1)]);
      expect(appended).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Stall clock — junk cannot pin sync (M-10b)
  // -----------------------------------------------------------------------

  describe('stall clock (M-10b)', () => {
    // PRE-FIX: this case FAILS — lastProgressMs was reset for ANY non-empty
    // modifiers array, so junk every <60s kept the victim pinned to the peer
    // forever and rotatePeer never ran.
    it('rotates away from a peer feeding non-advancing responses', () => {
      const { machine, appended } = makeMachine(); // appendBlocks does NOT advance height
      peerActive(machine, 'peerA', 100); // t=0: enters syncing, clock reset
      sendInv(machine, 'peerA', ['j1', 'j2', 'j3']); // all outstanding

      // Junk every 20s: solicited ids, applied, but chainHeight never moves.
      vi.advanceTimersByTime(20_000);
      sendResponse(machine, 'peerA', [mod('j1', 1)]);
      vi.advanceTimersByTime(20_000);
      sendResponse(machine, 'peerA', [mod('j2', 2)]);
      vi.advanceTimersByTime(20_000);
      sendResponse(machine, 'peerA', [mod('j3', 3)]);

      // The junk DID go through the apply path — and still counts for nothing.
      expect(appended).toHaveLength(3);

      vi.advanceTimersByTime(1_000); // t=61s since the last real progress
      machine.onTimerTick();

      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
      expect(machine.getState().stalledPeers.has('peerA')).toBe(true);
    });

    it('control: chain-advancing responses keep the clock fresh, bounded to one window', () => {
      const { machine, appended } = makeMachine({ advanceOnAppend: true });
      peerActive(machine, 'peerA', 100); // t=0
      sendInv(machine, 'peerA', ['g1', 'g2']);

      vi.advanceTimersByTime(50_000); // t=50s
      sendResponse(machine, 'peerA', [mod('g1', 1)]); // height 0 → 1: real progress
      expect(appended).toHaveLength(1);

      vi.advanceTimersByTime(11_000); // t=61s — 11s since progress
      machine.onTimerTick();
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peerA');

      vi.advanceTimersByTime(50_000); // t=111s — 61s since progress
      machine.onTimerTick();
      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().stalledPeers.has('peerA')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Partial responses and duplicate handling
  // -----------------------------------------------------------------------

  describe('partial responses', () => {
    // PRE-FIX: the final step FAILS — a re-sent consumed id was re-applied.
    it('applies a subset, keeps the remainder outstanding, rejects re-sends of consumed ids', () => {
      const { machine, appended, violations } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x', 'y', 'z']); // one request for all three

      sendResponse(machine, 'peerA', [mod('x', 1)]); // partial: serve-side truncation
      expect(appended).toHaveLength(1);

      sendResponse(machine, 'peerA', [mod('y', 2), mod('z', 3)]); // remainder still accepted
      expect(appended).toHaveLength(3);

      sendResponse(machine, 'peerA', [mod('x', 9)]); // x already consumed
      expect(appended).toHaveLength(3);
      expect(violations).toHaveLength(0);
    });

    // PRE-FIX: FAILS — both copies were appended.
    it('processes a duplicate id within one response once', () => {
      const { machine, appended } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x']);

      sendResponse(machine, 'peerA', [mod('x', 1), mod('x', 2)]);

      expect(appended).toHaveLength(1);
      expect(Array.from(appended[0] as Uint8Array)).toEqual([1]);
    });

    it('leaves an empty-data modifier outstanding for a later real response', () => {
      const { machine, appended } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x']);

      sendResponse(machine, 'peerA', [mod('x')]); // empty payload answers nothing
      expect(appended).toHaveLength(0);

      sendResponse(machine, 'peerA', [mod('x', 1)]);
      expect(appended).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Outstanding-set lifecycle — rotation and disconnect clear it
  // -----------------------------------------------------------------------

  describe('lifecycle — rotation and disconnect', () => {
    // PRE-FIX: both cases FAIL — the late response was applied.
    it('drops a late response for ids requested before a stall rotation', () => {
      const { machine, appended, violations } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x']);

      vi.advanceTimersByTime(61_000);
      machine.onTimerTick(); // stall → rotate away from peerA
      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().stalledPeers.has('peerA')).toBe(true);

      sendResponse(machine, 'peerA', [mod('x', 1)]); // crossed the rotation in flight
      expect(appended).toHaveLength(0);
      expect(violations).toHaveLength(0); // dropped without penalty, no crash
    });

    it('drops a late response for ids requested before the sync peer disconnected', () => {
      const { machine, appended, violations } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x']);

      peerDisconnect(machine, 'peerA');
      expect(machine.getState().phase).toBe('idle');

      sendResponse(machine, 'peerA', [mod('x', 1)]);
      expect(appended).toHaveLength(0);
      expect(violations).toHaveLength(0);
    });

    it('control: without rotation or disconnect the same late response is applied', () => {
      const { machine, appended } = makeMachine();
      peerActive(machine, 'peerA', 100);
      sendInv(machine, 'peerA', ['x']);

      vi.advanceTimersByTime(59_000); // inside the stall window — no rotation
      machine.onTimerTick();
      expect(machine.getState().phase).toBe('syncing');

      sendResponse(machine, 'peerA', [mod('x', 1)]);
      expect(appended).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Request provenance — third-party Invs (M-10c)
  // -----------------------------------------------------------------------

  describe('request provenance (M-10c)', () => {
    // PRE-FIX: FAILS — handleInvMsg ignored its peer id, so B's Inv made us
    // send a ModifierRequest to the sync peer and (post-binding) would have
    // grown the outstanding set on a third party's say-so.
    it('ignores a third-party Inv: no request sent, nothing becomes outstanding', () => {
      const { machine, sent, appended, violations } = makeMachine();
      peerActive(machine, 'peerA', 100);

      sendInv(machine, 'peerB', ['z']); // third party announces while we sync from A
      expect(sentRequests(sent)).toHaveLength(0);
      expect(violations).toHaveLength(0); // dropped without penalty

      // z never became outstanding — even the sync peer cannot deliver it.
      sendResponse(machine, 'peerA', [mod('z', 1)]);
      expect(appended).toHaveLength(0);
    });

    it('control: the sync peer’s Inv drives a request and its response is accepted', () => {
      const { machine, sent, appended } = makeMachine();
      peerActive(machine, 'peerA', 100);

      sendInv(machine, 'peerA', ['w']);
      const reqs = sentRequests(sent);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].peerId).toBe('peerA');
      expect(reqs[0].req.ids).toEqual(['w']);

      sendResponse(machine, 'peerA', [mod('w', 1)]);
      expect(appended).toHaveLength(1);
    });

    // PRE-FIX: FAILS — the request repeated both copies of x.
    it('deduplicates ids repeated within one Inv', () => {
      const { machine, sent } = makeMachine();
      peerActive(machine, 'peerA', 100);

      sendInv(machine, 'peerA', ['x', 'x', 'y']);
      const reqs = sentRequests(sent);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].req.ids).toEqual(['x', 'y']);
    });

    // PRE-FIX: FAILS — the second request re-asked for x.
    it('does not re-request ids that are already outstanding', () => {
      const { machine, sent } = makeMachine();
      peerActive(machine, 'peerA', 100);

      sendInv(machine, 'peerA', ['x']);
      sendInv(machine, 'peerA', ['x', 'y']); // x already outstanding
      const reqs = sentRequests(sent);
      expect(reqs).toHaveLength(2);
      expect(reqs[1].req.ids).toEqual(['y']);
    });
  });

  // -----------------------------------------------------------------------
  // Outstanding-set cap
  // -----------------------------------------------------------------------

  describe('outstanding-set cap', () => {
    // PRE-FIX: FAILS — no cap existed; every Inv produced a full request.
    it('trims requests at the cap, refuses past it, and frees budget on acceptance', () => {
      const { machine, sent, appended } = makeMachine();
      peerActive(machine, 'peerA', 10_000);

      // Fill to 1500 outstanding in legitimate ≤MAX_INV_IDS announcements.
      sendInv(machine, 'peerA', batch('a', MAX_INV_IDS));
      sendInv(machine, 'peerA', batch('b', MAX_INV_IDS));
      sendInv(machine, 'peerA', batch('c', MAX_INV_IDS));
      sendInv(machine, 'peerA', batch('d', 300));

      // 400 more announced, 100 of budget left: the request is trimmed, in
      // announcement order, so the set lands exactly on the cap.
      sendInv(machine, 'peerA', batch('e', MAX_INV_IDS));

      // At the cap: a further Inv produces no request at all.
      sendInv(machine, 'peerA', batch('f', MAX_INV_IDS));

      const lengths = sentRequests(sent).map((r) => r.req.ids.length);
      expect(lengths).toEqual([MAX_INV_IDS, MAX_INV_IDS, MAX_INV_IDS, 300, OUTSTANDING_CAP - 1500]);
      expect(sentRequests(sent)[4].req.ids).toEqual(batch('e', MAX_INV_IDS).slice(0, OUTSTANDING_CAP - 1500));

      // Acceptance frees budget: answer the trimmed batch, then a new Inv
      // produces a request again.
      const accepted = batch('e', MAX_INV_IDS).slice(0, OUTSTANDING_CAP - 1500);
      sendResponse(machine, 'peerA', accepted.map((id) => mod(id, 1)));
      expect(appended).toHaveLength(accepted.length);

      sendInv(machine, 'peerA', batch('g', 50));
      const after = sentRequests(sent);
      expect(after).toHaveLength(6);
      expect(after[5].req.ids).toEqual(batch('g', 50));
    });
  });
});
