import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRecord(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Initialized tests
// ---------------------------------------------------------------------------

describe('journal (initialized)', () => {
  let capturedLines: string[];

  beforeEach(async () => {
    vi.resetModules();
    capturedLines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      capturedLines.push(String(chunk));
      return true;
    });
    const { initJournal } = await import('../src/journal.js');
    initJournal();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastRecord(): Record<string, unknown> | null {
    const last = capturedLines[capturedLines.length - 1];
    if (!last) return null;
    return parseRecord(last);
  }

  describe('emitEvent', () => {
    it('writes a JSON line with event, level, timestamp, and fields', async () => {
      const { emitEvent } = await import('../src/journal.js');
      emitEvent({ event: 'test_info', level: 'INFO', foo: 'bar' });

      expect(capturedLines.length).toBe(1);
      const record = parseRecord(capturedLines[0]!);
      expect(record.event).toBe('test_info');
      expect(record.level).toBe('INFO');
      expect(record.foo).toBe('bar');
      expect(typeof record.timestamp).toBe('string');
      expect(new Date(record.timestamp as string).toISOString()).toBe(record.timestamp);
    });

    it('does not throw for any level', async () => {
      const { emitEvent } = await import('../src/journal.js');
      expect(() => {
        emitEvent({ event: 'test_info', level: 'INFO', foo: 'bar' });
        emitEvent({ event: 'test_warn', level: 'WARN', baz: 42 });
        emitEvent({ event: 'test_error', level: 'ERROR', qux: true });
      }).not.toThrow();
    });

    it('outputs exactly one line per event', async () => {
      const { emitEvent } = await import('../src/journal.js');
      emitEvent({ event: 'a', level: 'INFO' });
      emitEvent({ event: 'b', level: 'WARN' });
      emitEvent({ event: 'c', level: 'ERROR' });
      expect(capturedLines.length).toBe(3);
    });

    it('each line ends with a newline', async () => {
      const { emitEvent } = await import('../src/journal.js');
      emitEvent({ event: 'test', level: 'INFO' });
      expect(capturedLines[0]!.endsWith('\n')).toBe(true);
    });
  });

  describe('lifecycle events', () => {
    it('emitServerStarting includes version and network', async () => {
      const { emitServerStarting } = await import('../src/journal.js');
      emitServerStarting('2.0.0', 'mainnet');
      const r = lastRecord();
      expect(r!.event).toBe('server_starting');
      expect(r!.level).toBe('INFO');
      expect(r!.version).toBe('2.0.0');
      expect(r!.network).toBe('mainnet');
    });

    it('emitServerReady includes bind address and duration', async () => {
      const { emitServerReady } = await import('../src/journal.js');
      emitServerReady('0.0.0.0:3000', '127.0.0.1:3001', 42);
      const r = lastRecord();
      expect(r!.event).toBe('server_ready');
      expect(r!.bind_address).toBe('0.0.0.0:3000');
      expect(r!.admin_address).toBe('127.0.0.1:3001');
      expect(r!.duration_ms).toBe(42);
    });

    it('emitShutdownSignalReceived records signal name', async () => {
      const { emitShutdownSignalReceived } = await import('../src/journal.js');
      emitShutdownSignalReceived('SIGTERM');
      const r = lastRecord();
      expect(r!.event).toBe('shutdown_signal_received');
      expect(r!.signal).toBe('SIGTERM');
    });

    it('emitServerShuttingDown records the reason', async () => {
      const { emitServerShuttingDown } = await import('../src/journal.js');
      emitServerShuttingDown('SIGINT');
      const r = lastRecord();
      expect(r!.event).toBe('server_shutting_down');
      expect(r!.reason).toBe('SIGINT');
    });
  });

  describe('core events', () => {
    it('emitPostReceived includes post_id and source', async () => {
      const { emitPostReceived } = await import('../src/journal.js');
      emitPostReceived('abc123', 'http');
      const r = lastRecord();
      expect(r!.event).toBe('post_received');
      expect(r!.post_id).toBe('abc123');
      expect(r!.source).toBe('http');
    });

    it('emitPostValidated includes post_id and timing', async () => {
      const { emitPostValidated } = await import('../src/journal.js');
      emitPostValidated('abc123', 15);
      const r = lastRecord();
      expect(r!.event).toBe('post_validated');
      expect(r!.validation_duration_ms).toBe(15);
    });

    it('emitPostIndexed includes post_id and depth', async () => {
      const { emitPostIndexed } = await import('../src/journal.js');
      emitPostIndexed('abc123', 42);
      const r = lastRecord();
      expect(r!.event).toBe('post_indexed');
      expect(r!.depth).toBe(42);
    });

    it('emitPowVerificationFailed includes post_id and reason (WARN)', async () => {
      const { emitPowVerificationFailed } = await import('../src/journal.js');
      emitPowVerificationFailed('abc123', 'difficulty too low');
      const r = lastRecord();
      expect(r!.event).toBe('pow_verification_failed');
      expect(r!.level).toBe('WARN');
      expect(r!.reason).toBe('difficulty too low');
    });

    it('emitDagReorg includes fork point and demoted count', async () => {
      const { emitDagReorg } = await import('../src/journal.js');
      emitDagReorg('fork123', 3, 'oldTip', 'newTip');
      const r = lastRecord();
      expect(r!.event).toBe('dag_reorg');
      expect(r!.level).toBe('WARN');
      expect(r!.fork_point).toBe('fork123');
      expect(r!.demoted).toBe(3);
    });
  });

  describe('anomaly events', () => {
    it('emitValidationStuck includes post_id, reason, and attempt count', async () => {
      const { emitValidationStuck } = await import('../src/journal.js');
      emitValidationStuck('abc123', 'timeout', 5);
      const r = lastRecord();
      expect(r!.event).toBe('validation_stuck');
      expect(r!.level).toBe('WARN');
      expect(r!.reason).toBe('timeout');
      expect(r!.attempt_count).toBe(5);
    });

    it('emitDagHeightDrift includes gap, mode, and old/new heights', async () => {
      const { emitDagHeightDrift } = await import('../src/journal.js');
      emitDagHeightDrift(10, 'stalled', 100, 110);
      const r = lastRecord();
      expect(r!.event).toBe('dag_height_drift');
      expect(r!.level).toBe('WARN');
      expect(r!.gap).toBe(10);
      expect(r!.mode).toBe('stalled');
    });
  });

  describe('peer events', () => {
    it('emitPeerConnected includes peer_id and direction', async () => {
      const { emitPeerConnected } = await import('../src/journal.js');
      emitPeerConnected('peer1', 'outbound');
      const r = lastRecord();
      expect(r!.event).toBe('peer_connected');
      expect(r!.peer_id).toBe('peer1');
      expect(r!.direction).toBe('outbound');
    });

    it('emitPeerDisconnected includes peer_id and reason', async () => {
      const { emitPeerDisconnected } = await import('../src/journal.js');
      emitPeerDisconnected('peer1', 'timeout');
      const r = lastRecord();
      expect(r!.event).toBe('peer_disconnected');
      expect(r!.peer_id).toBe('peer1');
      expect(r!.reason).toBe('timeout');
    });

    it('emitPeerPenalised includes peer_id, kind, and detail', async () => {
      const { emitPeerPenalised } = await import('../src/journal.js');
      emitPeerPenalised('peer1', 'invalid_pow', 'difficulty too low');
      const r = lastRecord();
      expect(r!.event).toBe('peer_penalised');
      expect(r!.level).toBe('WARN');
      expect(r!.peer_id).toBe('peer1');
      expect(r!.kind).toBe('invalid_pow');
      expect(r!.detail).toBe('difficulty too low');
    });

    it('emitPeerPenalised accepts null detail', async () => {
      const { emitPeerPenalised } = await import('../src/journal.js');
      emitPeerPenalised('peer1', 'timeout', null);
      const r = lastRecord();
      expect(r!.detail).toBeNull();
    });
  });

  describe('convenience emitters', () => {
    it('all convenience emitters do not throw', async () => {
      const {
        emitServerStarting,
        emitServerReady,
        emitShutdownSignalReceived,
        emitServerShuttingDown,
        emitPostReceived,
        emitPostValidated,
        emitPostIndexed,
        emitPowVerificationFailed,
        emitDagReorg,
        emitValidationStuck,
        emitDagHeightDrift,
        emitPeerConnected,
        emitPeerDisconnected,
        emitPeerPenalised,
      } = await import('../src/journal.js');

      expect(() => {
        emitServerStarting('1.0.0', 'mainnet');
        emitServerReady('0.0.0.0:3000', '127.0.0.1:3001', 100);
        emitShutdownSignalReceived('SIGTERM');
        emitServerShuttingDown('SIGTERM');
        emitPostReceived('abc123', 'http');
        emitPostValidated('abc123', 2);
        emitPostIndexed('abc123', 5);
        emitPowVerificationFailed('abc123', 'bad pow');
        emitDagReorg('fork1', 2, 'old', 'new');
        emitValidationStuck('abc123', 'stuck', 3);
        emitDagHeightDrift(5, 'drift', 10, 15);
        emitPeerConnected('peer1', 'outbound');
        emitPeerDisconnected('peer1', 'timeout');
        emitPeerPenalised('peer1', 'invalid_pow', 'difficulty too low');
      }).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Uninitialized tests — separate describe to reset modules
// ---------------------------------------------------------------------------

describe('journal (uninitialized)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emitEvent is a no-op when journal is not initialized', async () => {
    const mockWrite = vi.fn();
    vi.spyOn(process.stdout, 'write').mockImplementation(mockWrite);

    const { emitEvent } = await import('../src/journal.js');
    emitEvent({ event: 'test', level: 'INFO' });

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('convenience emitters are also no-ops when uninitialized', async () => {
    const mockWrite = vi.fn();
    vi.spyOn(process.stdout, 'write').mockImplementation(mockWrite);

    const { emitServerStarting, emitPeerConnected } = await import('../src/journal.js');
    emitServerStarting('1.0.0', 'testnet');
    emitPeerConnected('peer1', 'outbound');

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('initJournal is idempotent — calling twice does not throw', async () => {
    const { initJournal, emitEvent } = await import('../src/journal.js');
    expect(() => {
      initJournal();
      initJournal();
      initJournal();
    }).not.toThrow();
    // After init, events should work
    emitEvent({ event: 'after_init', level: 'INFO' });
    // We don't assert write here since we didn't mock — just testing no throw
  });
});
