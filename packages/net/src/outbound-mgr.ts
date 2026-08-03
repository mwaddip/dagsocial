import type { PeerDb } from './peerdb.js';
import type { NetConfig } from './types.js';

/**
 * The slice of a libp2p Connection the outbound manager reads. Structural, so
 * tests drive the real floor/fill decisions without a libp2p node.
 */
export interface ConnectionLike {
  direction: 'inbound' | 'outbound';
  remoteAddr: { toString(): string };
}

/** What one outbound timer tick should do (contract: "Outbound Manager"). */
export interface OutboundTickPlan {
  /** Floor phase: dial the bootstrap seeds aggressively. */
  dialBootstrap: boolean;
  /** Fill phase: the PeerDb candidate to dial this tick, or null. */
  candidate: string | null;
}

export class OutboundManager {
  private cooldowns: Map<string, number> = new Map();
  private readonly redialCooldownMs: number;
  private readonly minPeers: number;

  constructor(
    private config: NetConfig,
    private peerDb: PeerDb,
  ) {
    this.redialCooldownMs = config.outboundRedialCooldownMs ?? 60_000;
    this.minPeers = config.minPeers ?? 3;
  }

  /** Call after a dial succeeds or fails. */
  recordDialResult(addr: string, success: boolean): void {
    if (!success) {
      this.cooldowns.set(addr, Date.now() + this.redialCooldownMs);
    } else {
      this.cooldowns.delete(addr);
    }
  }

  /**
   * Decide this tick's actions from the live connection list. Both phases key
   * off the count of OUTBOUND connections only — an attacker who fills every
   * inbound slot must not be able to stop us from dialing out, which is how a
   * node gets eclipsed. Inbound connections count toward maxPeers capacity
   * (libp2p's connection manager enforces that), never toward these
   * thresholds.
   */
  planTick(connections: ConnectionLike[]): OutboundTickPlan {
    let connectedOutbound = 0;
    const connectedAddrs = new Set<string>();
    for (const conn of connections) {
      if (conn.direction === 'outbound') connectedOutbound++;
      connectedAddrs.add(conn.remoteAddr.toString());
    }
    return {
      dialBootstrap: connectedOutbound < this.minPeers,
      candidate: this.pickCandidate(connectedOutbound, connectedAddrs),
    };
  }

  /** Get the next peer to dial, or null if none available. */
  pickCandidate(connectedOutbound: number, connectedAddrs: ReadonlySet<string>): string | null {
    // Floor phase: don't use PeerDb when below minPeers
    // (caller handles bootstrap seed dialing separately)
    if (connectedOutbound < this.minPeers) return null;

    // Fill phase
    if (connectedOutbound >= this.config.maxPeers) return null;

    const now = Date.now();
    const need = this.config.maxPeers - connectedOutbound;
    // exclude = connected ∪ cooldown. The connected half is required, not an
    // optimization: without it the manager re-dials peers it already holds
    // and starves genuinely new candidates.
    const exclude = new Set<string>(connectedAddrs);
    for (const [addr, until] of this.cooldowns) {
      if (now < until) exclude.add(addr);
      else this.cooldowns.delete(addr); // cooldown expired
    }

    const candidates = this.peerDb.recent(need, exclude);
    if (candidates.length === 0) return null;

    return candidates[0]!.address;
  }

  /** Seed addresses to dial when below minPeers. */
  getBootstrapPeers(): string[] {
    return this.config.bootstrapPeers;
  }
}
