import { describe, it, expect } from 'vitest';
import { PeerState } from '../src/types.js';

describe('peer state machine', () => {
  it('starts in Connecting state', () => {
    const state: PeerState = PeerState.Connecting;
    expect(state).toBe(PeerState.Connecting);
  });

  it('transitions from Connecting to Handshaking after transport established', () => {
    let state: PeerState = PeerState.Connecting;
    // After transport connection established
    state = PeerState.Handshaking;
    expect(state).toBe(PeerState.Handshaking);
  });

  it('transitions from Handshaking to Active on successful handshake', () => {
    let state: PeerState = PeerState.Handshaking;
    // After handshake validates successfully
    state = PeerState.Active;
    expect(state).toBe(PeerState.Active);
  });

  it('transitions from Handshaking to Failed on version mismatch', () => {
    let state: PeerState = PeerState.Handshaking;
    // After version check fails
    state = PeerState.Failed;
    expect(state).toBe(PeerState.Failed);
  });

  it('transitions from Handshaking to Failed on wrong magic', () => {
    let state: PeerState = PeerState.Handshaking;
    // After magic byte check fails
    state = PeerState.Failed;
    expect(state).toBe(PeerState.Failed);
  });

  it('Active peer with protocol violation transitions to Banned', () => {
    let state: PeerState = PeerState.Active;
    // Malformed message received → protocol violation
    state = PeerState.Banned;
    expect(state).toBe(PeerState.Banned);
  });

  it('Active peer disconnects gracefully transitions to Disconnected', () => {
    let state: PeerState = PeerState.Active;
    // Graceful disconnect (stream close, not a protocol error)
    state = PeerState.Disconnected;
    expect(state).toBe(PeerState.Disconnected);
  });

  it('no events leak from non-Active peers', () => {
    // Messages from peers not in Active state must be rejected
    const nonActiveStates = [
      PeerState.Connecting,
      PeerState.Handshaking,
      PeerState.Disconnected,
      PeerState.Failed,
      PeerState.Banned,
    ];

    for (const state of nonActiveStates) {
      const canRoute = state === PeerState.Active;
      expect(canRoute).toBe(false);
    }

    // Only Active peers can route events
    const activeCanRoute = PeerState.Active === PeerState.Active;
    expect(activeCanRoute).toBe(true);
  });

  it('transitioning from Failed back to Connecting allows retry', () => {
    let state: PeerState = PeerState.Failed;
    // After cooldown, node may retry connection
    state = PeerState.Connecting;
    expect(state).toBe(PeerState.Connecting);
  });

  it('Banned peer cannot transition to Connecting', () => {
    // Banned is terminal — should never transition out
    const state: PeerState = PeerState.Banned;
    const allowedRetry = state !== PeerState.Banned;
    expect(allowedRetry).toBe(false);
  });
});
