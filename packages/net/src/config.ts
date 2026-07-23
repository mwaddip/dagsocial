import type { NetConfig } from './types.js';

export function loadNetConfig(): Readonly<NetConfig> {
  const cfg: NetConfig = {
    bootstrapPeers: parseBootstrapPeers(process.env['BOOTSTRAP_PEERS'] ?? ''),
    listenAddrs: process.env['LISTEN_ADDRS'] ?? '/ip4/0.0.0.0/tcp/0',
    maxPeers: parseInt(process.env['MAX_PEERS'] ?? '50', 10),
    penaltyScoreThreshold: parseInt(process.env['PENALTY_SCORE_THRESHOLD'] ?? '500', 10),
    temporalBanDurationMs: parseInt(process.env['TEMPORAL_BAN_DURATION_MS'] ?? '3600000', 10),
    penaltySafeIntervalMs: parseInt(process.env['PENALTY_SAFE_INTERVAL_MS'] ?? '120000', 10),
    peerEvictionIntervalMs: parseInt(process.env['PEER_EVICTION_INTERVAL_MS'] ?? '3600000', 10),
    syncRequestTimeoutMs: parseInt(process.env['SYNC_REQUEST_TIMEOUT_MS'] ?? '10000', 10),
  };
  return Object.freeze(cfg);
}

function parseBootstrapPeers(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
