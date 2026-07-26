import { describe, it, expect, vi } from 'vitest';
import { handleModifierRequest } from '../src/gossip.js';
import type { GossipDeps } from '../src/gossip.js';

describe('serve-before-relay', () => {
  it('serves from local store when data is available', () => {
    const testData = new Uint8Array([1, 2, 3]);
    const sendTo = vi.fn();
    const relay = vi.fn();

    const deps: GossipDeps = {
      localServe: () => testData,
      relay,
      sendTo,
    };

    handleModifierRequest(deps, 'peer1', 1, new Uint8Array(32));

    expect(sendTo).toHaveBeenCalledWith('peer1', testData);
    expect(relay).not.toHaveBeenCalled();
  });

  it('relays when local store does not have data', () => {
    const sendTo = vi.fn();
    const relay = vi.fn();

    const deps: GossipDeps = {
      localServe: () => null,
      relay,
      sendTo,
    };

    const id = new Uint8Array(32);
    handleModifierRequest(deps, 'peer1', 1, id);

    expect(sendTo).not.toHaveBeenCalled();
    expect(relay).toHaveBeenCalledWith(1, id, 'peer1');
  });

  it('never both serves and relays for the same request', () => {
    const deps: GossipDeps = {
      localServe: () => new Uint8Array([1]),
      relay: () => {
        throw new Error('relay should not be called when local data exists');
      },
      sendTo: () => {},
    };

    // Should not throw — relay is never called
    expect(() => {
      handleModifierRequest(deps, 'peer1', 1, new Uint8Array(32));
    }).not.toThrow();
  });
});
