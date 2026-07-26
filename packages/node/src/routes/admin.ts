import { Router } from 'express';

// ---------------------------------------------------------------------------
// In-memory state (populated by the main process via updateHealthState / incrementCounter)
// ---------------------------------------------------------------------------

export interface HealthState {
  dagTipHeight: number;
  validatedHeight: number;
  indexedHeight: number;
  peersConnected: number;
  lastPostReceivedMsAgo: number;
  syncing: boolean;
  startTime: number;
  postsCreatedTotal: number;
  postsValidatedTotal: number;
  powVerificationsTotal: number;
  powVerificationFailuresTotal: number;
  peerMessagesInTotal: number;
  peerMessagesOutTotal: number;
  peerBytesInTotal: number;
  peerBytesOutTotal: number;
  httpRequestsTotal: number;
  unknownMessageTypesTotal: number;
}

const state: HealthState = {
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
};

/**
 * Update one or more fields of the health state. Only the keys provided are
 * changed; all other fields retain their existing values.
 */
export function updateHealthState(update: Partial<HealthState>): void {
  Object.assign(state, update);
}

/**
 * Increment a numeric counter in the health state. No-op if the field does not
 * exist or is not a number.
 */
export function incrementCounter(name: keyof HealthState): void {
  if (typeof state[name] === 'number') {
    (state[name] as number)++;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAdminRouter(): Router {
  const router = Router();

  // GET /health — in-memory only, never touches DB, always 200
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      dag_tip_height: state.dagTipHeight,
      validated_height: state.validatedHeight,
      indexed_height: state.indexedHeight,
      peers_connected: state.peersConnected,
      last_post_received_ms_ago: state.lastPostReceivedMsAgo,
      syncing: state.syncing,
      uptime_seconds: Math.floor((Date.now() - state.startTime) / 1000),
      apiVersion: '1.0',
      journalEventsVersion: '1.0',
    });
  });

  // GET /stats — cumulative counters with since
  router.get('/stats', (_req, res) => {
    res.json({
      since: Math.floor(state.startTime / 1000),
      statsVersion: '1.0',
      counters: {
        posts_created_total: state.postsCreatedTotal,
        posts_validated_total: state.postsValidatedTotal,
        pow_verifications_total: state.powVerificationsTotal,
        pow_verification_failures_total: state.powVerificationFailuresTotal,
        peer_messages_in_total: state.peerMessagesInTotal,
        peer_messages_out_total: state.peerMessagesOutTotal,
        peer_bytes_in_total: state.peerBytesInTotal,
        peer_bytes_out_total: state.peerBytesOutTotal,
        http_requests_total: state.httpRequestsTotal,
        unknown_message_types_total: state.unknownMessageTypesTotal,
      },
    });
  });

  return router;
}
