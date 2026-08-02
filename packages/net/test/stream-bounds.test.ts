import { describe, it, expect } from 'vitest';
import { readStreamBounded } from '../src/util.js';
import { MAX_STREAM_BYTES } from '../src/msg-guards.js';

/**
 * A stream that never ends — what a hostile peer gives you for free.
 *
 * `yields` counts how many chunks were actually pulled and `closed` records
 * whether the reader shut the source down, so a test can prove the reader stops
 * rather than merely that it eventually returns.
 */
async function* endless(
  chunk: Uint8Array,
  state: { yields: number; closed: boolean },
): AsyncGenerator<Uint8Array> {
  try {
    for (;;) {
      state.yields++;
      yield chunk;
    }
  } finally {
    state.closed = true;
  }
}

async function* fromChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

describe('readStreamBounded (audit H-9)', () => {
  it('concatenates the chunks of a normal stream', async () => {
    const result = await readStreamBounded(
      fromChunks([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]),
      1024,
    );
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('returns an empty buffer for a stream that carries nothing', async () => {
    const result = await readStreamBounded(fromChunks([]), 1024);
    // Empty is a legitimate outcome and must stay distinguishable from over-cap.
    expect(result).toEqual(new Uint8Array(0));
    expect(result).not.toBeNull();
  });

  it('accepts a stream of exactly maxBytes', async () => {
    const result = await readStreamBounded(fromChunks([new Uint8Array(512), new Uint8Array(512)]), 1024);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1024);
  });

  it('rejects a stream one byte over maxBytes', async () => {
    const result = await readStreamBounded(fromChunks([new Uint8Array(512), new Uint8Array(513)]), 1024);
    expect(result).toBeNull();
  });

  it('stops reading an endless stream instead of buffering it', async () => {
    const state = { yields: 0, closed: false };

    const result = await readStreamBounded(endless(new Uint8Array(1024), state), 4096);

    expect(result).toBeNull();
    // Four chunks fit; the fifth tips over the cap and reading stops there.
    // Without the cap this call never returns.
    expect(state.yields).toBe(5);
    expect(state.closed).toBe(true);
  });

  it('rejects a single chunk that is already over the cap', async () => {
    const state = { yields: 0, closed: false };

    const result = await readStreamBounded(endless(new Uint8Array(9000), state), 4096);

    expect(result).toBeNull();
    expect(state.yields).toBe(1);
    expect(state.closed).toBe(true);
  });

  it('accepts Uint8ArrayList-style chunks', async () => {
    // libp2p yields a Uint8ArrayList, not a Uint8Array — the reader has to
    // flatten it rather than assume raw bytes.
    async function* listChunks(): AsyncGenerator<{ subarray(): Uint8Array }> {
      yield { subarray: () => new Uint8Array([7, 8]) };
      yield { subarray: () => new Uint8Array([9]) };
    }
    const result = await readStreamBounded(listChunks(), 1024);
    expect(result).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('defaults to MAX_STREAM_BYTES', async () => {
    const state = { yields: 0, closed: false };
    const megabyte = new Uint8Array(1024 * 1024);

    const result = await readStreamBounded(endless(megabyte, state));

    expect(result).toBeNull();
    expect(state.yields).toBe(MAX_STREAM_BYTES / megabyte.length + 1);
    expect(state.closed).toBe(true);
  });
});
