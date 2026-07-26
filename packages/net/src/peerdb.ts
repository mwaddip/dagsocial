import type { PeerRecord } from './types.js';

export interface PeerStorage {
  loadAll(): PeerRecord[];
  put(record: PeerRecord): void;
  delete(address: string): void;
}

export class PeerDb {
  private entries: Map<string, PeerRecord> = new Map();
  private selfAddrs: Set<string>;

  constructor(
    private storage: PeerStorage | null,
    private cap: number,
    selfAddresses: string[],
  ) {
    this.selfAddrs = new Set(selfAddresses);
    // Load persisted entries on construction
    if (storage) {
      for (const rec of storage.loadAll()) {
        if (!this.selfAddrs.has(rec.address)) {
          this.entries.set(rec.address, rec);
        }
      }
    }
  }

  record(record: PeerRecord): void {
    if (this.selfAddrs.has(record.address)) return;

    const existing = this.entries.get(record.address);
    const merged: PeerRecord = existing
      ? { ...record, lastSeenMs: Math.max(existing.lastSeenMs, record.lastSeenMs) }
      : record;

    this.entries.set(record.address, merged);

    // Evict oldest if over cap
    if (this.entries.size > this.cap) {
      let oldestAddr = '';
      let oldestMs = Infinity;
      for (const [addr, rec] of this.entries) {
        if (rec.lastSeenMs < oldestMs) {
          oldestMs = rec.lastSeenMs;
          oldestAddr = addr;
        }
      }
      if (oldestAddr) {
        this.entries.delete(oldestAddr);
        this.storage?.delete(oldestAddr);
      }
    }

    // Only persist if the entry survived eviction
    if (this.entries.has(record.address)) {
      this.storage?.put(merged);
    }
  }

  forget(addr: string): void {
    this.entries.delete(addr);
    this.storage?.delete(addr);
  }

  get(addr: string): PeerRecord | null {
    return this.entries.get(addr) ?? null;
  }

  recent(limit: number, excludeAddrs: Set<string>): PeerRecord[] {
    const filtered = Array.from(this.entries.values())
      .filter((r) => !excludeAddrs.has(r.address));
    filtered.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return filtered.slice(0, limit);
  }

  all(): PeerRecord[] {
    return Array.from(this.entries.values());
  }

  count(): number {
    return this.entries.size;
  }
}
