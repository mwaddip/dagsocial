import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
import { encode, decode } from 'cbor-x';

import type { Libp2p } from 'libp2p';
import type { SubBlock, OrderingBlock, UtxoTransaction, BlockHeader } from '@dagsocial/types';
import { PROTOCOL_VERSION, encodeSubBlock, decodeSubBlock, encodeOrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { ReaderError } from '@dagsocial/wire';
import type { NetConfig, NetValidators, Peer, PeerRecord } from './types.js';
import type { Libp2pGossip, GossipHandlers } from './gossip.js';
import { PeerManager } from './peer-mgr.js';
import { subscribeTopics, broadcastSubBlock, broadcastOrderingBlock, broadcastTx } from './gossip.js';
import {
  SYNC_PROTOCOL,
  HEADERS_PROTOCOL,
  requestSubBlock,
  requestHeaders,
  requestBlocks,
} from './sync.js';
import { mergeUint8Arrays } from './util.js';
import { PeerDb } from './peerdb.js';
import { SyncMachine } from './sync-machine.js';
import type { SyncStore } from './sync-machine.js';
import { OutboundManager } from './outbound-mgr.js';
import { encodeFrame, decodeFrame, MAGIC_MAINNET, MAGIC_TESTNET } from './frame.js';
import { buildHandshakeFrame, parseHandshakeBody, validateHandshake } from './handshake.js';
import type { HandshakeResult } from './handshake.js';
import {
  MSG_GET_SUB_BLOCK,
  MSG_SUB_BLOCK_RESPONSE,
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

  setOrderingBlockFn(fn: (height: number) => unknown | null): void {
    this._getOrderingBlock = fn;
  }

  setSubBlockFn(fn: (id: string) => unknown | null): void {
    this._getSubBlock = fn;
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

  hasOrderingBlockHeader(id: string): boolean {
    // Walk heights to check — naive but correct for small chains
    if (!this._getOrderingBlock) return false;
    const h = this.chainHeight();
    for (let i = 0; i <= h; i++) {
      const bid = this.getOrderingBlockId(i);
      if (bid === id) return true;
    }
    return false;
  }

  hasSubBlock(id: string): boolean {
    return this._getSubBlock?.(id) != null;
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
    // Same as appendHeaders — node layer owns persistence.
  }

  setValidatedHeight(_height: number): void {
    // Node layer tracks validation state.
  }

  flush(): void {
    // Node layer flushes via its own DB lifecycle.
  }
}

export class NetNode {
  private libp2p: Libp2p | null = null;
  private peerMgr: PeerManager;
  private config: NetConfig;
  private validators: NetValidators;
  private subBlockHandlers: SubBlockCallback[] = [];
  private orderingBlockHandlers: OrderingBlockCallback[] = [];
  private txHandlers: TxCallback[] = [];
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

  constructor(config: NetConfig, validators: NetValidators) {
    this.config = config;
    this.validators = validators;
    this.peerMgr = new PeerManager(config);
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
    this.peerDb = new PeerDb(null, this.config.peerDbCap ?? 100, selfAddrs);

    // Create SyncMachine with lazy store bridge
    const magic = this.config.magic ?? MAGIC_MAINNET;
    this.syncMachine = new SyncMachine(
      this.config,
      this.syncStore,
      (peerId: string, data: Uint8Array) => this.sendToPeer(peerId, data),
      async (peerId: string, ids: string[]) => this.requestSubBlocksFn(peerId, ids),
    );

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
    };

    await subscribeTopics(asGossip(this.libp2p), this.validators, this.peerMgr, handlers);

    // Log listen addresses
    console.log(`[net] listening on: ${listenAddrs.map(a => a.toString()).join(', ')}`);

    // Connect to bootstrap peers
    for (const addr of this.config.bootstrapPeers) {
      console.log(`[net] dialing bootstrap peer: ${addr}`);
      try {
        const conn = await this.libp2p.dial(multiaddr(addr));
        console.log(`[net] bootstrap dial succeeded: ${addr} -> peer=${conn.remotePeer.toString()}`);

        // Run handshake exchange with the newly connected peer
        try {
          const result = await this.runOutboundHandshake(conn.remotePeer.toString());
          if (result.ok) {
            // Record in PeerDb
            this.peerDb?.record({
              address: addr,
              lastSeenMs: Date.now(),
              agentName: 'bootstrap',
              nodeName: '',
              protocolVersion: PROTOCOL_VERSION,
              capabilities: result.peerCapabilities,
            });
            // Notify sync machine
            this.syncMachine?.onPeerActive(conn.remotePeer.toString(), result.peerHeight);
          }
        } catch (handshakeErr: any) {
          console.warn(`[net] handshake with bootstrap peer ${addr} failed: ${handshakeErr?.message ?? handshakeErr}`);
        }
      } catch (err: any) {
        // Bootstrap peer unreachable — not fatal
        console.warn(`[net] bootstrap dial FAILED: ${addr} — ${err?.message ?? err}`);
        this.outboundMgr?.recordDialResult(addr, false);
      }
    }

    // Start periodic timer: sync machine tick + outbound manager
    this.syncTimer = setInterval(() => {
      this.syncMachine?.onTimerTick();
      // Outbound manager: check if we should dial more peers
      if (this.libp2p && this.outboundMgr) {
        const connectedOutbound = this.peerMgr.getPeerCount();
        const candidate = this.outboundMgr.pickCandidate(connectedOutbound);
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
    }, 30_000);

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || !this.libp2p) return;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    await this.libp2p.stop();
    this.libp2p = null;
    this.peerDb = null;
    this.syncMachine = null;
    this.outboundMgr = null;
    this.started = false;
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
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream.source) {
          chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
        }
        if (chunks.length === 0) {
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        const data = mergeUint8Arrays(chunks);
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

        const msg = parseHandshakeBody(body);
        const result = validateHandshake(msg, [PROTOCOL_VERSION]);
        console.log(`[net] inbound handshake from ${peerId}: ok=${result.ok} height=${msg.chainHeight}`);

        // Record peer regardless of validation outcome
        const listenAddrs = this.libp2p!.getMultiaddrs();
        const addr = msg.declaredAddress ?? connection.remoteAddr?.toString() ?? peerId;
        this.peerDb?.record({
          address: addr,
          lastSeenMs: Date.now(),
          agentName: msg.agentName,
          nodeName: msg.nodeName,
          protocolVersion: msg.protocolVersion,
          capabilities: msg.capabilities ?? [],
        });

        if (result.ok) {
          this.syncMachine?.onPeerActive(peerId, msg.chainHeight);
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
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream.source) {
          chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
        }
        if (chunks.length === 0) {
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        const data = mergeUint8Arrays(chunks);

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
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
      }

      if (chunks.length === 0) {
        return { ok: false, error: 'empty handshake response', peerHeight: 0, peerCapabilities: [] };
      }

      const data = mergeUint8Arrays(chunks);
      let body: Uint8Array;
      try {
        const framed = decodeFrame(magic, data);
        body = framed.body;
      } catch {
        body = data;
      }

      const msg = parseHandshakeBody(body);
      const result = validateHandshake(msg, [PROTOCOL_VERSION]);
      console.log(`[net] outbound handshake with ${peerId}: ok=${result.ok} height=${result.peerHeight} caps=${result.peerCapabilities.length}`);
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
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream.source) {
            chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
          }
          if (chunks.length === 0) {
            await stream.sink([new Uint8Array(0)]);
            return;
          }

          const request = decode(mergeUint8Arrays(chunks)) as {
            startHeight: number;
            maxCount?: number;
            endHeight?: number;
            mode?: string;
          };

          if (request.mode === 'blocks') {
            const blocks: OrderingBlock[] = [];
            for (let h = request.startHeight; h <= request.endHeight!; h++) {
              const block = getBlock(h);
              if (block) blocks.push(block);
            }
            await stream.sink([Buffer.from(encode({ blocks }))] as any);
          } else {
            const headers: BlockHeader[] = [];
            for (let h = request.startHeight; h > 0 && headers.length < (request.maxCount || 20); h--) {
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
