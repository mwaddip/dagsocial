import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
import { encode } from 'cbor-x';

import type { Libp2p } from 'libp2p';
import type { SubBlock, OrderingBlock, UtxoTransaction, BlockHeader, Stump } from '@dagsocial/types';
import { PROTOCOL_VERSION, encodeSubBlock, decodeSubBlock, encodeOrderingBlock, decodeOrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { ReaderError } from '@dagsocial/wire';
import type { NetConfig, NetValidators, Peer, PeerRecord, PeerEntryMsg, PostsMsg, PostsEntry, StumpsEntry, StumpsMsg } from './types.js';
import { PeerState, PenaltyKind } from './types.js';
import type { Libp2pGossip, GossipHandlers } from './gossip.js';
import { PeerManager } from './peer-mgr.js';
import { subscribeTopics, broadcastSubBlock, broadcastOrderingBlock, broadcastTx, broadcastStump } from './gossip.js';
import {
  SYNC_PROTOCOL,
  HEADERS_PROTOCOL,
  requestSubBlock,
  requestHeaders,
  requestBlocks,
} from './sync.js';
import {
  encodeGetPeers,
  decodeGetPeers,
  encodePeers,
  decodePeers,
  encodeGetPosts,
  decodeGetPosts,
  encodePosts,
  decodePosts,
  encodeGetStumps,
  decodeGetStumps,
  encodeStumps,
  decodeStumps,
  decodeLegacyHeadersRequest,
} from './sync-codec.js';
import { isBogusAddress } from './bogus-addr.js';
import { readStreamBounded } from './util.js';
import { MAX_STREAM_BYTES } from './msg-guards.js';
import { PeerDb } from './peerdb.js';
import { SyncMachine } from './sync-machine.js';
import type { SyncStore } from './sync-machine.js';
import { OutboundManager } from './outbound-mgr.js';
import { encodeFrame, decodeFrame, MAGIC_MAINNET, MAGIC_TESTNET } from './frame.js';
import {
  buildHandshakeFrame,
  handshakePenalty,
  parseHandshakeBody,
  validateHandshake,
} from './handshake.js';
import type { HandshakeResult } from './handshake.js';
import {
  MSG_GET_SUB_BLOCK,
  MSG_SUB_BLOCK_RESPONSE,
  MSG_GET_PEERS,
  MSG_PEERS,
  MSG_GET_POSTS,
  MSG_POSTS,
  MSG_GET_STUMPS,
  MSG_STUMPS,
} from './types.js';

type SubBlockCallback = (sb: SubBlock) => void;
type OrderingBlockCallback = (block: OrderingBlock) => void;
type TxCallback = (tx: UtxoTransaction) => void;

/**
 * Return the libp2p node cast to the Libp2pGossip interface expected by the
 * gossip module.  The createLibp2p call configures gossipsub as a service so
 * the runtime shape is correct; this cast bridges the gap between the concrete
 * libp2p generic and the structural interface gossip.ts uses.
 */
function asGossip(libp2p: Libp2p): Libp2pGossip {
  return libp2p as unknown as Libp2pGossip;
}

/**
 * Lazy adapter implementing SyncStore by delegating to functions that are set
 * after construction (via setSyncHandler / setHeadersHandler).
 */
class LazySyncStore implements SyncStore {
  private _getOrderingBlock: ((height: number) => unknown | null) | null = null;
  private _getSubBlock: ((id: string) => unknown | null) | null = null;
  private _blocksHandler: ((block: OrderingBlock) => void) | null = null;

  setOrderingBlockFn(fn: (height: number) => unknown | null): void {
    this._getOrderingBlock = fn;
  }

  setSubBlockFn(fn: (id: string) => unknown | null): void {
    this._getSubBlock = fn;
  }

  setBlocksHandler(fn: (block: OrderingBlock) => void): void {
    this._blocksHandler = fn;
  }

  getOrderingBlock(height: number): unknown | null {
    return this._getOrderingBlock?.(height) ?? null;
  }

  serializeOrderingBlock(height: number): Uint8Array | null {
    const block = this._getOrderingBlock?.(height);
    if (!block) return null;
    return encodeOrderingBlock(block as import('@dagsocial/types').OrderingBlock);
  }

  getOrderingBlockHeader(height: number): unknown | null {
    const block = this._getOrderingBlock?.(height);
    if (block && typeof block === 'object' && 'header' in block) {
      return (block as { header: unknown }).header;
    }
    return null;
  }

  getOrderingBlockId(height: number): string | null {
    const block = this._getOrderingBlock?.(height);
    if (block && typeof block === 'object' && 'header' in block) {
      const header = (block as { header: unknown }).header;
      if (header && typeof header === 'object') {
        try {
          return blockHash(header as Parameters<typeof blockHash>[0]);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  getSubBlock(id: string): unknown | null {
    return this._getSubBlock?.(id) ?? null;
  }

  chainHeight(): number {
    if (!this._getOrderingBlock) return 0;
    // Walk up from 1 until we find a gap
    let h = 1;
    while (this._getOrderingBlock(h)) h++;
    return h - 1;
  }

  cumulativeWork(): bigint {
    if (!this._getOrderingBlock) return 0n;
    let work = 0n;
    const h = this.chainHeight();
    for (let i = 1; i <= h; i++) {
      const block = this._getOrderingBlock(i);
      if (block && typeof block === 'object' && 'header' in block) {
        const header = (block as { header: Record<string, unknown> }).header;
        if (typeof header['powTargetBits'] === 'number') {
          work += 1n << BigInt(header['powTargetBits']);
        }
      }
    }
    return work;
  }

  getAnchors(): { height: number; blockId: string }[] {
    if (!this._getOrderingBlock) return [];
    const h = this.chainHeight();
    if (h < 1) return [];
    const anchors: { height: number; blockId: string }[] = [];
    const seen = new Set<number>();
    for (const candidate of [h, h - 16, h - 128, h - 512]) {
      if (candidate < 1) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const id = this.getOrderingBlockId(candidate);
      if (id) anchors.push({ height: candidate, blockId: id });
    }
    return anchors;
  }

  appendHeaders(_headers: unknown[]): void {
    // Mutations are handled by the node layer directly via applyOrderingBlock.
    // The sync machine may call this; it's a no-op here because the node layer
    // owns persistence.
  }

  appendBlocks(_blocks: unknown[]): void {
    if (!this._blocksHandler) return;
    for (const raw of _blocks) {
      if (!(raw instanceof Uint8Array)) continue;
      try {
        const block = decodeOrderingBlock(raw);
        this._blocksHandler(block);
      } catch (err) {
        console.warn(`[net] appendBlocks: failed to decode block: ${String(err)}`);
      }
    }
  }

  setValidatedHeight(_height: number): void {
    // Node layer tracks validation state.
  }

  flush(): void {
    // Node layer flushes via its own DB lifecycle.
  }
}

// ---------------------------------------------------------------------------
// Peer exchange (GetPeers / Peers — NET_INTERFACE → Peer Discovery)
//
// The serve, intake, and cadence decisions live in module-level functions so
// the tests drive the same code the stream handler and timer call — not a
// copy. The stream plumbing around them is exercised by the integration suite.
// ---------------------------------------------------------------------------

/** Cadence for sending GetPeers to each Active peer. */
export const GET_PEERS_INTERVAL_MS = 120_000;

/** Most entries served in one Peers response ("up to 8"). */
export const GET_PEERS_RESPONSE_LIMIT = 8;

/**
 * Serve one GetPeers request body: reply with up to GET_PEERS_RESPONSE_LIMIT
 * recently-seen PeerDb entries, excluding the requester's own address. Returns
 * the framed Peers response — `{ peers: [] }` when PeerDb has nothing, so the
 * requester is answered rather than left to time out — or `null` for a
 * malformed request, which is a protocol violation (permanent ban).
 *
 * Discovery is served whatever our own sync phase is: nothing here consults
 * the sync machine.
 */
export function servePeersBody(
  body: Uint8Array,
  deps: {
    peerDb: PeerDb | null;
    peerMgr: PeerManager;
    peerId: string;
    requesterAddr: string | null;
    magic: number;
  },
): Uint8Array | null {
  const request = decodeGetPeers(body);
  if (!request) {
    console.warn(`[net] malformed GetPeers from ${deps.peerId}, dropping`);
    deps.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, deps.peerId, 'malformed GetPeers');
    return null;
  }
  const exclude = new Set<string>();
  if (deps.requesterAddr !== null) exclude.add(deps.requesterAddr);
  const records = deps.peerDb?.recent(GET_PEERS_RESPONSE_LIMIT, exclude) ?? [];
  const peers: PeerEntryMsg[] = records.map((r) => ({
    address: r.address,
    agentName: r.agentName,
    nodeName: r.nodeName,
    protocolVersion: r.protocolVersion,
    capabilities: r.capabilities,
  }));
  return encodePeers(deps.magic, { peers });
}

/**
 * Intake one Peers response body into PeerDb, stamping every recorded entry
 * with `nowMs` — the sender's opinion of when a peer was last seen is hearsay
 * and never travels on the wire.
 *
 * A body that fails decode (malformed, or over the 64-entry cap) permanently
 * bans the sender. A bogus address inside a valid body is dropped silently
 * with NO penalty — a NAT'd peer advertising its private address is normal
 * operation, not misbehavior. Self and banned addresses are refused by
 * `PeerDb.record` itself.
 *
 * Returns the number of entries handed to PeerDb, or `null` when the body was
 * malformed.
 */
export function intakePeersBody(
  body: Uint8Array,
  deps: {
    peerDb: PeerDb | null;
    peerMgr: PeerManager;
    peerId: string;
    magic: number;
    nowMs: number;
  },
): number | null {
  const msg = decodePeers(body);
  if (!msg) {
    console.warn(`[net] malformed Peers from ${deps.peerId}, banning`);
    deps.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, deps.peerId, 'malformed Peers response');
    return null;
  }
  let usable = 0;
  for (const e of msg.peers) {
    if (isBogusAddress(e.address, deps.magic)) continue;
    deps.peerDb?.record({
      address: e.address,
      lastSeenMs: deps.nowMs,
      agentName: e.agentName,
      nodeName: e.nodeName,
      protocolVersion: e.protocolVersion,
      capabilities: e.capabilities,
    });
    usable++;
  }
  return usable;
}

/**
 * Which peers are due a GetPeers this tick: Active state, and no send within
 * the last GET_PEERS_INTERVAL_MS. Stamps `lastSentMs` for every returned id,
 * so a peer is never picked twice inside one interval. A peer with no stamp
 * (fresh handshake) is due immediately — the bootstrap flow sends GetPeers
 * right after handshake, not two minutes later.
 */
export function duePeerExchange(
  peerMgr: PeerManager,
  lastSentMs: Map<string, number>,
  nowMs: number,
): string[] {
  const due: string[] = [];
  for (const peer of peerMgr.getPeers()) {
    if (!peerMgr.isPeerActive(peer.id)) continue;
    const last = lastSentMs.get(peer.id);
    if (last !== undefined && nowMs - last < GET_PEERS_INTERVAL_MS) continue;
    lastSentMs.set(peer.id, nowMs);
    due.push(peer.id);
  }
  return due;
}

export class NetNode {
  private libp2p: Libp2p | null = null;
  private peerMgr: PeerManager;
  private config: NetConfig;
  private validators: NetValidators;
  private subBlockHandlers: SubBlockCallback[] = [];
  private orderingBlockHandlers: OrderingBlockCallback[] = [];
  private txHandlers: TxCallback[] = [];
  private stumpHandlers: Array<(stump: Stump) => void> = [];
  private started = false;

  // New sync infrastructure
  private peerDb: PeerDb | null = null;
  private syncMachine: SyncMachine | null = null;
  private outboundMgr: OutboundManager | null = null;
  private syncStore: LazySyncStore = new LazySyncStore();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeHandlerRegistered = false;
  private syncHandlerRegistered = false;
  private headersHandlerRegistered = false;
  private postsHandler: ((postIds: string[]) => PostsEntry[]) | null = null;
  private stumpsHandler: ((stumpIds: string[]) => StumpsEntry[]) | null = null;
  private syncCompleteHandlers: Array<() => void> = [];
  private peerActiveHandlers: Array<(peerId: string) => void> = [];
  private pendingBootstrapDials: Set<string> = new Set();
  private lastGetPeersSentMs: Map<string, number> = new Map();

  constructor(config: NetConfig, validators: NetValidators) {
    this.config = config;
    this.validators = validators;
    // Ban hooks late-bind this.peerDb: it is created in start(), and the
    // closures read it at call time, so bans imposed before start (or after
    // stop) simply have no address surface to propagate to.
    this.peerMgr = new PeerManager(config, {
      onBan: (address) => this.peerDb?.ban(address),
      onUnban: (address) => this.peerDb?.unban(address),
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;

    // createLibp2p options cast to `any` works around @libp2p/interface version
    // mismatches in the dependency tree (v1.7, v2.11, v3.2 coexist).  The
    // runtime behaviour is correct; only the static types disagree.
    this.libp2p = await createLibp2p({
      addresses: {
        listen: [this.config.listenAddrs],
      },
      transports: [tcp()],
      connectionEncryption: [noise()],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamMuxers: [yamux() as any],
      services: {
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
        }),
        identify: identify(),
        ping: ping(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      connectionManager: {
        maxConnections: this.config.maxPeers,
        minConnections: 0,
      },
      // Disable the built-in connection monitor heartbeat.  When enabled it
      // pings peers every 10 s via /ipfs/ping/1.0.0 and aborts the connection
      // if the ping fails.  The AdaptiveTimeout uses a 2 s floor derived from
      // an uninitialised moving average, so the first heartbeat almost always
      // times out and kills the connection.  Explicit pings are still available
      // via @libp2p/ping if needed.
      connectionMonitor: {
        enabled: false,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Create PeerDb with self-address filtering
    const listenAddrs = this.libp2p.getMultiaddrs();
    const selfAddrs = listenAddrs.map(a => a.toString());
    this.peerDb = new PeerDb(null, this.config.peerDbCap ?? 1000, selfAddrs);

    // Create SyncMachine with lazy store bridge
    const magic = this.config.magic ?? MAGIC_MAINNET;
    this.syncMachine = new SyncMachine(
      this.config,
      this.syncStore,
      (peerId: string, data: Uint8Array) => this.sendToPeer(peerId, data),
      async (peerId: string, ids: string[]) => this.requestSubBlocksFn(peerId, ids),
      (peerId: string, reason: string) => {
        this.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, reason);
      },
    );
    this.syncMachine.start();

    // Wire sync-complete callback: when the sync machine reaches 'synced',
    // fire all registered onSyncComplete handlers.
    this.syncMachine.onSynced(() => {
      for (const cb of this.syncCompleteHandlers) {
        try { cb(); } catch (err) {
          console.warn(`[net] syncComplete handler error: ${String(err)}`);
        }
      }
    });

    // Create OutboundManager
    this.outboundMgr = new OutboundManager(this.config, this.peerDb);

    // Register handshake stream handler
    this.registerHandshakeHandler();

    // Register sync stream handler (framed protocol)
    this.registerSyncStreamHandler();

    // Track peers on connect/disconnect.
    // Listen for all four event types because the timing and payload differ:
    //   connection:open  — fires first, has full Connection object (addr, direction)
    //   peer:connect     — fires after, only has PeerId
    //   connection:close — fires first, has full Connection object + timeline
    //   peer:disconnect  — fires after, only has PeerId
    this.libp2p.addEventListener('connection:open', (evt: any) => {
      const conn = evt.detail;
      const peerId = conn?.remotePeer?.toString() ?? 'unknown';
      const direction = conn?.direction ?? '?';
      console.log(`[net] connection:open peer=${peerId} dir=${direction}`);
    });

    this.libp2p.addEventListener('peer:connect', (evt: any) => {
      const peerId = evt.detail?.toString() ?? 'unknown';
      console.log(`[net] peer:connect ${peerId} (total=${this.peerMgr.getPeerCount() + 1})`);
      this.peerMgr.addPeer({
        id: peerId,
        multiaddrs: [],
        protocols: [],
        connectedAt: Date.now(),
      });
    });

    this.libp2p.addEventListener('connection:close', (evt: any) => {
      const conn = evt.detail;
      const peerId = conn?.remotePeer?.toString() ?? 'unknown';
      const remoteAddr = conn?.remoteAddr?.toString() ?? '?';
      const direction = conn?.direction ?? '?';
      const timeline = conn?.timeline;
      const openTs = timeline?.open ? new Date(timeline.open).toISOString() : '?';
      const closeTs = timeline?.close ? new Date(timeline.close).toISOString() : '?';
      const durationMs = (timeline?.close && timeline?.open)
        ? timeline.close - timeline.open
        : '?';
      console.log(`[net] connection:close peer=${peerId} addr=${remoteAddr} dir=${direction} durationMs=${durationMs} opened=${openTs} closed=${closeTs}`);
    });

    this.libp2p.addEventListener('peer:disconnect', (evt: any) => {
      const peerId = evt.detail?.toString() ?? 'unknown';
      console.log(`[net] peer:disconnect ${peerId} (total=${Math.max(0, this.peerMgr.getPeerCount() - 1)})`);
      this.peerMgr.removePeer(peerId);
      this.lastGetPeersSentMs.delete(peerId);
      this.syncMachine?.onPeerDisconnect(peerId);
    });

    // Log identify completion — confirms the connection was fully upgraded
    this.libp2p.addEventListener('peer:identify', (evt: any) => {
      const result = evt.detail;
      const peerId = result?.peerId?.toString() ?? '?';
      console.log(`[net] peer:identify ${peerId}`);
    });

    // Subscribe to gossip topics
    const handlers: GossipHandlers = {
      onSubBlock: (sb) => { for (const cb of this.subBlockHandlers) cb(sb); },
      onOrderingBlock: (block) => { for (const cb of this.orderingBlockHandlers) cb(block); },
      onTx: (tx) => { for (const cb of this.txHandlers) cb(tx); },
      onStump: (stump) => {
        for (const cb of this.stumpHandlers) { try { cb(stump); } catch {} }
      },
    };

    await subscribeTopics(asGossip(this.libp2p), this.validators, this.peerMgr, handlers);

    // Log listen addresses
    console.log(`[net] listening on: ${listenAddrs.map(a => a.toString()).join(', ')}`);

    // Connect to bootstrap peers (awaited — must complete before caller
    // registers blocksHandler so the initial sync burst isn't dropped).
    for (const addr of this.config.bootstrapPeers) {
      await this.dialBootstrapPeer(addr);
    }

    // Start periodic timer: sync machine tick + outbound manager
    this.syncTimer = setInterval(() => {
      this.syncMachine?.onTimerTick();
      if (this.libp2p && this.outboundMgr) {
        // Both phases count outbound connections only — inbound connections
        // filling our slots must never suppress our own dialing (eclipse
        // setup). planTick also feeds the connected addresses into the fill
        // phase's exclude set.
        const plan = this.outboundMgr.planTick(this.libp2p.getConnections());

        // Floor phase: re-dial bootstrap peers while outbound < minPeers.
        if (plan.dialBootstrap) {
          for (const addr of this.config.bootstrapPeers) {
            this.dialBootstrapPeer(addr);
          }
        }

        // Fill phase: dial one PeerDb candidate per tick
        const candidate = plan.candidate;
        if (candidate) {
          console.log(`[net] outbound manager dialing: ${candidate}`);
          this.libp2p.dial(multiaddr(candidate)).then((conn) => {
            console.log(`[net] outbound dial succeeded: ${candidate} -> peer=${conn.remotePeer.toString()}`);
            this.outboundMgr?.recordDialResult(candidate, true);
          }).catch((err: any) => {
            console.warn(`[net] outbound dial FAILED: ${candidate} — ${err?.message ?? err}`);
            this.outboundMgr?.recordDialResult(candidate, false);
          });
        }
      }

      // Peer discovery cadence: GetPeers to each Active peer every
      // GET_PEERS_INTERVAL_MS, riding this tick rather than a second timer.
      if (this.libp2p) {
        for (const peerId of duePeerExchange(this.peerMgr, this.lastGetPeersSentMs, Date.now())) {
          this.requestPeers(peerId);
        }
      }
    }, 30_000);

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || !this.libp2p) return;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingBootstrapDials.clear();
    this.lastGetPeersSentMs.clear();
    await this.libp2p.stop();
    this.libp2p = null;
    this.peerDb = null;
    this.syncMachine?.stop();
    this.syncMachine = null;
    this.outboundMgr = null;
    this.started = false;
  }

  /**
   * Dial a bootstrap peer (or any multiaddr), run the outbound handshake,
   * and notify the sync machine + peer-active callbacks on success.
   *
   * Returns a Promise that resolves to `true` when the handshake succeeds,
   * `false` otherwise.  Safe to call from the periodic timer without
   * awaiting — concurrent dials to the same address are deduplicated via
   * `pendingBootstrapDials`.
   */
  private async dialBootstrapPeer(addr: string): Promise<boolean> {
    if (!this.libp2p || !this.outboundMgr) return false;
    if (this.pendingBootstrapDials.has(addr)) return false;
    this.pendingBootstrapDials.add(addr);

    console.log(`[net] dialing bootstrap peer: ${addr}`);
    try {
      const conn = await this.libp2p.dial(multiaddr(addr));
      this.pendingBootstrapDials.delete(addr);
      console.log(`[net] bootstrap dial succeeded: ${addr} -> peer=${conn.remotePeer.toString()}`);

      try {
        const result = await this.runOutboundHandshake(conn.remotePeer.toString());
        if (result.ok) {
          this.peerMgr.setPeerState(conn.remotePeer.toString(), PeerState.Active);
          this.peerMgr.setPeerAddress(conn.remotePeer.toString(), addr);
          this.peerDb?.record({
            address: addr,
            lastSeenMs: Date.now(),
            agentName: 'bootstrap',
            nodeName: '',
            protocolVersion: PROTOCOL_VERSION,
            capabilities: result.peerCapabilities,
          });
          this.syncMachine?.onPeerActive(conn.remotePeer.toString(), result.peerHeight);
          for (const cb of this.peerActiveHandlers) {
            try { cb(conn.remotePeer.toString()); } catch (err) {
              console.warn(`[net] peerActive handler error: ${String(err)}`);
            }
          }
          return true;
        }
        return false;
      } catch (handshakeErr: any) {
        console.warn(`[net] handshake with bootstrap peer ${addr} failed: ${handshakeErr?.message ?? handshakeErr}`);
        return false;
      }
    } catch (err: any) {
      this.pendingBootstrapDials.delete(addr);
      console.warn(`[net] bootstrap dial FAILED: ${addr} — ${err?.message ?? err}`);
      this.outboundMgr?.recordDialResult(addr, false);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Handshake — inbound handler registration
  // -----------------------------------------------------------------------

  private registerHandshakeHandler(): void {
    if (this.handshakeHandlerRegistered || !this.libp2p) return;
    const libp2p = this.libp2p;
    const magic = this.config.magic ?? MAGIC_MAINNET;

    libp2p.handle('/dagsocial/handshake/1', async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      try {
        const data = await readStreamBounded(stream.source);
        if (data === null) {
          console.warn(`[net] handshake stream from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
          this.peerMgr.recordPenaltyKind(
            PenaltyKind.ProtocolViolation,
            peerId,
            'handshake stream exceeds byte cap',
          );
          await stream.sink([new Uint8Array(0)]);
          return;
        }
        if (data.length === 0) {
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        let body: Uint8Array;
        try {
          const framed = decodeFrame(magic, data);
          body = framed.body;
        } catch (err) {
          if (err instanceof ReaderError && err.message.includes('wrong magic')) {
            // Wrong network — reject, don't fall through to raw CBOR
            await stream.sink([new Uint8Array(0)]);
            return;
          }
          // Older peers may send raw CBOR without frame
          body = data;
        }

        const result = validateHandshake(parseHandshakeBody(body), [PROTOCOL_VERSION]);
        if (!result.ok || !result.msg) {
          // Contract: the stream closes either way, but the ban does not —
          // malformed input is banned permanently, an unsupported version is
          // only cooled down (see `handshakePenalty`).
          console.warn(`[net] inbound handshake from ${peerId} rejected: ${result.error}`);
          this.peerMgr.recordPenaltyKind(
            handshakePenalty(result.rejection),
            peerId,
            `handshake: ${result.error}`,
          );
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        const msg = result.msg;
        console.log(`[net] inbound handshake from ${peerId}: ok=true height=${msg.chainHeight}`);

        const addr = msg.declaredAddress ?? connection.remoteAddr?.toString() ?? peerId;
        this.peerMgr.setPeerAddress(peerId, addr);
        this.peerDb?.record({
          address: addr,
          lastSeenMs: Date.now(),
          agentName: msg.agentName,
          nodeName: msg.nodeName,
          protocolVersion: msg.protocolVersion,
          capabilities: msg.capabilities,
        });

        this.peerMgr.setPeerState(peerId, PeerState.Active);
        this.syncMachine?.onPeerActive(peerId, result.peerHeight);
        for (const cb of this.peerActiveHandlers) {
          try { cb(peerId); } catch (err) {
            console.warn(`[net] peerActive handler error: ${String(err)}`);
          }
        }

        // Send our handshake in response
        const ourMsg = this.buildOurHandshake();
        const response = buildHandshakeFrame(magic, ourMsg);
        await stream.sink([response]);
      } catch (err: any) {
        // Handshake failed — close silently
        try { await stream.sink([new Uint8Array(0)]); } catch { /* ignore */ }
      }
    });

    this.handshakeHandlerRegistered = true;
  }

  // -----------------------------------------------------------------------
  // Sync stream handler — framed protocol
  // -----------------------------------------------------------------------

  private registerSyncStreamHandler(): void {
    if (this.syncHandlerRegistered || !this.libp2p) return;
    const libp2p = this.libp2p;
    const magic = this.config.magic ?? MAGIC_MAINNET;

    libp2p.handle(SYNC_PROTOCOL, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();

      // Drop messages from peers that are not in Active state
      if (!this.peerMgr.isPeerActive(peerId)) {
        try { await stream.sink([new Uint8Array(0)]); } catch { /* ignore */ }
        return;
      }

      try {
        const data = await readStreamBounded(stream.source);
        if (data === null) {
          console.warn(`[net] sync stream from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
          this.peerMgr.recordPenaltyKind(
            PenaltyKind.ProtocolViolation,
            peerId,
            'sync stream exceeds byte cap',
          );
          await stream.sink([new Uint8Array(0)]);
          return;
        }
        if (data.length === 0) {
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        // Try framed decode first
        let code: number;
        let body: Uint8Array;
        try {
          const framed = decodeFrame(magic, data);
          code = framed.code;
          body = framed.body;
        } catch {
          // Legacy text protocol: subBlockId as hex
          const request = new TextDecoder().decode(data);
          const subBlock = this.syncStore.getSubBlock(request);
          if (!subBlock) {
            await stream.sink([new Uint8Array([0x00])]);
            return;
          }
          await stream.sink([encodeSubBlock(subBlock as SubBlock)]);
          return;
        }

        // Handle framed sub-block requests (MSG_GET_SUB_BLOCK)
        if (code === MSG_GET_SUB_BLOCK) {
          const id = new TextDecoder().decode(body);
          const subBlock = this.syncStore.getSubBlock(id);
          if (subBlock) {
            const respBody = encodeSubBlock(subBlock as SubBlock);
            const frame = encodeFrame(magic, MSG_SUB_BLOCK_RESPONSE, respBody);
            await stream.sink([frame]);
          } else {
            await stream.sink([encodeFrame(magic, MSG_SUB_BLOCK_RESPONSE, new Uint8Array([0x00]))]);
          }
          return;
        }

        // Handle peer discovery requests (MSG_GET_PEERS). No registered
        // handler callback — PeerDb is internal to net. Served whatever our
        // sync phase is; an empty PeerDb still answers { peers: [] }.
        if (code === MSG_GET_PEERS) {
          // Prefer the requester's declared address: an inbound connection's
          // remoteAddr carries an ephemeral source port, which would make the
          // requester-exclusion in servePeersBody a no-op.
          const response = servePeersBody(body, {
            peerDb: this.peerDb,
            peerMgr: this.peerMgr,
            peerId,
            requesterAddr: this.peerMgr.getPeerMetadata(peerId)?.address
              ?? connection.remoteAddr?.toString()
              ?? null,
            magic,
          });
          if (response) await stream.sink([response]);
          return;
        }

        // Handle post requests (MSG_GET_POSTS)
        if (code === MSG_GET_POSTS) {
          if (!this.postsHandler) {
            // No handler registered — silently ignore (peer will time out)
            return;
          }
          const request = decodeGetPosts(body);
          if (!request) {
            console.warn(`[net] malformed GetPosts from ${peerId}, dropping`);
            this.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, 'malformed GetPosts');
            return;
          }
          if (request.postIds.length > 100) {
            console.warn(`[net] GetPosts request with ${request.postIds.length} IDs exceeds limit, dropping`);
            return;
          }
          const entries = this.postsHandler(request.postIds);
          const response = encodePosts(this.config.magic ?? MAGIC_MAINNET, { entries });
          await stream.sink([response]);
          return;
        }

        // Handle stump requests (MSG_GET_STUMPS)
        if (code === MSG_GET_STUMPS) {
          if (!this.stumpsHandler) {
            // No handler registered — silently ignore (peer will time out)
            return;
          }
          const request = decodeGetStumps(body);
          if (!request) {
            console.warn(`[net] malformed GetStumps from ${peerId}, dropping`);
            this.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, 'malformed GetStumps');
            return;
          }
          if (request.stumpIds.length > 100) {
            console.warn(`[net] GetStumps request with ${request.stumpIds.length} IDs exceeds limit, dropping`);
            return;
          }
          const entries = this.stumpsHandler(request.stumpIds);
          const response = encodeStumps(this.config.magic ?? MAGIC_MAINNET, { entries });
          await stream.sink([response]);
          return;
        }

        // Dispatch to sync machine for all other message types
        console.log(`[net] sync handler: received code=${code} body_len=${body.length} from ${peerId}`);
        this.syncMachine?.handleMessage(peerId, code, body);
      } catch {
        try { await stream.sink([new Uint8Array(0)]); } catch { /* ignore */ }
      }
    });

    this.syncHandlerRegistered = true;
  }

  // -----------------------------------------------------------------------
  // Handshake — outbound
  // -----------------------------------------------------------------------

  private buildOurHandshake(): import('./handshake.js').HandshakeMsg {
    const listenAddrs = this.libp2p?.getMultiaddrs() ?? [];
    return {
      agentName: 'dagsocial',
      protocolVersion: PROTOCOL_VERSION,
      nodeName: this.peerId().slice(0, 12),
      chainHeight: this.syncStore.chainHeight(),
      declaredAddress: listenAddrs[0]?.toString(),
      capabilities: [],
      sessionMagic: Math.floor(Math.random() * 0x100000000),
    };
  }

  private async runOutboundHandshake(peerId: string): Promise<HandshakeResult> {
    if (!this.libp2p) throw new Error('Not started');
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) throw new Error(`Peer ${peerId} not connected`);

    const magic = this.config.magic ?? MAGIC_MAINNET;

    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, '/dagsocial/handshake/1', {
        signal: AbortSignal.timeout(this.config.syncRequestTimeoutMs),
      });

      // Send our handshake
      const ourMsg = this.buildOurHandshake();
      await stream.sink([buildHandshakeFrame(magic, ourMsg)]);

      // Read their response
      const data = await readStreamBounded(stream.source);
      if (data === null) {
        console.warn(`[net] handshake response from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
        this.peerMgr.recordPenaltyKind(
          PenaltyKind.ProtocolViolation,
          peerId,
          'handshake stream exceeds byte cap',
        );
        return {
          ok: false,
          error: 'handshake response exceeds byte cap',
          rejection: 'malformed',
          peerHeight: 0,
          peerCapabilities: [],
        };
      }

      if (data.length === 0) {
        return { ok: false, error: 'empty handshake response', peerHeight: 0, peerCapabilities: [] };
      }

      let body: Uint8Array;
      try {
        const framed = decodeFrame(magic, data);
        body = framed.body;
      } catch {
        body = data;
      }

      const result = validateHandshake(parseHandshakeBody(body), [PROTOCOL_VERSION]);
      if (!result.ok) {
        console.warn(`[net] outbound handshake with ${peerId} rejected: ${result.error}`);
        this.peerMgr.recordPenaltyKind(
          handshakePenalty(result.rejection),
          peerId,
          `handshake: ${result.error}`,
        );
        return result;
      }
      console.log(`[net] outbound handshake with ${peerId}: ok=true height=${result.peerHeight} caps=${result.peerCapabilities.length}`);
      return result;
    } finally {
      if (stream) await stream.close();
    }
  }

  // -----------------------------------------------------------------------
  // Sync helpers
  // -----------------------------------------------------------------------

  private sendToPeer(peerId: string, data: Uint8Array): void {
    if (!this.libp2p) return;
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] sendToPeer: peer ${peerId} not found in libp2p.getPeers() (have ${this.libp2p.getPeers().length} peers)`);
      return;
    }

    this.libp2p.dialProtocol(peer, SYNC_PROTOCOL).then(async (stream) => {
      try {
        await stream.sink([data]);
      } catch {
        // ignore write errors
      } finally {
        await stream.close().catch(() => {});
      }
    }).catch(() => {
      // ignore dial errors
    });
  }

  private async requestSubBlocksFn(peerId: string, ids: string[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const id of ids) {
      try {
        if (!this.libp2p) break;
        const sb = await requestSubBlock(this.libp2p, id, peerId, this.config);
        results.push(sb);
      } catch {
        // skip failed requests
      }
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // Identity + peers
  // -----------------------------------------------------------------------

  peerId(): string {
    if (!this.libp2p) throw new Error('NetNode not started');
    return this.libp2p.peerId.toString();
  }

  peers(): Peer[] {
    return this.peerMgr.getPeers();
  }

  /** Return the peer IDs of all currently Active peers. */
  getConnectedPeers(): string[] {
    return this.peerMgr.getPeers()
      .filter(p => this.peerMgr.isPeerActive(p.id))
      .map(p => p.id);
  }

  // -----------------------------------------------------------------------
  // Outbound broadcast
  // -----------------------------------------------------------------------

  async broadcastSubBlock(sb: SubBlock): Promise<void> {
    if (!this.libp2p) return;
    await broadcastSubBlock(asGossip(this.libp2p), sb);
  }

  async broadcastOrderingBlock(block: OrderingBlock): Promise<void> {
    if (!this.libp2p) return;
    await broadcastOrderingBlock(asGossip(this.libp2p), block);
  }

  async broadcastTx(tx: UtxoTransaction): Promise<void> {
    if (!this.libp2p) return;
    await broadcastTx(asGossip(this.libp2p), tx);
  }

  async broadcastStump(stump: Stump): Promise<void> {
    if (!this.libp2p) return;
    await broadcastStump(asGossip(this.libp2p), stump);
  }

  // -----------------------------------------------------------------------
  // Inbound handlers
  // -----------------------------------------------------------------------

  onSubBlock(cb: SubBlockCallback): void {
    this.subBlockHandlers.push(cb);
  }

  onOrderingBlock(cb: OrderingBlockCallback): void {
    this.orderingBlockHandlers.push(cb);
  }

  onTx(cb: TxCallback): void {
    this.txHandlers.push(cb);
  }

  onStump(cb: (stump: Stump) => void): void {
    this.stumpHandlers.push(cb);
  }

  /**
   * Register a callback that fires when the sync machine transitions to
   * the 'synced' phase (peer tip height matches our tip height).
   */
  onSyncComplete(cb: () => void): void {
    this.syncCompleteHandlers.push(cb);
  }

  /**
   * Register a callback that fires when a peer completes the handshake
   * and becomes Active. The peer's ID is passed to the callback.
   */
  onPeerActive(cb: (peerId: string) => void): void {
    this.peerActiveHandlers.push(cb);
  }

  // -----------------------------------------------------------------------
  // Sync — outbound requests
  // -----------------------------------------------------------------------

  async requestSubBlock(id: string, peerId: string): Promise<SubBlock> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestSubBlock(this.libp2p, id, peerId, this.config);
  }

  async requestHeaders(startHeight: number, maxCount: number, peerId: string): Promise<BlockHeader[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestHeaders(this.libp2p, startHeight, maxCount, peerId, this.config);
  }

  async requestBlocks(startHeight: number, endHeight: number, peerId: string): Promise<OrderingBlock[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestBlocks(this.libp2p, startHeight, endHeight, peerId, this.config);
  }

  /**
   * Request full post data (post body + like boxes) from a specific peer.
   * Opens a sync-protocol stream, sends a GetPosts message, and reads the
   * Posts response. Returns an empty entries array on any error.
   */
  async requestPosts(peerId: string, postIds: string[]): Promise<PostsMsg> {
    if (!this.libp2p) return { entries: [] };
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] requestPosts: peer ${peerId} not found`);
      return { entries: [] };
    }
    const magic = this.config.magic ?? MAGIC_MAINNET;
    const clamped = postIds.slice(0, 100);
    const request = encodeGetPosts(magic, { postIds: clamped });
    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, SYNC_PROTOCOL);
      await stream.sink([request]);
      const data = await readStreamBounded(stream.source);
      if (data === null) {
        console.warn(`[net] requestPosts: response from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
        return { entries: [] };
      }
      if (data.length === 0) {
        return { entries: [] };
      }
      const frame = decodeFrame(magic, data);
      if (frame.code !== MSG_POSTS) {
        console.warn(`[net] requestPosts: unexpected response code ${frame.code}`);
        return { entries: [] };
      }
      const response = decodePosts(frame.body);
      if (!response) {
        console.warn(`[net] requestPosts: malformed Posts response from ${peerId}`);
        return { entries: [] };
      }
      return response;
    } catch (err) {
      console.warn(`[net] requestPosts failed for peer ${peerId}: ${String(err)}`);
      return { entries: [] };
    } finally {
      if (stream) await stream.close().catch(() => {});
    }
  }

  /**
   * Request stump data from a specific peer. Opens a sync-protocol stream,
   * sends a GetStumps message, and reads the Stumps response.
   */
  async requestStumps(peerId: string, stumpIds: string[]): Promise<StumpsMsg> {
    if (!this.libp2p) return { entries: [] };
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] requestStumps: peer ${peerId} not found`);
      return { entries: [] };
    }
    const magic = this.config.magic ?? MAGIC_MAINNET;
    const clamped = stumpIds.slice(0, 100);
    const request = encodeGetStumps(magic, { stumpIds: clamped });
    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, SYNC_PROTOCOL);
      await stream.sink([request]);
      const data = await readStreamBounded(stream.source);
      if (data === null) {
        console.warn(`[net] requestStumps: response from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
        return { entries: [] };
      }
      if (data.length === 0) {
        return { entries: [] };
      }
      const frame = decodeFrame(magic, data);
      if (frame.code !== MSG_STUMPS) {
        console.warn(`[net] requestStumps: unexpected response code ${frame.code}`);
        return { entries: [] };
      }
      const response = decodeStumps(frame.body);
      if (!response) {
        console.warn(`[net] requestStumps: malformed Stumps response from ${peerId}`);
        return { entries: [] };
      }
      return response;
    } catch (err) {
      console.warn(`[net] requestStumps failed for peer ${peerId}: ${String(err)}`);
      return { entries: [] };
    } finally {
      if (stream) await stream.close().catch(() => {});
    }
  }

  /**
   * Ask `peerId` for its recent peers and feed the response into PeerDb
   * (NET_INTERFACE → GetPeers / Peers Intake). A malformed Peers response is
   * a protocol violation — permanent ban of the sender; bogus addresses in a
   * valid response are dropped silently, without penalty.
   */
  async requestPeers(peerId: string): Promise<void> {
    if (!this.libp2p) return;
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] requestPeers: peer ${peerId} not found`);
      return;
    }
    const magic = this.config.magic ?? MAGIC_MAINNET;
    const request = encodeGetPeers(magic);
    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, SYNC_PROTOCOL);
      await stream.sink([request]);
      const data = await readStreamBounded(stream.source);
      if (data === null) {
        console.warn(`[net] requestPeers: response from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
        return;
      }
      if (data.length === 0) {
        return;
      }
      const frame = decodeFrame(magic, data);
      if (frame.code !== MSG_PEERS) {
        console.warn(`[net] requestPeers: unexpected response code ${frame.code}`);
        return;
      }
      const usable = intakePeersBody(frame.body, {
        peerDb: this.peerDb,
        peerMgr: this.peerMgr,
        peerId,
        magic,
        nowMs: Date.now(),
      });
      if (usable !== null && usable > 0) {
        console.log(`[net] Peers from ${peerId}: recorded ${usable} address(es)`);
      }
    } catch (err) {
      console.warn(`[net] requestPeers failed for peer ${peerId}: ${String(err)}`);
    } finally {
      if (stream) await stream.close().catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Sync — handler registration
  // -----------------------------------------------------------------------

  /**
   * Register a storage-backed sync handler. Must be called after start() by the
   * node layer, which owns storage. Wires into the sync machine's store adapter.
   */
  setSyncHandler(handler: (id: string) => SubBlock | null): void {
    this.syncStore.setSubBlockFn((id) => handler(id));
  }

  /**
   * Register a handler that serves post data to peers who request it via
   * MSG_GET_POSTS. The handler receives an array of post IDs and must return
   * the corresponding PostsEntry records (post + like boxes).
   */
  setPostsHandler(handler: (postIds: string[]) => PostsEntry[]): void {
    this.postsHandler = handler;
  }

  /**
   * Register a handler that serves stump data to peers who request it via
   * MSG_GET_STUMPS. The handler receives an array of stump IDs and must return
   * the corresponding StumpsEntry records.
   */
  setStumpsHandler(handler: (stumpIds: string[]) => StumpsEntry[]): void {
    this.stumpsHandler = handler;
  }

  /**
   * Register a handler for blocks received via the sync machine's pull path
   * (ModifierResponse during header-first sync). The node layer decodes and
   * applies blocks to state — this bridges the sync machine's receive side
   * to the node's applyOrderingBlock pipeline.
   */
  setBlocksHandler(handler: (block: OrderingBlock) => void): void {
    this.syncStore.setBlocksHandler(handler);
  }

  /**
   * Register a storage-backed headers handler. Wires into the sync machine's
   * store adapter and also registers a legacy protocol handler for backward
   * compatibility with peers that use the old /dagsocial/headers/1 protocol.
   */
  setHeadersHandler(getBlock: (height: number) => OrderingBlock | null): void {
    // Wire into sync store bridge
    this.syncStore.setOrderingBlockFn((h) => getBlock(h));

    // Also register legacy headers protocol handler for backward compat
    if (!this.headersHandlerRegistered && this.libp2p) {
      const libp2p = this.libp2p;
      libp2p.handle(HEADERS_PROTOCOL, async ({ stream }) => {
        try {
          // The legacy protocol is ungated — no handshake, so no peer identity to
          // penalize. An over-cap stream is simply dropped.
          const data = await readStreamBounded(stream.source);
          if (data === null || data.length === 0) {
            await stream.sink([new Uint8Array(0)]);
            return;
          }

          const request = decodeLegacyHeadersRequest(data);
          if (!request) {
            await stream.sink([new Uint8Array(0)]);
            return;
          }

          // Both loops below read the store once per height. Clamp them to our
          // own tip: we cannot serve what we do not have, so this never
          // truncates a legitimate request, and a peer asking for height 1e15
          // costs us nothing.
          const ourHeight = this.syncStore.chainHeight();

          if (request.mode === 'blocks') {
            const blocks: OrderingBlock[] = [];
            const endHeight = Math.min(request.endHeight ?? ourHeight, ourHeight);
            for (let h = request.startHeight; h <= endHeight; h++) {
              const block = getBlock(h);
              if (block) blocks.push(block);
            }
            await stream.sink([Buffer.from(encode({ blocks }))] as any);
          } else {
            const headers: BlockHeader[] = [];
            const maxCount = request.maxCount ?? 20;
            for (let h = Math.min(request.startHeight, ourHeight); h > 0 && headers.length < maxCount; h--) {
              const block = getBlock(h);
              if (block) headers.push(block.header);
              else break;
            }
            await stream.sink([Buffer.from(encode(headers))] as any);
          }
        } catch {
          await stream.sink([new Uint8Array(0)]);
        }
      });
      this.headersHandlerRegistered = true;
    }
  }

  // Expose for node to register storage-backed handler
  get libp2pNode(): Libp2p | null {
    return this.libp2p;
  }
}
