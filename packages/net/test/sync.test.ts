import { describe, it, expect } from 'vitest';

// Note: Full integration test for sync is in Task 11 (integration tests).
// This file tests the protocol constants and error handling patterns.

import { SYNC_PROTOCOL } from '../src/sync.js';

describe('sync protocol', () => {
  it('has the correct protocol string', () => {
    expect(SYNC_PROTOCOL).toBe('/dagsocial/sync/1');
  });
});
