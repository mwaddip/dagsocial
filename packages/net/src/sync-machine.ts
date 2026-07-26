import { MAGIC_MAINNET } from './frame.js';
import type { NetConfig } from './types.js';
import {
  MSG_SYNC_INFO,
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK,
  MODIFIER_SUB_BLOCK,
} from './types.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse, SyncState } from './sync-types.js';
import {
  encodeSyncInfo,
  decodeSyncInfo,
  encodeInv,
  decodeInv,
  encodeModifierRequest,
  decodeModifierRequest,
  encodeModifierResponse,
  decodeModifierResponse,
} from './sync-codec.js';

// ---------------------------------------------------------------------------
// SyncStore — bridge to the node's storage layer
// ---------------------------------------------------------------------------

export interface SyncStore {
  /** Full ordering block by height, or null if not available. */
  getOrderingBlock(height: number): unknown | null;
  /** CBOR-serialized ordering block bytes for a given height, or null. */
  serializeOrderingBlock(height: number): Uint8Array | null;
  /** Block header by height, or null if not available. */
  getOrderingBlockHeader(height: number): unknown | null;
  /** Block ID (hash) for a given height, or null if not available. */
  getOrderingBlockId(height: number): string | null;
  /** True if the header with this ID is already known. */
  hasOrderingBlockHeader(id: string): boolean;
  /** True if the sub-block with this ID is already known. */
  hasSubBlock(id: string): boolean;
  /** Current best-chain tip height. */
  chainHeight(): number;
  /** Cumulative work (sum of 2^targetBits) of the best chain. */
  cumulativeWork(): bigint;
  /** Anchors for sync (height + block ID pairs across the chain). */
  getAnchors(): { height: number; blockId: string }[];
  /** Persist received headers. */
  appendHeaders(headers: unknown[]): void;
  /** Persist received full blocks. */
  appendBlocks(blocks: unknown[]): void;
  /** Mark a height as fully validated (headers + body + signatures). */
  setValidatedHeight(height: number): void;
  /** Flush pending writes to durable storage. */
  flush(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 60 seconds without progress triggers a peer rotation. */
const STALL_TIMEOUT_MS = 60_000;
/** Send SyncInfo to sync peer every 30 seconds while active. */
const SYNCED_POLL_INTERVAL_MS = 30_000;
/** Maximum number of IDs to include in a single Inv message. */
const MAX_INV_IDS = 400;

// ---------------------------------------------------------------------------
// SyncMachine
// ---------------------------------------------------------------------------

/**
 * Core sync state machine.
 *
 * Event-driven — the node calls `onPeerActive`, `handleMessage`, `onTimerTick`,
 * and `onPeerDisconnect`. The machine owns sync phase, peer selection, stall
 * detection, and rotation.
 */
export class SyncMachine {
  private state: SyncState = {
    phase: 'idle',
    syncPeerId: null,
    stalledPeers: new Set(),
    downloadedHeight: 0,
    stateAppliedHeight: 0,
  };

  private lastProgressMs: number = 0;
  private lastSyncInfoMs: number = 0;

  private readonly magic: number;

  constructor(
    private config: NetConfig,
    private store: SyncStore,
    private sendToPeer: (peerId: string, data: Uint8Array) => void,
    private requestSubBlocks: (peerId: string, ids: string[]) => Promise<unknown[]>,
  ) {
    this.magic = config.magic ?? MAGIC_MAINNET;
  }

  /** Read-only snapshot of current sync state. */
  getState(): Readonly<SyncState> {
    return this.state;
  }

  // -----------------------------------------------------------------------
  // Public events (called by the node layer)
  // -----------------------------------------------------------------------

  /**
   * Called after handshake reveals a peer's tip height.
   *
   * - If the peer is ahead and we're idle → enter syncing phase.
   * - If the peer is behind → serve them an Inv so they can catch up.
   */
  onPeerActive(peerId: string, peerHeight: number): void {
    const ourHeight = this.store.chainHeight();

    if (peerHeight > ourHeight && (this.state.phase === 'idle' || this.state.phase === 'synced')) {
      this.state.phase = 'syncing';
      this.state.syncPeerId = peerId;
      this.state.stalledPeers.delete(peerId);
      this.lastProgressMs = Date.now();
      this.sendSyncInfo(peerId);
    } else if (peerHeight < ourHeight) {
      this.servePeer(peerId, peerHeight);
    }
  }

  /**
   * Dispatch an incoming framed message from a peer.
   *
   * The `body` is the raw CBOR payload (already stripped of the frame
   * envelope by the caller).
   */
  handleMessage(peerId: string, code: number, body: Uint8Array): void {
    switch (code) {
      case MSG_SYNC_INFO:
        this.handleSyncInfo(peerId, decodeSyncInfo(body));
        break;
      case MSG_INV:
        this.handleInv(peerId, decodeInv(body));
        break;
      case MSG_MODIFIER_REQUEST:
        this.handleModifierRequest(peerId, decodeModifierRequest(body));
        break;
      case MSG_MODIFIER_RESPONSE:
        this.handleModifierResponse(peerId, decodeModifierResponse(body));
        break;
      // Unknown message types are silently ignored.
    }
  }

  /**
   * Periodic timer tick.
   *
   * - Checks for stall (no progress in STALL_TIMEOUT_MS).
   * - Sends periodic SyncInfo while syncing/synced.
   */
  onTimerTick(): void {
    const now = Date.now();

    if (this.state.phase === 'syncing') {
      if (
        now - this.lastProgressMs > STALL_TIMEOUT_MS &&
        this.state.syncPeerId
      ) {
        this.rotatePeer();
        return;
      }
    }

    if (
      this.state.phase !== 'idle' &&
      this.state.syncPeerId &&
      now - this.lastSyncInfoMs > SYNCED_POLL_INTERVAL_MS
    ) {
      this.sendSyncInfo(this.state.syncPeerId);
    }
  }

  /**
   * Called when a peer disconnects.
   *
   * If the disconnected peer was our sync peer, add it to the stalled set and
   * reset phase so the node can pick a new peer.
   */
  onPeerDisconnect(peerId: string): void {
    if (this.state.syncPeerId === peerId) {
      this.state.stalledPeers.add(peerId);
      this.state.syncPeerId = null;
      if (this.state.phase === 'syncing' || this.state.phase === 'synced') {
        this.state.phase = 'idle';
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — message handlers
  // -----------------------------------------------------------------------

  /**
   * Process a SyncInfo message from a peer.
   *
   * - Peer ahead + we're idle → start syncing.
   * - Peer behind → serve them an Inv.
   * - Equal height + we were syncing → transition to synced.
   */
  private handleSyncInfo(peerId: string, info: SyncInfo): void {
    const ourHeight = this.store.chainHeight();

    if (info.tipHeight > ourHeight) {
      if (this.state.phase === 'idle' || this.state.phase === 'synced') {
        this.state.phase = 'syncing';
        this.state.syncPeerId = peerId;
        this.state.stalledPeers.delete(peerId);
        this.lastProgressMs = Date.now();
      }
    } else if (info.tipHeight < ourHeight) {
      this.servePeer(peerId, info.tipHeight);
    } else if (info.tipHeight === ourHeight && this.state.phase === 'syncing') {
      this.state.phase = 'synced';
      this.state.stalledPeers.clear();
    }
  }

  /**
   * Process an Inv (inventory) message.
   *
   * If we're syncing, request the announced modifiers from our sync peer.
   * Unknown IDs that we already have are filtered before requesting.
   */
  private handleInv(_peerId: string, inv: Inv): void {
    if (this.state.phase !== 'syncing' || !this.state.syncPeerId) return;

    // Filter out IDs we already know about
    const missing = inv.ids.filter((id) => {
      if (inv.typeId === MODIFIER_ORDERING_BLOCK) {
        return !this.store.hasOrderingBlockHeader(id);
      }
      if (inv.typeId === MODIFIER_SUB_BLOCK) {
        return !this.store.hasSubBlock(id);
      }
      return false;
    });

    if (missing.length === 0) return;

    const req: ModifierRequest = { typeId: inv.typeId, ids: missing };
    this.sendToPeer(this.state.syncPeerId, encodeModifierRequest(this.magic, req));
  }

  /**
   * Process a ModifierRequest from a peer — serve the requested data from
   * our local store.
   */
  private handleModifierRequest(peerId: string, req: ModifierRequest): void {
    const modifiers: { id: string; data: Uint8Array }[] = [];

    for (const id of req.ids) {
      // Currently we serve ordering blocks only. Sub-block serving uses a
      // separate protocol stream (see sync.ts).
      if (req.typeId === MODIFIER_ORDERING_BLOCK) {
        // Try to find by iterating heights. For a production store this would
        // be an indexed lookup.
        const ourHeight = this.store.chainHeight();
        for (let h = 0; h <= ourHeight; h++) {
          const storedId = this.store.getOrderingBlockId(h);
          if (storedId === id) {
            const block = this.store.getOrderingBlock(h);
            if (block) {
              // The block data is serialized by the store layer. For now,
              // pass the structured block — the codec will CBOR-encode it.
              const data = this.store.serializeOrderingBlock(h);
              if (data) {
                modifiers.push({ id, data });
              }
            }
            break;
          }
        }
      }
    }

    if (modifiers.length > 0) {
      const resp: ModifierResponse = { typeId: req.typeId, modifiers };
      this.sendToPeer(peerId, encodeModifierResponse(this.magic, resp));
    }
  }

  /**
   * Process a ModifierResponse — apply received headers/blocks to the store.
   */
  private handleModifierResponse(_peerId: string, resp: ModifierResponse): void {
    if (resp.modifiers.length === 0) return;

    this.lastProgressMs = Date.now();

    if (resp.typeId === MODIFIER_ORDERING_BLOCK) {
      // Each modifier carries a full ordering block. Apply them and track
      // progress via the count of received blocks.
      const blocks: unknown[] = [];

      for (const mod of resp.modifiers) {
        if (mod.data.length > 0) {
          blocks.push(mod.data);
        }
        // If the store can extract height from the block ID or data, it
        // would update maxHeight. For now, track count-based progress.
      }

      if (blocks.length > 0) {
        this.store.appendBlocks(blocks);
        const newHeight = this.store.chainHeight();
        this.state.downloadedHeight = Math.max(
          this.state.downloadedHeight,
          newHeight,
        );
        this.state.stateAppliedHeight = Math.max(
          this.state.stateAppliedHeight,
          newHeight,
        );
      }
    } else if (resp.typeId === MODIFIER_SUB_BLOCK) {
      // Sub-blocks are typically requested via the stream protocol
      // (sync.ts). If received as modifiers, append them.
      const subBlocks: unknown[] = [];
      for (const mod of resp.modifiers) {
        if (mod.data.length > 0) {
          subBlocks.push(mod.data);
        }
      }
      if (subBlocks.length > 0) {
        this.store.appendBlocks(subBlocks);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — serving
  // -----------------------------------------------------------------------

  /**
   * Serve a peer that is behind us by sending an Inv with continuation
   * from their height.
   *
   * Capped at MAX_INV_IDS to avoid oversized messages.
   */
  private servePeer(peerId: string, peerHeight: number): void {
    const startHeight = peerHeight + 1;
    const ourHeight = this.store.chainHeight();

    if (startHeight > ourHeight) return;

    const ids: string[] = [];
    for (let h = startHeight; h <= ourHeight && ids.length < MAX_INV_IDS; h++) {
      const id = this.store.getOrderingBlockId(h);
      if (id) {
        ids.push(id);
      }
    }

    if (ids.length > 0) {
      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids };
      this.sendToPeer(peerId, encodeInv(this.magic, inv));
    }
  }

  // -----------------------------------------------------------------------
  // Internal — helpers
  // -----------------------------------------------------------------------

  /**
   * Send our current SyncInfo to a peer.
   */
  private sendSyncInfo(peerId: string): void {
    const tipHeight = this.store.chainHeight();
    const tipBlockId = this.store.getOrderingBlockId(tipHeight) ?? '';

    const info: SyncInfo = {
      tipHeight,
      tipBlockId,
      tipCumulativeWork: this.store.cumulativeWork().toString(),
      anchors: this.store.getAnchors(),
    };

    this.sendToPeer(peerId, encodeSyncInfo(this.magic, info));
    this.lastSyncInfoMs = Date.now();
  }

  /**
   * Rotate away from the current sync peer (stall detected).
   *
   * Adds the peer to the stalled set so the node won't immediately
   * reconnect to it for sync, then resets to idle so the node layer
   * picks a new peer on the next `onPeerActive` call.
   */
  private rotatePeer(): void {
    if (this.state.syncPeerId) {
      this.state.stalledPeers.add(this.state.syncPeerId);
    }
    this.state.syncPeerId = null;
    this.state.phase = 'idle';
  }
}
