import type { PeerDb } from './peerdb.js';
import type { NetConfig } from './types.js';

export class OutboundManager {
  private cooldowns: Map<string, number> = new Map();
  private readonly redialCooldownMs: number;
  private readonly minPeers: number;

  constructor(
    private config: NetConfig,
    private peerDb: PeerDb,
    private dialFn: (addr: string) => Promise<void>,
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

  /** Get the next peer to dial, or null if none available. */
  pickCandidate(connectedCount: number): string | null {
    // Floor phase: don't use PeerDb when below minPeers
    // (caller handles bootstrap seed dialing separately)
    if (connectedCount < this.minPeers) return null;

    // Fill phase
    if (connectedCount >= this.config.maxPeers) return null;

    const now = Date.now();
    const need = this.config.maxPeers - connectedCount;
    const exclude = new Set<string>();
    // Exclude addresses in cooldown
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
