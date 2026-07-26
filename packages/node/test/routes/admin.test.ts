import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import {
  createAdminRouter,
  updateHealthState,
  incrementCounter,
  type HealthState,
} from '../../src/routes/admin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminApp(): express.Express {
  const app = express();
  app.use(createAdminRouter());
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      http
        .get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: body });
            }
          });
        })
        .on('error', (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// Reset state to a known baseline before each test
function resetState() {
  updateHealthState({
    dagTipHeight: 0,
    validatedHeight: 0,
    indexedHeight: 0,
    peersConnected: 0,
    lastPostReceivedMsAgo: 0,
    syncing: false,
    startTime: Date.now(),
    postsCreatedTotal: 0,
    postsValidatedTotal: 0,
    powVerificationsTotal: 0,
    powVerificationFailuresTotal: 0,
    peerMessagesInTotal: 0,
    peerMessagesOutTotal: 0,
    peerBytesInTotal: 0,
    peerBytesOutTotal: 0,
    httpRequestsTotal: 0,
    unknownMessageTypesTotal: 0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin routes', () => {
  beforeEach(() => {
    resetState();
  });

  // -- /health -----------------------------------------------------------------

  describe('GET /health', () => {
    it('returns 200', async () => {
      const { status } = await get(adminApp(), '/health');
      expect(status).toBe(200);
    });

    it('returns expected shape with default state', async () => {
      const { data } = await get(adminApp(), '/health');
      const body = data as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.dag_tip_height).toBe(0);
      expect(body.validated_height).toBe(0);
      expect(body.indexed_height).toBe(0);
      expect(body.peers_connected).toBe(0);
      expect(body.syncing).toBe(false);
      expect(typeof body.uptime_seconds).toBe('number');
      expect(body.apiVersion).toBe('1.0');
      expect(body.journalEventsVersion).toBe('1.0');
    });

    it('reflects updated state', async () => {
      updateHealthState({
        dagTipHeight: 42,
        peersConnected: 3,
        syncing: true,
      });
      const { data } = await get(adminApp(), '/health');
      const body = data as Record<string, unknown>;
      expect(body.dag_tip_height).toBe(42);
      expect(body.peers_connected).toBe(3);
      expect(body.syncing).toBe(true);
      // Other fields should not have been zeroed
      expect(body.status).toBe('ok');
    });

    it('uptime_seconds increases over time', async () => {
      // startTime already set to Date.now() via resetState
      const { data: data1 } = await get(adminApp(), '/health');
      const uptime1 = (data1 as Record<string, unknown>).uptime_seconds as number;
      // Wait a small amount
      await new Promise((r) => setTimeout(r, 1100));
      const { data: data2 } = await get(adminApp(), '/health');
      const uptime2 = (data2 as Record<string, unknown>).uptime_seconds as number;
      expect(uptime2).toBeGreaterThanOrEqual(uptime1 + 1);
    }, 5000);
  });

  // -- /stats ------------------------------------------------------------------

  describe('GET /stats', () => {
    it('returns 200', async () => {
      const { status } = await get(adminApp(), '/stats');
      expect(status).toBe(200);
    });

    it('returns since as a Unix timestamp', async () => {
      const { data } = await get(adminApp(), '/stats');
      const body = data as Record<string, unknown>;
      expect(typeof body.since).toBe('number');
      expect(body.since).toBeGreaterThan(0);
    });

    it('returns statsVersion', async () => {
      const { data } = await get(adminApp(), '/stats');
      const body = data as Record<string, unknown>;
      expect(body.statsVersion).toBe('1.0');
    });

    it('returns all cumulative counters with default zeros', async () => {
      const { data } = await get(adminApp(), '/stats');
      const body = data as Record<string, unknown>;
      const counters = body.counters as Record<string, unknown>;
      expect(counters.posts_created_total).toBe(0);
      expect(counters.posts_validated_total).toBe(0);
      expect(counters.pow_verifications_total).toBe(0);
      expect(counters.pow_verification_failures_total).toBe(0);
      expect(counters.peer_messages_in_total).toBe(0);
      expect(counters.peer_messages_out_total).toBe(0);
      expect(counters.peer_bytes_in_total).toBe(0);
      expect(counters.peer_bytes_out_total).toBe(0);
      expect(counters.http_requests_total).toBe(0);
      expect(counters.unknown_message_types_total).toBe(0);
    });

    it('reflects updated counters', async () => {
      updateHealthState({
        postsCreatedTotal: 5,
        postsValidatedTotal: 3,
        httpRequestsTotal: 100,
      });
      const { data } = await get(adminApp(), '/stats');
      const body = data as Record<string, unknown>;
      const counters = body.counters as Record<string, unknown>;
      expect(counters.posts_created_total).toBe(5);
      expect(counters.posts_validated_total).toBe(3);
      expect(counters.http_requests_total).toBe(100);
    });
  });

  // -- incrementCounter ---------------------------------------------------------

  describe('incrementCounter', () => {
    it('verifies incrementCounter via /stats', async () => {
      resetState();
      incrementCounter('postsCreatedTotal');
      incrementCounter('postsCreatedTotal');
      incrementCounter('powVerificationsTotal');

      const { data } = await get(adminApp(), '/stats');
      const body = data as Record<string, unknown>;
      const counters = body.counters as Record<string, unknown>;
      expect(counters.posts_created_total).toBe(2);
      expect(counters.pow_verifications_total).toBe(1);
      // Others should still be 0
      expect(counters.pow_verification_failures_total).toBe(0);
    });

    it('is a no-op for non-numeric fields', async () => {
      resetState();
      incrementCounter('syncing' as keyof HealthState); // boolean field
      const { data } = await get(adminApp(), '/health');
      const body = data as Record<string, unknown>;
      // syncing should still be false
      expect(body.syncing).toBe(false);
    });
  });
});
