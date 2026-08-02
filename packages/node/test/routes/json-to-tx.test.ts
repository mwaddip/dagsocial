import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, LIKE_COST } from '@dagsocial/types';

import { jsonToTx } from '../../src/routes/json-to-tx.js';

/**
 * L-11 — `jsonToTx` used to copy the client-supplied box `value` verbatim,
 * which is the lever the C-1 forgery relied on. A `value` must be a
 * non-negative integer that JS can sum exactly.
 */
describe('jsonToTx box value validation (audit L-11)', () => {
  const ownerHex = 'ab'.repeat(32);

  function rawTx(value: unknown): Record<string, unknown> {
    return {
      inputs: ['cd'.repeat(32)],
      outputs: [
        {
          boxType: 'karma',
          value,
          createdAtBlock: 10,
          owner: ownerHex,
          guard: 'owner_signature',
          proofSource: 'test',
          lastTouchBlock: 10,
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  it('accepts a non-negative integer value', () => {
    const tx = jsonToTx(rawTx(42));
    expect(tx.outputs[0]!.value).toBe(42);
    // Hex fields are still decoded to raw bytes.
    expect(Buffer.from(tx.outputs[0]!.owner as Uint8Array).toString('hex')).toBe(ownerHex);
  });

  it('accepts a zero value (fully-spent change box)', () => {
    expect(jsonToTx(rawTx(0)).outputs[0]!.value).toBe(0);
  });

  for (const [label, badValue] of [
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
    ['a string', '10'],
    ['null', null],
    ['missing', undefined],
  ] as const) {
    it(`rejects a ${label} value`, () => {
      expect(() => jsonToTx(rawTx(badValue))).toThrow(
        'box value must be a non-negative integer',
      );
    });
  }

  it('rejects when any one output in a multi-output tx is invalid', () => {
    const raw = rawTx(100);
    (raw.outputs as Record<string, unknown>[]).push({
      boxType: 'like',
      value: -LIKE_COST,
      createdAtBlock: 10,
      likerId: ownerHex,
      targetPostId: 'ef'.repeat(32),
      guard: 'epoch_tally',
    });

    expect(() => jsonToTx(raw)).toThrow('box value must be a non-negative integer');
  });
});
