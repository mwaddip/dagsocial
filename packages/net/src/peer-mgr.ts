import type { NetConfig, Peer, PenaltyType, PenaltyRecord } from './types.js';

interface PeerEntry {
  peer: Peer;
  penaltyScore: number;
  lastPenaltyTime: number;
  banExpiresAt: number | null;
}

interface BanEntry {
  peerId: string;
  bannedAt: number;
  banExpiresAt: number | null; // null = permanent
}

export class PeerManager {
  private peers: Map<string, PeerEntry> = new Map();
  private bans: Map<string, BanEntry> = new Map();
  private config: NetConfig;

  constructor(config: NetConfig) {
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // Peer tracking
  // -----------------------------------------------------------------------

  getPeers(): Peer[] {
    return Array.from(this.peers.values()).map((e) => e.peer);
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  addPeer(peer: Peer): void {
    if (this.isBanned(peer.id)) return;
    this.peers.set(peer.id, {
      peer,
      penaltyScore: 0,
      lastPenaltyTime: 0,
      banExpiresAt: null,
    });
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId)?.peer;
  }

  // -----------------------------------------------------------------------
  // Penalty system
  // -----------------------------------------------------------------------

  recordPenalty(type: PenaltyType, peerId: string, score: number, reason: string): void {
    const now = Date.now();

    if (type === 'permanent') {
      // Instant permanent ban — works even if peer was never added
      this.bans.set(peerId, { peerId, bannedAt: now, banExpiresAt: null });
      this.peers.delete(peerId);
      return;
    }

    const entry = this.peers.get(peerId);
    if (!entry) return;

    // Respect safe interval for non-permanent penalties.
    // Skip the cooldown when lastPenaltyTime is 0 (first penalty ever) so that
    // tests mocking Date.now() to 0 don't incorrectly trigger the safe interval.
    if (entry.lastPenaltyTime > 0 && now - entry.lastPenaltyTime < this.config.penaltySafeIntervalMs) {
      return; // within cooldown, skip
    }

    entry.penaltyScore += score;
    entry.lastPenaltyTime = now;

    if (entry.penaltyScore >= this.config.penaltyScoreThreshold) {
      // Temporal ban
      this.bans.set(peerId, {
        peerId,
        bannedAt: now,
        banExpiresAt: now + this.config.temporalBanDurationMs,
      });
      this.peers.delete(peerId);
    }
  }

  isBanned(peerId: string): boolean {
    const ban = this.bans.get(peerId);
    if (!ban) return false;
    if (ban.banExpiresAt === null) return true; // permanent
    if (Date.now() >= ban.banExpiresAt) {
      // Ban expired, clean up
      this.bans.delete(peerId);
      return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  evictRandom(): string | null {
    if (this.peers.size === 0) return null;
    const ids = Array.from(this.peers.keys());
    const idx = Math.floor(Math.random() * ids.length);
    const id = ids[idx]!;
    this.peers.delete(id);
    return id;
  }
}
