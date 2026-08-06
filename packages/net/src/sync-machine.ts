import type { NetConfig } from './types.js';
import {
  MSG_HANDSHAKE,
  MSG_SYNC_INFO,
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK,
} from './types.js';
import { isHeight, MAX_INV_IDS, MAX_SERVE_BODY_BYTES } from './msg-guards.js';
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

/** 60 seconds without real progress triggers a peer rotation. */
const STALL_TIMEOUT_MS = 60_000;
/**
 * Cap on the total number of outstanding requested modifier ids (audit M-10).
 *
 * New requests are trimmed rather than growing the set past this. One Inv
 * announces at most MAX_INV_IDS ids and responses are byte-capped, so several
 * requested batches can legitimately be in flight at once; four batches keep
 * the worst case around 100 KB of id strings. There is no per-request timer —
 * stall rotation clears the set, so a wedged budget self-heals within one
 * stall window.
 */
const MAX_OUTSTANDING_IDS = 4 * MAX_INV_IDS;
/** Send SyncInfo to sync peer every 30 seconds while active. */
const SYNCED_POLL_INTERVAL_MS = 30_000;
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

  /**
   * Outstanding requested modifier ids, keyed by the peer the request was sent
   * to (audit M-10). A response modifier is accepted only if its id is present
   * under its sender's key — "this sender was sent a request containing this
   * id" — so no peer can push blocks into the store via the sync path
   * unsolicited. Bounded by MAX_OUTSTANDING_IDS across all keys; cleared on
   * peer rotation and on sync-peer disconnect.
   */
  private outstanding = new Map<string, Set<string>>();

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

  /**
   * @param onProtocolViolation Called when a message fails the decode boundary,
   *   so the node layer can penalize the sending peer. Defaults to a no-op for
   *   callers that only want the state machine.
   */
  constructor(
    private config: NetConfig,
    private store: SyncStore,
    private sendToPeer: (peerId: string, data: Uint8Array) => void,
    private requestSubBlocks: (peerId: string, ids: string[]) => Promise<unknown[]>,
    private onProtocolViolation: (peerId: string, reason: string) => void = () => {},
  ) {
    this.magic = config.magic;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the background event loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.eventLoop().catch((err) => {
      // Unreachable while every dispatch is isolated, but if the loop ever does
      // die, clear the flag so `start()` can bring it back instead of being a
      // permanent no-op.
      this.running = false;
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
   *
   * Every dispatch is isolated (see `dispatchControlEvent`) — a throwing
   * handler must degrade one message, never abandon the loop.
   */
  private async eventLoop(): Promise<void> {
    while (this.running) {
      // 1. Drain control events first (never dropped)
      while (this.controlQueue.length > 0) {
        const event = this.controlQueue.shift()!;
        this.dispatchControlEvent(event);
      }

      // 2. Process one data event
      const dataEvent = this.dataQueue.shift();
      if (dataEvent) {
        this.dispatchDataEvent(dataEvent);
      }

      // 3. Fallback: timer tick
      this.dispatchTimerTick();

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
        this.dispatchControlEvent(event);
      }

      // Process one data event
      const dataEvent = this.dataQueue.shift();
      if (dataEvent) {
        this.dispatchDataEvent(dataEvent);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — isolated dispatch
  //
  // A handler that throws must degrade one message, not the subsystem. In the
  // background loop an escaping error rejects the `eventLoop` promise and
  // abandons `while (this.running)` — sync then stays dead until the process
  // restarts. `flush()` shares these helpers so both paths behave the same.
  // -----------------------------------------------------------------------

  private dispatchControlEvent(event: ControlEvent): void {
    try {
      this.handleControlEvent(event);
    } catch (err) {
      console.error(
        `[sync-machine] control event '${event.type}' from ${event.peerId} failed: ${String(err)}`,
      );
    }
  }

  private dispatchDataEvent(event: DataEvent): void {
    try {
      this.handleDataEvent(event);
    } catch (err) {
      console.error(
        `[sync-machine] data event '${event.type}' from ${event.peerId} failed: ${String(err)}`,
      );
    }
  }

  private dispatchTimerTick(): void {
    try {
      this.onTimerTick();
    } catch (err) {
      console.error(`[sync-machine] timer tick failed: ${String(err)}`);
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
   * The height is peer-supplied and feeds `servePeer`, which walks the chain
   * one height at a time — so it is bounds-checked here, at the boundary,
   * before it can reach a loop.
   *
   * Enqueues a control event — the event loop processes it with top priority.
   */
  onPeerActive(peerId: string, peerHeight: number): void {
    if (!isHeight(peerHeight)) {
      this.rejectMessage(peerId, MSG_HANDSHAKE, `advertised height out of range: ${String(peerHeight)}`);
      return;
    }
    this.controlQueue.push({ type: 'peer-active', peerId, peerHeight });
  }

  /**
   * Dispatch an incoming framed message from a peer.
   *
   * The `body` is the raw CBOR payload (already stripped of the frame
   * envelope by the caller).
   *
   * Every body is decoded *and* shape-checked before it is queued: a message
   * that fails the boundary is dropped here and attributed to the sender, so no
   * unvalidated value ever reaches a handler.
   *
   * Shape is not enough on its own — every inbound array is also length-capped
   * here, because each element costs the handler work and the sender chooses how
   * many there are.
   *
   * Routes to control queue (SyncInfo) or data queue (everything else).
   */
  handleMessage(peerId: string, code: number, body: Uint8Array): void {
    switch (code) {
      case MSG_SYNC_INFO: {
        const info = decodeSyncInfo(body);
        if (!info) {
          this.rejectMessage(peerId, code, 'malformed SyncInfo');
          return;
        }
        if (!this.withinCap(peerId, code, 'SyncInfo anchors', info.anchors.length)) return;
        this.controlQueue.push({ type: 'sync-info', peerId, info });
        break;
      }
      case MSG_INV: {
        const inv = decodeInv(body);
        if (!inv) {
          this.rejectMessage(peerId, code, 'malformed Inv');
          return;
        }
        if (!this.withinCap(peerId, code, 'Inv ids', inv.ids.length)) return;
        this.enqueueData({ type: 'inv', peerId, inv });
        break;
      }
      case MSG_MODIFIER_REQUEST: {
        const req = decodeModifierRequest(body);
        if (!req) {
          this.rejectMessage(peerId, code, 'malformed ModifierRequest');
          return;
        }
        if (!this.withinCap(peerId, code, 'ModifierRequest ids', req.ids.length)) return;
        this.enqueueData({ type: 'modifier-request', peerId, req });
        break;
      }
      case MSG_MODIFIER_RESPONSE: {
        const resp = decodeModifierResponse(body);
        if (!resp) {
          this.rejectMessage(peerId, code, 'malformed ModifierResponse');
          return;
        }
        if (!this.withinCap(peerId, code, 'ModifierResponse modifiers', resp.modifiers.length)) {
          return;
        }
        this.enqueueData({ type: 'modifier-response', peerId, resp });
        break;
      }
      // Unknown message types are silently ignored.
    }
  }

  /**
   * Enforce `MAX_INV_IDS` on an inbound array, on receipt.
   *
   * Returns false — and drops + penalizes — when the peer sent more entries than
   * the protocol allows. The check belongs here rather than in the codec: this is
   * the first point that knows *who* sent the message, and an over-cap array is a
   * protocol violation, not a decode failure.
   */
  private withinCap(peerId: string, code: number, label: string, length: number): boolean {
    if (length <= MAX_INV_IDS) return true;
    this.rejectMessage(peerId, code, `${label} exceeds ${MAX_INV_IDS} (got ${length})`);
    return false;
  }

  /**
   * Drop a message that failed the decode boundary and attribute the failure to
   * the peer that sent it.
   */
  private rejectMessage(peerId: string, code: number, reason: string): void {
    console.warn(`[sync-machine] dropping code=${code} from ${peerId}: ${reason}`);
    try {
      this.onProtocolViolation(peerId, reason);
    } catch (err) {
      console.warn(`[sync-machine] onProtocolViolation handler error: ${String(err)}`);
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
      // The sync conversation died with the peer — a response that crosses the
      // disconnect in flight is dropped without penalty by response binding.
      this.outstanding.clear();
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
   * Index every ordering block on our best chain by ID, in a single pass.
   *
   * The store answers ID questions only by height, so asking it once per ID in a
   * message is `O(ids × chainHeight)` — the shape audit H-9 flagged: one message
   * with a long ID list becomes a full-chain scan per ID and freezes the main
   * thread. Building the index once per message makes the same work
   * `O(chainHeight + ids)`, with the per-ID part an O(1) map lookup.
   */
  private blockIdIndex(): Map<string, number> {
    const index = new Map<string, number>();
    const ourHeight = this.store.chainHeight();
    for (let h = 0; h <= ourHeight; h++) {
      const id = this.store.getOrderingBlockId(h);
      if (id !== null) index.set(id, h);
    }
    return index;
  }

  /**
   * Process an Inv (inventory) message.
   *
   * If we're syncing, request the announced modifiers from our sync peer.
   * Only the current sync peer's Invs are honoured (request provenance, audit
   * M-10): a third party's Inv must neither cause requests nor grow the
   * outstanding set. Dropped without penalty — Invs from other peers are
   * legitimate gossip-adjacent noise.
   *
   * IDs we already have, and IDs already outstanding, are filtered before
   * requesting. Every id actually requested is recorded as outstanding for the
   * sync peer; the set never grows past MAX_OUTSTANDING_IDS — the request is
   * trimmed instead.
   */
  private handleInvMsg(peerId: string, inv: Inv): void {
    const syncPeerId = this.state.syncPeerId;
    if (this.state.phase !== 'syncing' || !syncPeerId) return;
    if (peerId !== syncPeerId) return;
    // Unknown modifier types are dropped before any store work is done.
    if (inv.typeId !== MODIFIER_ORDERING_BLOCK) return;

    const known = this.blockIdIndex();
    const requested = this.outstanding.get(syncPeerId);
    // A Set both deduplicates ids repeated within one Inv and preserves
    // announcement order for the trim below.
    const fresh = new Set<string>();
    for (const id of inv.ids) {
      if (known.has(id) || requested?.has(id)) continue;
      fresh.add(id);
    }
    if (fresh.size === 0) return;

    const budget = MAX_OUTSTANDING_IDS - this.outstandingTotal();
    if (budget <= 0) return;
    const ids = [...fresh].slice(0, budget);

    let target = requested;
    if (!target) {
      target = new Set();
      this.outstanding.set(syncPeerId, target);
    }
    for (const id of ids) target.add(id);

    const req: ModifierRequest = { typeId: inv.typeId, ids };
    this.sendToPeer(syncPeerId, encodeModifierRequest(this.magic, req));
  }

  /** Total outstanding requested ids across all request targets. */
  private outstandingTotal(): number {
    let total = 0;
    for (const set of this.outstanding.values()) total += set.size;
    return total;
  }

  /**
   * Process a ModifierRequest from a peer — serve the requested data from
   * our local store.
   *
   * Two bounds apply. The ID list was capped on receipt, and the store is walked
   * once (see `blockIdIndex`) rather than once per ID. The assembled body is also
   * byte-bounded: a response is truncated at `MAX_SERVE_BODY_BYTES` so it always
   * fits inside the requester's stream cap. The first matching block is always
   * included, so an oversized block still moves rather than wedging sync.
   */
  private handleModifierRequestMsg(peerId: string, req: ModifierRequest): void {
    // We serve ordering blocks only. Sub-block serving uses a separate protocol
    // stream (see sync.ts).
    if (req.typeId !== MODIFIER_ORDERING_BLOCK) return;

    const heightOf = this.blockIdIndex();
    const modifiers: { id: string; data: Uint8Array }[] = [];
    let bodyBytes = 0;

    for (const id of req.ids) {
      const height = heightOf.get(id);
      if (height === undefined) continue;
      const data = this.store.serializeOrderingBlock(height);
      if (!data) continue;
      if (modifiers.length > 0 && bodyBytes + data.length > MAX_SERVE_BODY_BYTES) break;
      bodyBytes += data.length;
      modifiers.push({ id, data });
    }

    if (modifiers.length > 0) {
      const resp: ModifierResponse = { typeId: req.typeId, modifiers };
      this.sendToPeer(peerId, encodeModifierResponse(this.magic, resp));
    }
  }

  /**
   * Process a ModifierResponse — apply received blocks to the store.
   *
   * Response binding (audit M-10): a modifier is accepted only if its id is
   * still outstanding for THIS sender, i.e. it answers a ModifierRequest we
   * previously sent to that same peer. Anything else — a response from a peer
   * we never asked, or ids we never requested — is dropped without penalty: a
   * response can legitimately cross a peer rotation in flight. Partial
   * responses are normal (the serve side truncates at MAX_SERVE_BODY_BYTES);
   * unanswered ids stay outstanding for a later response.
   */
  private handleModifierResponseMsg(peerId: string, resp: ModifierResponse): void {
    if (resp.modifiers.length === 0) return;
    // We only ever request ordering blocks, so a response of any other type
    // answers nothing and must not consume outstanding ids.
    if (resp.typeId !== MODIFIER_ORDERING_BLOCK) return;

    const requested = this.outstanding.get(peerId);
    if (!requested || requested.size === 0) return;

    const blocks: unknown[] = [];
    for (const mod of resp.modifiers) {
      // Unsolicited and already-consumed ids are dropped; a duplicate id
      // within one response processes once (the first occurrence consumes it).
      if (!requested.has(mod.id)) continue;
      // An empty payload answers nothing — the id stays outstanding so a
      // later response can still deliver it; a peer abusing this makes no
      // progress and stalls out.
      if (mod.data.length === 0) continue;
      requested.delete(mod.id);
      blocks.push(mod.data);
    }
    if (requested.size === 0) this.outstanding.delete(peerId);
    if (blocks.length === 0) return;

    const heightBefore = this.store.chainHeight();
    this.store.appendBlocks(blocks);
    const newHeight = this.store.chainHeight();

    // Stall progress = chain height (audit M-10): the stall clock advances
    // only when applying a response strictly increased the chain — junk and
    // already-known blocks leave it untouched, so a peer feeding non-advancing
    // responses is rotated away within one stall window.
    if (newHeight > heightBefore) {
      this.lastProgressMs = Date.now();
    }

    this.state.downloadedHeight = Math.max(
      this.state.downloadedHeight,
      newHeight,
    );
    this.state.stateAppliedHeight = Math.max(
      this.state.stateAppliedHeight,
      newHeight,
    );
  }

  // -----------------------------------------------------------------------
  // Internal — serving
  // -----------------------------------------------------------------------

  /**
   * Serve a peer that is behind us by sending an Inv with continuation
   * from their height.
   *
   * Capped at MAX_INV_IDS to avoid oversized messages.
   *
   * Precondition: `peerHeight` has passed `isHeight`. Both callers take it from
   * a bounds-checked boundary (`onPeerActive`, `decodeSyncInfo`) — the loop
   * below reads the store once per height, so a negative value here would scan
   * ~10⁹ heights on the main thread.
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
    // Rotation ends the sync conversation: outstanding ids are void. A late
    // response that crosses the rotation is dropped without penalty by
    // response binding.
    this.outstanding.clear();
  }
}
