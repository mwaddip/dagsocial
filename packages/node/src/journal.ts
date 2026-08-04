// ---------------------------------------------------------------------------
// Structured journal events — JSON-line output to stdout
//
// One JSON object per line: { event, level, timestamp, ...fields }
// No external dependencies — uses a lightweight JSON.stringify wrapper.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JournalEvent {
  event: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let _initialized = false;

/**
 * Initialize the journal. Must be called once at startup before any events
 * are emitted. Subsequent calls are no-ops.
 */
export function initJournal(): void {
  if (_initialized) return;
  _initialized = true;
}

/**
 * Emit a structured journal event as a single JSON line to stdout.
 * No-op if the journal is not initialized.
 */
export function emitEvent(event: JournalEvent): void {
  if (!_initialized) return;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  // Amount fields (decay/mint events) are bigint — JSON.stringify throws on
  // bigint, so serialize them as decimal strings.
  process.stdout.write(
    JSON.stringify(record, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Convenience emitters for lifecycle events
// ---------------------------------------------------------------------------

export function emitServerStarting(version: string, network: string): void {
  emitEvent({ event: 'server_starting', level: 'INFO', version, network });
}

export function emitServerReady(bindAddress: string, adminAddress: string, durationMs: number): void {
  emitEvent({
    event: 'server_ready', level: 'INFO',
    bind_address: bindAddress, admin_address: adminAddress, duration_ms: durationMs,
  });
}

export function emitShutdownSignalReceived(signal: string): void {
  emitEvent({ event: 'shutdown_signal_received', level: 'INFO', signal });
}

export function emitServerShuttingDown(reason: string): void {
  emitEvent({ event: 'server_shutting_down', level: 'INFO', reason });
}

// ---------------------------------------------------------------------------
// Convenience emitters for core events
// ---------------------------------------------------------------------------

export function emitPostReceived(postId: string, source: string): void {
  emitEvent({ event: 'post_received', level: 'INFO', post_id: postId, source });
}

export function emitPostValidated(postId: string, validationDurationMs: number): void {
  emitEvent({ event: 'post_validated', level: 'INFO', post_id: postId, validation_duration_ms: validationDurationMs });
}

export function emitPostIndexed(postId: string, depth: number): void {
  emitEvent({ event: 'post_indexed', level: 'INFO', post_id: postId, depth });
}

export function emitPowVerificationFailed(postId: string, reason: string): void {
  emitEvent({ event: 'pow_verification_failed', level: 'WARN', post_id: postId, reason });
}

export function emitDagReorg(forkPoint: string, demoted: number, oldTip: string, newTip: string): void {
  emitEvent({
    event: 'dag_reorg', level: 'WARN',
    fork_point: forkPoint, demoted, old_tip: oldTip, new_tip: newTip,
  });
}

// ---------------------------------------------------------------------------
// Convenience emitters for anomaly events
// ---------------------------------------------------------------------------

export function emitValidationStuck(postId: string, reason: string, attemptCount: number): void {
  emitEvent({
    event: 'validation_stuck', level: 'WARN',
    post_id: postId, reason, attempt_count: attemptCount,
  });
}

export function emitDagHeightDrift(gap: number, mode: string, oldHeight: number, newHeight: number): void {
  emitEvent({
    event: 'dag_height_drift', level: 'WARN',
    gap, mode, old_height: oldHeight, new_height: newHeight,
  });
}

// ---------------------------------------------------------------------------
// Convenience emitters for peer events
// ---------------------------------------------------------------------------

export function emitPeerConnected(peerId: string, direction: 'inbound' | 'outbound'): void {
  emitEvent({ event: 'peer_connected', level: 'INFO', peer_id: peerId, direction });
}

export function emitPeerDisconnected(peerId: string, reason: string): void {
  emitEvent({ event: 'peer_disconnected', level: 'INFO', peer_id: peerId, reason });
}

export function emitPeerPenalised(peerId: string, kind: string, detail: string | null): void {
  emitEvent({ event: 'peer_penalised', level: 'WARN', peer_id: peerId, kind, detail });
}
