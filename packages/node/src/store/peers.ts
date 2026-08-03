import { getDb } from './db.js';
import type { PeerRecord, PeerStorage } from '@dagsocial/net';

/**
 * Persistence behind net's PeerStorage seam (audit L-14): the peers table
 * mirrors net's PeerRecord one-to-one, keyed by address. Net must not depend
 * on SQLite, so this module implements the seam and index.ts hands it to
 * NetNode at construction.
 */

/**
 * Load every readable peer row. Total by contract: a row whose capabilities
 * JSON is corrupt is skipped with a warning, never thrown — PeerDb calls this
 * during startup, and one bad row must not prevent the node from starting.
 */
export function loadAllPeers(): PeerRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT address, last_seen_ms, agent_name, node_name, protocol_version, capabilities
       FROM peers`,
    )
    .all() as Array<{
      address: string;
      last_seen_ms: number;
      agent_name: string;
      node_name: string;
      protocol_version: number;
      capabilities: string;
    }>;

  const records: PeerRecord[] = [];
  for (const r of rows) {
    let capabilities: number[];
    try {
      const parsed: unknown = JSON.parse(r.capabilities);
      if (!Array.isArray(parsed) || !parsed.every((c) => Number.isInteger(c))) {
        throw new Error('not an integer array');
      }
      capabilities = parsed as number[];
    } catch (err) {
      console.warn(
        `[store] skipping corrupt peer row ${r.address}: bad capabilities JSON (${String(err)})`,
      );
      continue;
    }
    records.push({
      address: r.address,
      lastSeenMs: r.last_seen_ms,
      agentName: r.agent_name,
      nodeName: r.node_name,
      protocolVersion: r.protocol_version,
      capabilities,
    });
  }
  return records;
}

/** Write-through upsert — PeerDb calls this on every record(). */
export function putPeer(record: PeerRecord): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO peers
       (address, last_seen_ms, agent_name, node_name, protocol_version, capabilities)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.address,
      record.lastSeenMs,
      record.agentName,
      record.nodeName,
      record.protocolVersion,
      JSON.stringify(record.capabilities),
    );
}

export function deletePeer(address: string): void {
  getDb().prepare('DELETE FROM peers WHERE address = ?').run(address);
}

/** The PeerStorage implementation handed to NetNode at construction. */
export const peerStorage: PeerStorage = {
  loadAll: loadAllPeers,
  put: putPeer,
  delete: deletePeer,
};
