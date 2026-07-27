import { PeerState, PenaltyKind } from './types.js';
import type { NetConfig, Peer, PenaltyType, PeerMetadata } from './types.js';

const STALL_TIMEOUT_MS = 30_000; // 30 seconds

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
  private metadata: Map<string, PeerMetadata> = new Map();
  private stalledPeers: Set<string> = new Set();
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
    // Initialize peer metadata if not already present
    if (!this.metadata.has(peer.id)) {
      this.metadata.set(peer.id, {
        peerId: peer.id,
        state: PeerState.Connecting,
        penaltyCount: 0,
        bannedUntil: null,
        stalled: false,
        lastSeenMs: Date.now(),
      });
    }
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
    this.metadata.delete(peerId);
    this.stalledPeers.delete(peerId);
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId)?.peer;
  }

  // -----------------------------------------------------------------------
  // Penalty system (legacy score-based)
  // -----------------------------------------------------------------------

  recordPenalty(type: PenaltyType, peerId: string, score: number, reason: string): void {
    const now = Date.now();

    if (type === 'permanent') {
      // Instant permanent ban — works even if peer was never added
      this.bans.set(peerId, { peerId, bannedAt: now, banExpiresAt: null });
      this.peers.delete(peerId);
      this.metadata.delete(peerId);
      this.stalledPeers.delete(peerId);
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

    // Update metadata penalty count
    const meta = this.metadata.get(peerId);
    if (meta) {
      meta.penaltyCount++;
      meta.lastSeenMs = now;
    }

    if (entry.penaltyScore >= this.config.penaltyScoreThreshold) {
      // Temporal ban
      this.bans.set(peerId, {
        peerId,
        bannedAt: now,
        banExpiresAt: now + this.config.temporalBanDurationMs,
      });
      this.peers.delete(peerId);
      if (meta) {
        meta.state = PeerState.Banned;
        meta.bannedUntil = now + this.config.temporalBanDurationMs;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Three-tier penalty attribution (contract: Penalty Attribution)
  // -----------------------------------------------------------------------

  /**
   * Record a penalty using the three-tier system.
   *
   * - Transient: cooldown, peer stays in PeerDb (timeout, slow response)
   * - ProtocolViolation: permanent ban, peer removed from PeerDb
   * - RateLimit: cooldown, peer stays (too many messages)
   */
  recordPenaltyKind(kind: PenaltyKind, peerId: string, reason: string): void {
    const now = Date.now();

    switch (kind) {
      case PenaltyKind.ProtocolViolation: {
        // Permanent ban — remove peer entirely
        this.bans.set(peerId, { peerId, bannedAt: now, banExpiresAt: null });
        this.peers.delete(peerId);
        this.metadata.delete(peerId);
        this.stalledPeers.delete(peerId);
        return;
      }
      case PenaltyKind.Transient:
      case PenaltyKind.RateLimit: {
        const meta = this.metadata.get(peerId);
        const entry = this.peers.get(peerId);
        if (!entry) return;

        // Respect safe interval
        if (entry.lastPenaltyTime > 0 && now - entry.lastPenaltyTime < this.config.penaltySafeIntervalMs) {
          return;
        }

        const score = kind === PenaltyKind.Transient ? 50 : 100;
        entry.penaltyScore += score;
        entry.lastPenaltyTime = now;

        if (meta) {
          meta.penaltyCount++;
          meta.lastSeenMs = now;
        }

        // Check threshold — temporal ban if exceeded
        if (entry.penaltyScore >= this.config.penaltyScoreThreshold) {
          const banExpiry = now + this.config.temporalBanDurationMs;
          this.bans.set(peerId, {
            peerId,
            bannedAt: now,
            banExpiresAt: banExpiry,
          });
          this.peers.delete(peerId);
          if (meta) {
            meta.state = PeerState.Banned;
            meta.bannedUntil = banExpiry;
          }
        }
        return;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Peer state machine
  // -----------------------------------------------------------------------

  /** Transition a peer to a new state. Idempotent — ignores redundant transitions. */
  setPeerState(peerId: string, state: PeerState): void {
    const meta = this.metadata.get(peerId);
    if (meta) {
      meta.state = state;
      meta.lastSeenMs = Date.now();
    }
  }

  /** Get metadata for a peer, or null if not tracked. */
  getPeerMetadata(peerId: string): PeerMetadata | null {
    return this.metadata.get(peerId) ?? null;
  }

  /** Guard: returns true only if the peer is in the Active state. */
  isPeerActive(peerId: string): boolean {
    const meta = this.metadata.get(peerId);
    return meta?.state === PeerState.Active;
  }

  // -----------------------------------------------------------------------
  // Stall detection (contract: Stall Detection)
  // -----------------------------------------------------------------------

  /** Mark a peer as stalled and rotate to the next available peer. */
  markStalled(peerId: string): void {
    const peer = this.metadata.get(peerId);
    if (peer) {
      peer.stalled = true;
      this.stalledPeers.add(peerId);
    }
  }

  /** Clear the stalled set when any peer delivers data successfully. */
  clearStalled(): void {
    for (const peerId of this.stalledPeers) {
      const peer = this.metadata.get(peerId);
      if (peer) peer.stalled = false;
    }
    this.stalledPeers.clear();
  }

  /** Get the next non-stalled outbound peer. */
  getNextActivePeer(): PeerMetadata | null {
    for (const peer of this.metadata.values()) {
      if (peer.state === PeerState.Active && !peer.stalled) {
        return peer;
      }
    }
    // All peers stalled — clear and retry
    this.clearStalled();
    return null;
  }

  /** Check if a peer has exceeded the stall timeout. */
  isStallTimedOut(peerId: string): boolean {
    const meta = this.metadata.get(peerId);
    if (!meta) return false;
    return meta.stalled && Date.now() - meta.lastSeenMs > STALL_TIMEOUT_MS;
  }

  /** Get the set of currently stalled peer IDs (read-only). */
  getStalledPeers(): ReadonlySet<string> {
    return this.stalledPeers;
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
