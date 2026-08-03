import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadNetConfig } from '../src/config.js';

describe('loadNetConfig', () => {
  beforeEach(() => {
    // Clear relevant env vars
    delete process.env['BOOTSTRAP_PEERS'];
    delete process.env['LISTEN_ADDRS'];
    delete process.env['MAX_PEERS'];
    delete process.env['PENALTY_SCORE_THRESHOLD'];
    delete process.env['TEMPORAL_BAN_DURATION_MS'];
    delete process.env['PENALTY_SAFE_INTERVAL_MS'];
    delete process.env['SYNC_REQUEST_TIMEOUT_MS'];
  });

  afterEach(() => {
    delete process.env['BOOTSTRAP_PEERS'];
  });

  it('returns defaults with no env vars set', () => {
    const cfg = loadNetConfig();
    expect(cfg.bootstrapPeers).toEqual([]);
    expect(cfg.listenAddrs).toBe('/ip4/0.0.0.0/tcp/0');
    expect(cfg.maxPeers).toBe(50);
    expect(cfg.penaltyScoreThreshold).toBe(500);
    expect(cfg.temporalBanDurationMs).toBe(3600000);
    expect(cfg.penaltySafeIntervalMs).toBe(120000);
    expect(cfg.syncRequestTimeoutMs).toBe(10000);
  });

  it('parses comma-separated bootstrap peers', () => {
    process.env['BOOTSTRAP_PEERS'] = '/ip4/1.2.3.4/tcp/9001,/ip4/5.6.7.8/tcp/9002';
    const cfg = loadNetConfig();
    expect(cfg.bootstrapPeers).toEqual([
      '/ip4/1.2.3.4/tcp/9001',
      '/ip4/5.6.7.8/tcp/9002',
    ]);
  });

  it('handles empty bootstrap peers string', () => {
    process.env['BOOTSTRAP_PEERS'] = '';
    const cfg = loadNetConfig();
    expect(cfg.bootstrapPeers).toEqual([]);
  });

  it('honors overridden values', () => {
    process.env['MAX_PEERS'] = '10';
    process.env['PENALTY_SCORE_THRESHOLD'] = '100';
    const cfg = loadNetConfig();
    expect(cfg.maxPeers).toBe(10);
    expect(cfg.penaltyScoreThreshold).toBe(100);
  });
});
