import { MAGIC_MAINNET } from './frame.js';
import type { NetConfig } from './types.js';
import {
  MSG_SYNC_INFO,
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK,
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
// Event types for biased event loop
// ---------------------------------------------------------------------------

/** Control events — unbounded channel, never dropped. */
type ControlEvent =
  | { type: 'peer-active'; peerId: string; peerHeight: number }
  | { type: 'peer-disconnect'; peerId: string }
  | { type: 'sync-info'; peerId: string; info: SyncInfo };

/** Data events — bounded channel, lossy. */
type DataEvent =
  | { type: 'inv'; peerId: string; inv: Inv }
  | { type: 'modifier-request'; peerId: string; req: ModifierRequest }
  | { type: 'modifier-response'; peerId: string; resp: ModifierResponse };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 60 seconds without progress triggers a peer rotation. */
const STALL_TIMEOUT_MS = 60_000;
/** Send SyncInfo to sync peer every 30 seconds while active. */
const SYNCED_POLL_INTERVAL_MS = 30_000;
/** Maximum number of IDs to include in a single Inv message. */
const MAX_INV_IDS = 400;
/** Maximum data events in the queue before dropping oldest. */
const MAX_DATA_QUEUE = 64;

// ---------------------------------------------------------------------------
// SyncMachine
// ---------------------------------------------------------------------------

/**
 * Core sync state machine with biased event loop.
 *
 * Event-driven — the node calls `onPeerActive`, `handleMessage`, `onTimerTick`,
 * and `onPeerDisconnect`. The machine owns sync phase, peer selection, stall
 * detection, and rotation.
 *
 * **Biased event loop** (call `start()` to begin):
 * 1. Control events (peer connect/disconnect, sync-info) — unbounded, never dropped
 * 2. Data events (inv, modifier req/resp) — bounded, lossy above MAX_DATA_QUEUE
 * 3. Timer tick — fallback, lowest priority
 *
 * Call `flush()` to synchronously drain all queued events (useful in tests).
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

  private onSyncedCallbacks: Array<() => void> = [];

  // -----------------------------------------------------------------------
  // Biased event queues
  // -----------------------------------------------------------------------

  /** Control events: unbounded, never dropped. */
  private controlQueue: ControlEvent[] = [];

  /** Data events: bounded, lossy. Oldest dropped when full. */
  private dataQueue: DataEvent[] = [];

  /** Whether the background event loop is running. */
  private running = false;

  constructor(
    private config: NetConfig,
    private store: SyncStore,
    private sendToPeer: (peerId: string, data: Uint8Array) => void,
    private requestSubBlocks: (peerId: string, ids: string[]) => Promise<unknown[]>,
  ) {
    this.magic = config.magic ?? MAGIC_MAINNET;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the background event loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.eventLoop().catch((err) => {
      console.error('[sync-machine] event loop crashed:', err);
    });
  }

  /** Stop the background event loop. Idempotent. */
  stop(): void {
    this.running = false;
  }

  // -----------------------------------------------------------------------
  // Background event loop
  // -----------------------------------------------------------------------

  /**
   * Biased event loop.
   *
   * Priority order:
   * 1. Drain ALL control events (unbounded, never dropped)
   * 2. Process ONE data event (bounded, lossy)
   * 3. Timer tick (fallback, lowest priority)
   *
   * Yields to the microtask queue between iterations to prevent CPU spinning.
   */
  private async eventLoop(): Promise<void> {
    while (this.running) {
      let didWork = false;

      // 1. Drain control events first (never dropped)
      while (this.controlQueue.length > 0) {
        const event = this.controlQueue.shift()!;
        this.handleControlEvent(event);
        didWork = true;
      }

      // 2. Process one data event
      const dataEvent = this.dataQueue.shift();
      if (dataEvent) {
        this.handleDataEvent(dataEvent);
        didWork = true;
      }

      // 3. Fallback: timer tick
      this.onTimerTick();

      // Small yield to prevent CPU spinning
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // -----------------------------------------------------------------------
  // Synchronous flush — drains all queued events (test support)
  // -----------------------------------------------------------------------

  /**
   * Synchronously drain all queued events.
   *
   * Processes control events first (all of them), then data events (one at a
   * time, interleaving with control drain between each). Does NOT run the
   * timer tick — use `onTimerTick()` directly if needed.
   */
  flush(): void {
    while (this.controlQueue.length > 0 || this.dataQueue.length > 0) {
      // Drain all control events
      while (this.controlQueue.length > 0) {
        const event = this.controlQueue.shift()!;
        this.handleControlEvent(event);
      }

      // Process one data event
      const dataEvent = this.dataQueue.shift();
      if (dataEvent) {
        this.handleDataEvent(dataEvent);
      }
    }
  }

  /** Read-only snapshot of current sync state. */
  getState(): Readonly<SyncState> {
    return this.state;
  }

  /**
   * Register a callback that fires when the sync machine transitions to the
   * 'synced' phase (peer tip height matches our tip height).
   */
  onSynced(cb: () => void): void {
    this.onSyncedCallbacks.push(cb);
  }

  // -----------------------------------------------------------------------
  // Public events (called by the node layer)
  // -----------------------------------------------------------------------

  /**
   * Called after handshake reveals a peer's tip height.
   *
   * Enqueues a control event — the event loop processes it with top priority.
   */
  onPeerActive(peerId: string, peerHeight: number): void {
    this.controlQueue.push({ type: 'peer-active', peerId, peerHeight });
  }

  /**
   * Dispatch an incoming framed message from a peer.
   *
   * The `body` is the raw CBOR payload (already stripped of the frame
   * envelope by the caller).
   *
   * Routes to control queue (SyncInfo) or data queue (everything else).
   */
  handleMessage(peerId: string, code: number, body: Uint8Array): void {
    switch (code) {
      case MSG_SYNC_INFO:
        this.controlQueue.push({
          type: 'sync-info',
          peerId,
          info: decodeSyncInfo(body),
        });
        break;
      case MSG_INV:
        this.enqueueData({ type: 'inv', peerId, inv: decodeInv(body) });
        break;
      case MSG_MODIFIER_REQUEST:
        this.enqueueData({
          type: 'modifier-request',
          peerId,
          req: decodeModifierRequest(body),
        });
        break;
      case MSG_MODIFIER_RESPONSE:
        this.enqueueData({
          type: 'modifier-response',
          peerId,
          resp: decodeModifierResponse(body),
        });
        break;
      // Unknown message types are silently ignored.
    }
  }

  /**
   * Periodic timer tick.
   *
   * Called by the event loop as lowest-priority fallback. Also called
   * directly by the node's setInterval for the 30 s periodic check.
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
   * Enqueues a control event — processed with top priority.
   */
  onPeerDisconnect(peerId: string): void {
    this.controlQueue.push({ type: 'peer-disconnect', peerId });
  }

  // -----------------------------------------------------------------------
  // Internal — control event handler
  // -----------------------------------------------------------------------

  private handleControlEvent(event: ControlEvent): void {
    switch (event.type) {
      case 'peer-active':
        this.handlePeerActive(event.peerId, event.peerHeight);
        break;
      case 'peer-disconnect':
        this.handlePeerDisconnect(event.peerId);
        break;
      case 'sync-info':
        this.handleSyncInfoMsg(event.peerId, event.info);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — data event handler
  // -----------------------------------------------------------------------

  private handleDataEvent(event: DataEvent): void {
    switch (event.type) {
      case 'inv':
        this.handleInvMsg(event.peerId, event.inv);
        break;
      case 'modifier-request':
        this.handleModifierRequestMsg(event.peerId, event.req);
        break;
      case 'modifier-response':
        this.handleModifierResponseMsg(event.peerId, event.resp);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — data queue enqueue (bounded, lossy)
  // -----------------------------------------------------------------------

  /**
   * Enqueue a data event. If the queue is at capacity, the oldest event is
   * dropped to make room (lossy behavior).
   */
  private enqueueData(event: DataEvent): void {
    if (this.dataQueue.length >= MAX_DATA_QUEUE) {
      // Drop the oldest event to make room
      this.dataQueue.shift();
    }
    this.dataQueue.push(event);
  }

  // -----------------------------------------------------------------------
  // Control event handlers
  // -----------------------------------------------------------------------

  /**
   * Handle a peer becoming active (post-handshake).
   *
   * - If the peer is ahead and we're idle → enter syncing phase.
   * - If the peer is behind → serve them an Inv so they can catch up.
   */
  private handlePeerActive(peerId: string, peerHeight: number): void {
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
   * Handle a peer disconnecting.
   *
   * If the disconnected peer was our sync peer, add it to the stalled set and
   * reset phase so the node can pick a new peer.
   */
  private handlePeerDisconnect(peerId: string): void {
    if (this.state.syncPeerId === peerId) {
      this.state.stalledPeers.add(peerId);
      this.state.syncPeerId = null;
      if (this.state.phase === 'syncing' || this.state.phase === 'synced') {
        this.state.phase = 'idle';
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — message handlers (dispatched from control/data event handlers)
  // -----------------------------------------------------------------------

  /**
   * Process a SyncInfo message from a peer.
   *
   * - Peer ahead + we're idle → start syncing.
   * - Peer behind → serve them an Inv.
   * - Equal height + we were syncing → transition to synced.
   */
  private handleSyncInfoMsg(peerId: string, info: SyncInfo): void {
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
      // Fire sync-complete callbacks
      for (const cb of this.onSyncedCallbacks) {
        try { cb(); } catch (err) {
          console.warn(`[sync-machine] onSynced callback error: ${String(err)}`);
        }
      }
    }
  }

  /**
   * Process an Inv (inventory) message.
   *
   * If we're syncing, request the announced modifiers from our sync peer.
   * Unknown IDs that we already have are filtered before requesting.
   */
  private handleInvMsg(_peerId: string, inv: Inv): void {
    if (this.state.phase !== 'syncing' || !this.state.syncPeerId) return;

    // Filter out IDs we already know about
    const missing = inv.ids.filter((id) => {
      if (inv.typeId === MODIFIER_ORDERING_BLOCK) {
        return !this.store.hasOrderingBlockHeader(id);
      }
      // Unknown modifier types are dropped.
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
  private handleModifierRequestMsg(peerId: string, req: ModifierRequest): void {
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
  private handleModifierResponseMsg(_peerId: string, resp: ModifierResponse): void {
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
