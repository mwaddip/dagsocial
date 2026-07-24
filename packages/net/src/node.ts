import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';

import type { Libp2p } from 'libp2p';
import type { SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import type { NetConfig, NetValidators, Peer } from './types.js';
import type { Libp2pGossip, GossipHandlers } from './gossip.js';
import { PeerManager } from './peer-mgr.js';
import { subscribeTopics, broadcastSubBlock, broadcastOrderingBlock, broadcastTx } from './gossip.js';
import { requestSubBlock, registerSyncHandler } from './sync.js';

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

export class NetNode {
  private libp2p: Libp2p | null = null;
  private peerMgr: PeerManager;
  private config: NetConfig;
  private validators: NetValidators;
  private subBlockHandlers: SubBlockCallback[] = [];
  private orderingBlockHandlers: OrderingBlockCallback[] = [];
  private txHandlers: TxCallback[] = [];
  private started = false;

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

    // Sync handler registered later via setSyncHandler() — node provides storage

    // Log listen addresses
    const listenAddrs = this.libp2p.getMultiaddrs();
    console.log(`[net] listening on: ${listenAddrs.map(a => a.toString()).join(', ')}`);

    // Connect to bootstrap peers
    for (const addr of this.config.bootstrapPeers) {
      console.log(`[net] dialing bootstrap peer: ${addr}`);
      try {
        const conn = await this.libp2p.dial(multiaddr(addr));
        console.log(`[net] bootstrap dial succeeded: ${addr} -> peer=${conn.remotePeer.toString()}`);
      } catch (err: any) {
        // Bootstrap peer unreachable — not fatal
        console.warn(`[net] bootstrap dial FAILED: ${addr} — ${err?.message ?? err}`);
      }
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || !this.libp2p) return;
    await this.libp2p.stop();
    this.libp2p = null;
    this.started = false;
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
  // Sync
  // -----------------------------------------------------------------------

  async requestSubBlock(id: string, peerId: string): Promise<SubBlock> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestSubBlock(this.libp2p, id, peerId, this.config);
  }

  /**
   * Register a storage-backed sync handler. Must be called after start() by the
   * node layer, which owns storage. Replaces the null placeholder registered
   * during start().
   */
  private syncHandlerRegistered = false;

  setSyncHandler(handler: (id: string) => SubBlock | null): void {
    if (!this.libp2p) throw new Error('NetNode not started');
    if (this.syncHandlerRegistered) return; // libp2p rejects duplicate protocol handlers
    registerSyncHandler(this.libp2p, handler);
    this.syncHandlerRegistered = true;
  }

  // Expose for node to register storage-backed handler
  get libp2pNode(): Libp2p | null {
    return this.libp2p;
  }
}
