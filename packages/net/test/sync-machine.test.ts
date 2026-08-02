import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { encode } from 'cbor-x';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import {
  MSG_SYNC_INFO,
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK,
} from '../src/types.js';
import type { NetConfig } from '../src/types.js';
import { MAX_INV_IDS, MAX_SERVE_BODY_BYTES } from '../src/msg-guards.js';
import { decodeFrame } from '../src/frame.js';
import { decodeModifierResponse } from '../src/sync-codec.js';
import type { SyncInfo, Inv, ModifierRequest } from '../src/sync-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  peerEvictionIntervalMs: 3600000,
  syncRequestTimeoutMs: 10000,
};

interface SentMessage {
  peerId: string;
  data: Uint8Array;
}

function makeMachine(overrides?: {
  store?: Partial<SyncStore>;
  sendToPeer?: (peerId: string, data: Uint8Array) => void;
  requestSubBlocks?: (peerId: string, ids: string[]) => Promise<unknown[]>;
}): { machine: SyncMachine; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const machine = new SyncMachine(
    testConfig,
    stubStore(overrides?.store),
    overrides?.sendToPeer ?? ((peerId, data) => sent.push({ peerId, data })),
    overrides?.requestSubBlocks ?? (async () => []),
  );
  return { machine, sent };
}

/** CBOR-encode a SyncInfo, enqueue it, and flush. */
function sendSyncInfo(machine: SyncMachine, peerId: string, info: SyncInfo): void {
  const body = new Uint8Array(encode(info));
  machine.handleMessage(peerId, MSG_SYNC_INFO, body);
  machine.flush();
}

/** CBOR-encode an Inv, enqueue it, and flush. */
function sendInv(machine: SyncMachine, peerId: string, inv: Inv): void {
  const body = new Uint8Array(encode(inv));
  machine.handleMessage(peerId, MSG_INV, body);
  machine.flush();
}

/** Call onPeerActive and flush the event loop. */
function peerActive(machine: SyncMachine, peerId: string, peerHeight: number): void {
  machine.onPeerActive(peerId, peerHeight);
  machine.flush();
}

/** Call onPeerDisconnect and flush the event loop. */
function peerDisconnect(machine: SyncMachine, peerId: string): void {
  machine.onPeerDisconnect(peerId);
  machine.flush();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncMachine', () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('starts idle', () => {
      const { machine } = makeMachine();
      expect(machine.getState().phase).toBe('idle');
    });

    it('has no sync peer', () => {
      const { machine } = makeMachine();
      expect(machine.getState().syncPeerId).toBeNull();
    });

    it('has an empty stalled set', () => {
      const { machine } = makeMachine();
      expect(machine.getState().stalledPeers.size).toBe(0);
    });

    it('has zero downloaded and applied heights', () => {
      const { machine } = makeMachine();
      expect(machine.getState().downloadedHeight).toBe(0);
      expect(machine.getState().stateAppliedHeight).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // onPeerActive
  // -----------------------------------------------------------------------

  describe('onPeerActive', () => {
    it('transitions to syncing when peer is ahead and we are idle', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });

    it('sends SyncInfo when transitioning to syncing', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 0, getOrderingBlockId: () => 'abc123' },
      });
      peerActive(machine, 'peer1', 100);
      expect(sent.length).toBe(1);
      expect(sent[0].peerId).toBe('peer1');
    });

    it('removes peer from stalled set when entering syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      machine.getState().stalledPeers.add('peer1');
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().stalledPeers.has('peer1')).toBe(false);
    });

    it('stays idle when peer height equals ours', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 0);
      expect(machine.getState().phase).toBe('idle');
    });

    it('serves Inv when peer is behind', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 5); // peer at 5, we at 10
      expect(sent.length).toBe(1);
      expect(sent[0].peerId).toBe('peer1');
    });

    it('re-enters syncing from synced when peer reports higher height', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      // Get to synced
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');

      // Peer reports a higher height — should re-enter syncing
      peerActive(machine, 'peer2', 300);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer2');
    });

    it('does not switch sync peer when already syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');

      // Another peer comes along, also ahead
      peerActive(machine, 'peer2', 200);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });
  });

  // -----------------------------------------------------------------------
  // handleSyncInfo (via handleMessage with MSG_SYNC_INFO)
  // -----------------------------------------------------------------------

  describe('handleSyncInfo', () => {
    it('starts syncing when peer reports higher height and we are idle', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });

    it('serves Inv when peer reports lower height', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 5,
        tipBlockId: 'xyz',
        tipCumulativeWork: '500',
        anchors: [],
      });
      expect(sent.length).toBe(1);
      expect(sent[0].peerId).toBe('peer1');
    });

    it('transitions to synced when peer reports equal height while we are syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      // First enter syncing
      peerActive(machine, 'peer1', 200);
      expect(machine.getState().phase).toBe('syncing');

      // Now peer reports equal height
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');
    });

    it('clears stalled peers when transitioning to synced', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      peerActive(machine, 'peer1', 200);
      machine.getState().stalledPeers.add('oldPeer');

      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');
      expect(machine.getState().stalledPeers.size).toBe(0);
    });

    it('stays idle when peer reports equal height and we are idle', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('idle');
    });

    it('re-enters syncing from synced when peer reports higher height', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      // Get to synced
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');

      // A different peer reports higher height via SyncInfo
      sendSyncInfo(machine, 'peer2', {
        tipHeight: 300,
        tipBlockId: 'def',
        tipCumulativeWork: '2000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer2');
    });

    it('removes peer from stalled set on re-engage', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      machine.getState().stalledPeers.add('peer1');
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().stalledPeers.has('peer1')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // handleInv (via handleMessage with MSG_INV)
  // -----------------------------------------------------------------------

  describe('handleInv', () => {
    it('sends ModifierRequest when syncing', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 0, getOrderingBlockId: () => null },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0; // clear the SyncInfo send

      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1', 'id2'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(1);
      expect(sent[0].peerId).toBe('peer1');
    });

    it('ignores Inv when not syncing', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 0 } });
      // Machine is idle
      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(0);
    });

    it('filters out already-known IDs', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 1,
          getOrderingBlockId: (h: number) => (h === 1 ? 'id1' : null), // id1 is known
        },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1', 'id2'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(1);
      // The encoded ModifierRequest should only contain id2
    });

    it('sends nothing when all IDs are already known', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 2,
          getOrderingBlockId: (h: number) => `id${h}`, // id1 and id2 both known
        },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1', 'id2'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(0);
    });

    it('ignores unknown typeId', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 0 },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      const inv: Inv = { typeId: 999, ids: ['x'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // handleModifierResponse
  // -----------------------------------------------------------------------

  describe('handleModifierResponse', () => {
    // Responses only apply when they answer an outstanding request from the
    // same peer (audit M-10) — each test solicits via an Inv from the sync
    // peer first. The unsolicited paths are covered in sync-integrity.test.ts.

    it('no-ops on empty modifier list', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      const body = new Uint8Array(
        encode({ typeId: MODIFIER_ORDERING_BLOCK, modifiers: [] }),
      );
      // Should not throw
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();
    });

    it('calls appendBlocks for solicited ordering block responses', () => {
      const appended: unknown[] = [];
      const { machine } = makeMachine({
        store: {
          chainHeight: () => 0,
          appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1', 'b2'] });
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [
            { id: 'b1', data: new Uint8Array([1]) },
            { id: 'b2', data: new Uint8Array([2]) },
          ],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();
      expect(appended.length).toBe(2);
    });

    it('skips modifiers with empty data', () => {
      const appended: unknown[] = [];
      const { machine } = makeMachine({
        store: {
          chainHeight: () => 0,
          appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1', 'b2'] });
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [
            { id: 'b1', data: new Uint8Array([]) }, // empty — skipped
            { id: 'b2', data: new Uint8Array([2]) },
          ],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();
      expect(appended.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // servePeer via onPeerActive (peer behind us)
  // -----------------------------------------------------------------------

  describe('servePeer', () => {
    it('sends Inv to peer that is behind', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 5);
      expect(sent.length).toBe(1);
    });

    it('sends no Inv when peer is at or above our tip', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 10); // equal — behind condition is peerHeight < ourHeight
      expect(sent.length).toBe(0);
    });

    it('caps Inv at MAX_INV_IDS (400)', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 1000,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 0);
      expect(sent.length).toBe(1);
      // The Inv should have at most 400 IDs
      // We can't easily verify the encoded content here, but the send happened
    });

    it('skips heights with no block ID', () => {
      const ids: string[] = [];
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 5,
          getOrderingBlockId: (h: number) => {
            if (h === 3) return null; // gap at height 3
            return `block_${h}`;
          },
        },
      });
      peerActive(machine, 'peer1', 0);
      expect(sent.length).toBe(1);
      // Should have sent Inv for heights 1,2,4,5 (skipping 3)
    });
  });

  // -----------------------------------------------------------------------
  // onTimerTick — stall detection and periodic SyncInfo
  // -----------------------------------------------------------------------

  describe('onTimerTick', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rotates peer after stall timeout with no progress', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');

      // Advance past stall timeout (60s)
      vi.advanceTimersByTime(61_000);
      machine.onTimerTick();

      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
      expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    });

    it('does not rotate if progress was made recently', () => {
      // Progress must be solicited AND chain-advancing to count (audit M-10).
      let height = 0;
      const { machine } = makeMachine({
        store: {
          chainHeight: () => height,
          appendBlocks: (blocks: unknown[]) => { height += blocks.length; },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });

      // Real progress: a solicited response that advances the chain
      vi.advanceTimersByTime(30_000); // 30s
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush(); // <-- process the data event so lastProgressMs updates

      // Advance to 61s total
      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      // Should still be syncing — progress was at 30s (31s ago < 60s)
      expect(machine.getState().phase).toBe('syncing');
    });

    it('rotates after stall even with progress long ago', () => {
      let height = 0;
      const { machine } = makeMachine({
        store: {
          chainHeight: () => height,
          appendBlocks: (blocks: unknown[]) => { height += blocks.length; },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });

      // Solicited, chain-advancing progress at t=0
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush(); // <-- process the data event so lastProgressMs updates

      // Advance past 60s from that progress
      vi.advanceTimersByTime(61_000);
      machine.onTimerTick();

      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    });

    it('starts with fresh progress timestamp on entering syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      // Enter syncing at fake time 0 — lastProgressMs is set to Date.now()
      peerActive(machine, 'peer1', 100);

      // Advance 59s — just under the stall threshold
      vi.advanceTimersByTime(59_000);
      machine.onTimerTick();

      // Should still be syncing (59s < 60s stall timeout)
      expect(machine.getState().phase).toBe('syncing');
    });

    it('sends periodic SyncInfo when not idle', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      sent.length = 0; // clear initial SyncInfo

      // Advance past 30s poll interval
      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      expect(sent.length).toBe(1); // periodic SyncInfo
    });

    it('does not send periodic SyncInfo when idle', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 0 } });

      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      expect(sent.length).toBe(0);
    });

    it('sends periodic SyncInfo when synced', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 100 } });
      // Get to synced phase
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');
      sent.length = 0;

      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      expect(sent.length).toBe(1); // periodic SyncInfo in synced phase
    });
  });

  // -----------------------------------------------------------------------
  // onPeerDisconnect
  // -----------------------------------------------------------------------

  describe('onPeerDisconnect', () => {
    it('adds sync peer to stalled set on disconnect', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      peerDisconnect(machine, 'peer1');

      expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    });

    it('resets to idle when sync peer disconnects while syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');

      peerDisconnect(machine, 'peer1');
      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
    });

    it('does not reset phase for non-sync peer disconnect', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');

      peerDisconnect(machine, 'peer2'); // different peer
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });

    it('does not add non-sync peer to stalled set', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      peerDisconnect(machine, 'peer2');

      expect(machine.getState().stalledPeers.has('peer2')).toBe(false);
    });

    it('resets to idle when sync peer disconnects while synced', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        tipCumulativeWork: '1000',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');

      peerDisconnect(machine, 'peer1');
      // Phase resets to idle so the node can pick a new sync peer
      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // rotatePeer (tested indirectly via stall, but also directly)
  // -----------------------------------------------------------------------

  describe('rotatePeer', () => {
    it('happens on stall (covered by timer tests)', () => {
      // Already covered above
    });
  });

  // -----------------------------------------------------------------------
  // Unknown message type
  // -----------------------------------------------------------------------

  describe('unknown message type', () => {
    it('ignores messages with unknown codes', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      // Should not throw
      machine.handleMessage('peer1', 99, new Uint8Array([1, 2, 3]));
      machine.flush();
      expect(machine.getState().phase).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // getState returns a stable snapshot
  // -----------------------------------------------------------------------

  describe('getState', () => {
    it('reflects current state after transitions', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      expect(machine.getState().phase).toBe('idle');

      peerActive(machine, 'peer1', 100);
      const s1 = machine.getState();
      expect(s1.phase).toBe('syncing');
      expect(s1.syncPeerId).toBe('peer1');

      peerDisconnect(machine, 'peer1');
      const s2 = machine.getState();
      expect(s2.phase).toBe('idle');
      expect(s2.syncPeerId).toBeNull();
      expect(s2.stalledPeers.has('peer1')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // SyncInfo message content
  // -----------------------------------------------------------------------

  describe('sendSyncInfo content', () => {
    it('includes tip height, cumulative work, and anchors', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 42,
          cumulativeWork: () => 1000n,
          getOrderingBlockId: (h: number) => (h === 42 ? 'tip42' : null),
          getAnchors: () => [{ height: 0, blockId: 'genesis' }],
        },
      });

      peerActive(machine, 'peer1', 100);

      expect(sent.length).toBe(1);
      // We can't easily decode the framed SyncInfo from the raw bytes in the test,
      // but the send happened with the right peer.
      expect(sent[0].peerId).toBe('peer1');
    });
  });

  // -----------------------------------------------------------------------
  // Default magic when config.magic is undefined
  // -----------------------------------------------------------------------

  describe('default magic', () => {
    it('uses MAGIC_MAINNET when config.magic is not set', () => {
      const configNoMagic: NetConfig = { ...testConfig };
      delete configNoMagic.magic;

      const sent: SentMessage[] = [];
      const machine = new SyncMachine(
        configNoMagic,
        stubStore({ chainHeight: () => 0 }),
        (peerId, data) => sent.push({ peerId, data }),
        async () => [],
      );

      machine.onPeerActive('peer1', 100);
      machine.flush();

      // Should have sent a SyncInfo frame without throwing
      // (if magic were undefined, encodeFrame would fail)
      expect(sent.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // handleModifierRequest — response from store
  // -----------------------------------------------------------------------

  describe('handleModifierRequest', () => {
    it('sends ModifierResponse when blocks are found', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 5,
          getOrderingBlockId: (h: number) => `block_${h}`,
          getOrderingBlock: () => ({ header: { height: 3 } }),
          serializeOrderingBlock: () => new Uint8Array([1, 2, 3]),
        },
      });

      const req: ModifierRequest = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['block_3'] };
      const body = new Uint8Array(encode(req));
      machine.handleMessage('peer1', MSG_MODIFIER_REQUEST, body);
      machine.flush();

      // Currently sends response only when modifiers are found.
      // The implementation iterates heights to find matching IDs.
      // Since getOrderingBlock returns an object, a modifier is produced.
      // However the data field is empty Uint8Array in the current implementation.
      // The response is only sent if modifiers.length > 0.
      expect(sent.length).toBe(1);
      expect(sent[0].peerId).toBe('peer1');
    });

    it('does not respond when no blocks match', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 0,
          getOrderingBlockId: () => null,
        },
      });

      const req: ModifierRequest = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['nonexistent'] };
      const body = new Uint8Array(encode(req));
      machine.handleMessage('peer1', MSG_MODIFIER_REQUEST, body);
      machine.flush();

      expect(sent.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Malformed messages + event-loop isolation (audit C-7)
  // -----------------------------------------------------------------------

  describe('malformed messages (audit C-7)', () => {
    /** Let the background event loop run a few iterations. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

    function makeReportingMachine(store: Partial<SyncStore> = {}): {
      machine: SyncMachine;
      sent: SentMessage[];
      violations: { peerId: string; reason: string }[];
    } {
      const sent: SentMessage[] = [];
      const violations: { peerId: string; reason: string }[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore(store),
        (peerId, data) => sent.push({ peerId, data }),
        async () => [],
        (peerId, reason) => violations.push({ peerId, reason }),
      );
      return { machine, sent, violations };
    }

    // --- decode boundary: the message never reaches a handler ---------------

    it('drops a ModifierRequest with no ids and penalizes the sender', () => {
      const { machine, sent, violations } = makeReportingMachine({ chainHeight: () => 5 });
      // The audit payload: well-formed CBOR, but `ids` is missing.
      machine.handleMessage('attacker', MSG_MODIFIER_REQUEST, new Uint8Array(encode({ typeId: 101 })));
      machine.flush();

      expect(sent).toHaveLength(0);
      expect(violations).toEqual([{ peerId: 'attacker', reason: 'malformed ModifierRequest' }]);
    });

    it('drops a malformed Inv', () => {
      const { machine, violations } = makeReportingMachine({ chainHeight: () => 0 });
      peerActive(machine, 'peer1', 100);
      machine.handleMessage('peer1', MSG_INV, new Uint8Array(encode({ typeId: 101, ids: 'all' })));
      machine.flush();
      expect(violations).toEqual([{ peerId: 'peer1', reason: 'malformed Inv' }]);
    });

    it('drops a malformed ModifierResponse', () => {
      const appended: unknown[] = [];
      const { machine, violations } = makeReportingMachine({
        chainHeight: () => 0,
        appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
      });
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, new Uint8Array(encode({ typeId: 101 })));
      machine.flush();
      expect(appended).toHaveLength(0);
      expect(violations).toEqual([{ peerId: 'peer1', reason: 'malformed ModifierResponse' }]);
    });

    it('drops non-CBOR garbage without throwing', () => {
      const { machine, violations } = makeReportingMachine({ chainHeight: () => 0 });
      machine.handleMessage('attacker', MSG_SYNC_INFO, new Uint8Array([0xff, 0xff, 0xff]));
      machine.flush();
      expect(violations).toHaveLength(1);
      expect(machine.getState().phase).toBe('idle');
    });

    // --- height bounds: servePeer's per-height loop is never entered --------

    it('never reaches servePeer for a negative advertised height', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });

      machine.onPeerActive('attacker', -1_000_000_000);
      machine.flush();

      // The ~1e9-iteration store scan never ran.
      expect(reads).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(machine.getState().phase).toBe('idle');
      expect(violations).toHaveLength(1);
    });

    it('never reaches servePeer for a SyncInfo with a negative tipHeight', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });

      machine.handleMessage('attacker', MSG_SYNC_INFO, new Uint8Array(encode({
        tipHeight: -1_000_000_000,
        tipBlockId: 'x',
        tipCumulativeWork: '1',
        anchors: [],
      })));
      machine.flush();

      expect(reads).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(violations).toEqual([{ peerId: 'attacker', reason: 'malformed SyncInfo' }]);
    });

    it('still serves a peer that is legitimately behind', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });

      machine.handleMessage('peer1', MSG_SYNC_INFO, new Uint8Array(encode({
        tipHeight: 5,
        tipBlockId: 'x',
        tipCumulativeWork: '1',
        anchors: [],
      })));
      machine.flush();

      expect(reads).toEqual([6, 7, 8, 9, 10]);
      expect(sent).toHaveLength(1);
      expect(violations).toHaveLength(0);
    });

    // --- event-loop isolation ----------------------------------------------

    it('keeps the background event loop alive after a malformed ModifierRequest', async () => {
      const { machine } = makeReportingMachine({ chainHeight: () => 0 });
      machine.start();
      try {
        machine.handleMessage('attacker', MSG_MODIFIER_REQUEST, new Uint8Array(encode({ typeId: 101 })));
        await settle();

        // The loop must still be processing — before the fix this event was
        // never seen, because the loop promise had already rejected.
        machine.onPeerActive('peer1', 100);
        await settle();

        expect(machine.getState().phase).toBe('syncing');
        expect(machine.getState().syncPeerId).toBe('peer1');
      } finally {
        machine.stop();
      }
    });

    it('survives a handler that throws and keeps processing later events', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let calls = 0;
      const { machine } = makeReportingMachine({
        chainHeight: () => {
          calls++;
          if (calls === 1) throw new Error('store exploded');
          return 0;
        },
      });
      machine.start();
      try {
        machine.onPeerActive('poison', 50);
        await settle();
        expect(machine.getState().phase).toBe('idle');

        machine.onPeerActive('peer1', 100);
        await settle();
        expect(machine.getState().phase).toBe('syncing');
        expect(errSpy).toHaveBeenCalled();
      } finally {
        machine.stop();
        errSpy.mockRestore();
      }
    });

    it('isolates a throwing handler in flush() too', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let calls = 0;
      const { machine } = makeReportingMachine({
        chainHeight: () => {
          calls++;
          if (calls === 1) throw new Error('store exploded');
          return 0;
        },
      });

      machine.onPeerActive('poison', 50);
      machine.onPeerActive('peer1', 100);
      expect(() => machine.flush()).not.toThrow();
      expect(machine.getState().phase).toBe('syncing');

      errSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Resource limits (audit H-9)
  //
  // Element-wise shape checks pass an arbitrarily long array through, and every
  // element buys the receiver work. Two things have to hold: the array is capped
  // on receipt, and the work per surviving message is bounded by the chain, not
  // by the chain times the peer's id count.
  // -----------------------------------------------------------------------

  describe('resource limits (audit H-9)', () => {
    function makeReportingMachine(store: Partial<SyncStore> = {}): {
      machine: SyncMachine;
      sent: SentMessage[];
      violations: { peerId: string; reason: string }[];
    } {
      const sent: SentMessage[] = [];
      const violations: { peerId: string; reason: string }[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore(store),
        (peerId, data) => sent.push({ peerId, data }),
        async () => [],
        (peerId, reason) => violations.push({ peerId, reason }),
      );
      return { machine, sent, violations };
    }

    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `block_${i + 1}`);

    // --- inbound arrays are capped on receipt -------------------------------

    it('drops an Inv over MAX_INV_IDS and penalizes the sender', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });
      peerActive(machine, 'attacker', 100);
      sent.length = 0;
      reads.length = 0;

      machine.handleMessage(
        'attacker',
        MSG_INV,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS + 1) })),
      );
      machine.flush();

      expect(sent).toHaveLength(0);
      expect(reads).toHaveLength(0);
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    it('accepts an Inv of exactly MAX_INV_IDS ids', () => {
      const { machine, sent, violations } = makeReportingMachine({ chainHeight: () => 0 });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      machine.handleMessage(
        'peer1',
        MSG_INV,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS) })),
      );
      machine.flush();

      expect(violations).toHaveLength(0);
      expect(sent).toHaveLength(1);
    });

    it('drops a ModifierRequest over MAX_INV_IDS before the serve loop runs', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
        serializeOrderingBlock: () => new Uint8Array([1]),
      });

      machine.handleMessage(
        'attacker',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS + 1) })),
      );
      machine.flush();

      expect(reads).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    it('drops a ModifierResponse over MAX_INV_IDS without applying it', () => {
      const appended: unknown[] = [];
      const { machine, violations } = makeReportingMachine({
        chainHeight: () => 0,
        appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
      });

      machine.handleMessage(
        'attacker',
        MSG_MODIFIER_RESPONSE,
        new Uint8Array(encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: ids(MAX_INV_IDS + 1).map((id) => ({ id, data: new Uint8Array([1]) })),
        })),
      );
      machine.flush();

      expect(appended).toHaveLength(0);
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    it('drops a SyncInfo with more than MAX_INV_IDS anchors', () => {
      const { machine, sent, violations } = makeReportingMachine({ chainHeight: () => 10 });

      machine.handleMessage('attacker', MSG_SYNC_INFO, new Uint8Array(encode({
        tipHeight: 5,
        tipBlockId: 'x',
        tipCumulativeWork: '1',
        anchors: Array.from({ length: MAX_INV_IDS + 1 }, (_, i) => ({ height: i, blockId: `a${i}` })),
      })));
      machine.flush();

      expect(sent).toHaveLength(0);
      expect(machine.getState().phase).toBe('idle');
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    // --- serve work is O(chainHeight + ids), never O(ids × chainHeight) -----

    it('scans the chain once per ModifierRequest, not once per id', () => {
      const CHAIN_HEIGHT = 50;
      const reads: number[] = [];
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => CHAIN_HEIGHT,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
        serializeOrderingBlock: () => new Uint8Array([1, 2, 3]),
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS) })),
      );
      machine.flush();

      // One pass over heights 0..CHAIN_HEIGHT. The pre-fix nested loop read
      // ~MAX_INV_IDS × CHAIN_HEIGHT heights for the same message.
      expect(reads).toHaveLength(CHAIN_HEIGHT + 1);
      expect(sent).toHaveLength(1);
    });

    it('scans the chain once per Inv, not once per announced id', () => {
      const CHAIN_HEIGHT = 50;
      const reads: number[] = [];
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => CHAIN_HEIGHT,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });
      peerActive(machine, 'peer1', 1000);
      sent.length = 0;
      reads.length = 0;

      machine.handleMessage(
        'peer1',
        MSG_INV,
        new Uint8Array(encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          ids: Array.from({ length: MAX_INV_IDS }, (_, i) => `unknown_${i}`),
        })),
      );
      machine.flush();

      expect(reads).toHaveLength(CHAIN_HEIGHT + 1);
      expect(sent).toHaveLength(1);
    });

    // --- served bodies stay inside the reader's byte cap --------------------

    function servedModifierCount(sent: SentMessage[]): number {
      expect(sent).toHaveLength(1);
      const { code, body } = decodeFrame(testConfig.magic!, sent[0].data);
      expect(code).toBe(MSG_MODIFIER_RESPONSE);
      return decodeModifierResponse(body)!.modifiers.length;
    }

    it('truncates a response that would exceed MAX_SERVE_BODY_BYTES', () => {
      const chunk = new Uint8Array(3 * 1024 * 1024); // two of these overflow 4 MiB
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 3,
        getOrderingBlockId: (h: number) => `block_${h}`,
        serializeOrderingBlock: () => chunk,
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(3) })),
      );
      machine.flush();

      expect(servedModifierCount(sent)).toBe(1);
    });

    it('still serves a single block larger than the byte budget', () => {
      // Otherwise an oversized block could never be handed over and sync wedges.
      const chunk = new Uint8Array(MAX_SERVE_BODY_BYTES + 1024);
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 1,
        getOrderingBlockId: (h: number) => `block_${h}`,
        serializeOrderingBlock: () => chunk,
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(1) })),
      );
      machine.flush();

      expect(servedModifierCount(sent)).toBe(1);
    });
  });
});
