import { PeerState, PenaltyKind } from './types.js';
import type { NetConfig, Peer, PenaltyType, PeerMetadata } from './types.js';

const STALL_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Points drained from an accumulated penalty score per elapsed
 * `penaltySafeIntervalMs` (contract: "Accrual and decay (audit L-13)").
 * Break-even is one MisbehaviorPenalty (100) per interval: misbehave
 * faster and the score climbs toward a ban, slower and it fades to zero.
 */
const PENALTY_DECAY_PER_INTERVAL = 100;

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
  /**
   * The peer's declared address at ban time, captured before the ban path
   * deletes the metadata. Expiry propagates the unban from here — by then
   * the metadata may be long gone (removePeer on disconnect).
   */
  address: string | null;
}

/**
 * Optional callbacks fired when a ban is imposed or expires, carrying the
 * peer's declared address. NetNode binds these to PeerDb.ban/unban so the
 * peerId-keyed and address-keyed ban surfaces cannot drift apart (contract:
 * "Ban surfaces are unified"). Callbacks — not a PeerDb import — keep
 * peer-mgr a leaf module.
 */
export interface PeerBanHooks {
  onBan?: (address: string) => void;
  onUnban?: (address: string) => void;
}

export class PeerManager {
  private peers: Map<string, PeerEntry> = new Map();
  private bans: Map<string, BanEntry> = new Map();
  private metadata: Map<string, PeerMetadata> = new Map();
  private stalledPeers: Set<string> = new Set();
  private config: NetConfig;
  private hooks: PeerBanHooks;

  constructor(config: NetConfig, hooks: PeerBanHooks = {}) {
    this.config = config;
    this.hooks = hooks;
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
        address: null,
      });
    }
  }

  /**
   * Record the peer's declared address once the handshake reveals it. No-op
   * for an untracked peer, like setPeerState. A peer banned before this is
   * called simply has no address to propagate — that is correct, not an
   * error.
   */
  setPeerAddress(peerId: string, address: string): void {
    const meta = this.metadata.get(peerId);
    if (meta) meta.address = address;
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
      // Instant permanent ban — works even if peer was never added.
      // imposeBan reads the address before the metadata.delete below.
      this.imposeBan(peerId, now, null);
      this.peers.delete(peerId);
      this.metadata.delete(peerId);
      this.stalledPeers.delete(peerId);
      return;
    }

    this.accrueScoredPenalty(peerId, score, now);
  }

  /**
   * Impose a ban and propagate it to the address surface. The metadata read
   * happens here, before the permanent-ban callers delete the metadata —
   * reading after that delete would silently drop the propagation. A peer
   * with no recorded address (banned before its handshake completed) has
   * nothing to propagate.
   */
  private imposeBan(peerId: string, now: number, banExpiresAt: number | null): void {
    const address = this.metadata.get(peerId)?.address ?? null;
    this.bans.set(peerId, { peerId, bannedAt: now, banExpiresAt, address });
    if (address !== null) this.hooks.onBan?.(address);
  }

  // -----------------------------------------------------------------------
  // Three-tier penalty attribution (contract: Penalty Attribution)
  // -----------------------------------------------------------------------

  /**
   * Record a penalty using the three-tier system.
   *
   * - Transient: scored (50), decays over time, peer stays in PeerDb
   *   (timeout, slow response)
   * - ProtocolViolation: permanent ban, peer removed from PeerDb
   * - RateLimit: scored (100), decays over time, peer stays (too many
   *   messages)
   */
  recordPenaltyKind(kind: PenaltyKind, peerId: string, reason: string): void {
    const now = Date.now();

    switch (kind) {
      case PenaltyKind.ProtocolViolation: {
        // Permanent ban — remove peer entirely.
        // imposeBan reads the address before the metadata.delete below.
        this.imposeBan(peerId, now, null);
        this.peers.delete(peerId);
        this.metadata.delete(peerId);
        this.stalledPeers.delete(peerId);
        return;
      }
      case PenaltyKind.Transient:
      case PenaltyKind.RateLimit: {
        this.accrueScoredPenalty(peerId, kind === PenaltyKind.Transient ? 50 : 100, now);
        return;
      }
    }
  }

  /**
   * Shared accrual + decay for every non-permanent penalty (contract:
   * "Accrual and decay (audit L-13)").
   *
   * Every penalty accrues — none are discarded for arriving quickly.
   * Instead the accumulated score decays by PENALTY_DECAY_PER_INTERVAL per
   * `penaltySafeIntervalMs` elapsed since the last penalty, proportionally
   * and floored at zero, computed lazily here — no timers. The config field
   * keeps its "safe interval" name because @dagsocial/node sets it from the
   * environment, but it is a decay interval, not a cooldown.
   */
  private accrueScoredPenalty(peerId: string, score: number, now: number): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;

    const intervalMs = this.config.penaltySafeIntervalMs;
    // Clamped: a clock running backwards must not mint negative decay,
    // which would inflate the score.
    const elapsedMs = Math.max(0, now - entry.lastPenaltyTime);
    if (intervalMs > 0 && elapsedMs > 0) {
      const decay = (elapsedMs / intervalMs) * PENALTY_DECAY_PER_INTERVAL;
      entry.penaltyScore = Math.max(0, entry.penaltyScore - decay);
    }

    entry.penaltyScore += score;
    entry.lastPenaltyTime = now;

    const meta = this.metadata.get(peerId);
    if (meta) {
      meta.penaltyCount++;
      meta.lastSeenMs = now;
    }

    if (entry.penaltyScore >= this.config.penaltyScoreThreshold) {
      const banExpiresAt = now + this.config.temporalBanDurationMs;
      this.imposeBan(peerId, now, banExpiresAt);
      this.peers.delete(peerId);
      if (meta) {
        meta.state = PeerState.Banned;
        meta.bannedUntil = banExpiresAt;
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
      // Ban expired, clean up and lift the address-surface ban with it
      this.bans.delete(peerId);
      if (ban.address !== null) this.hooks.onUnban?.(ban.address);
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
