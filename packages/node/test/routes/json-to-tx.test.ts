import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, LIKE_COST } from '@dagsocial/types';

import { jsonToTx } from '../../src/routes/json-to-tx.js';

/**
 * L-11 — `jsonToTx` used to copy the client-supplied box `value` verbatim,
 * which is the lever the C-1 forgery relied on. A `value` is bigint at
 * runtime (Spec B P0): the JSON edge coerces a decimal string or
 * safe-integer number to bigint and enforces `0 <= value < 2^64`.
 */
describe('jsonToTx box value validation (audit L-11, Spec B P0)', () => {
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

  it('coerces a non-negative integer number to bigint', () => {
    const tx = jsonToTx(rawTx(42));
    expect(tx.outputs[0]!.value).toBe(42n);
    // Hex fields are still decoded to raw bytes.
    expect(Buffer.from(tx.outputs[0]!.owner as Uint8Array).toString('hex')).toBe(ownerHex);
  });

  it('coerces a decimal string to bigint (canonical wire form)', () => {
    expect(jsonToTx(rawTx('10')).outputs[0]!.value).toBe(10n);
  });

  it('coerces a decimal string above 2^53 without precision loss', () => {
    const big = (1n << 60n).toString();
    expect(jsonToTx(rawTx(big)).outputs[0]!.value).toBe(1n << 60n);
  });

  it('accepts a zero value (fully-spent change box)', () => {
    expect(jsonToTx(rawTx(0)).outputs[0]!.value).toBe(0n);
  });

  it('accepts a value just below 2^64', () => {
    const max = ((1n << 64n) - 1n).toString();
    expect(jsonToTx(rawTx(max)).outputs[0]!.value).toBe((1n << 64n) - 1n);
  });

  for (const [label, badValue] of [
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    // Unsafe numbers have already lost precision — only strings carry >2^53.
    ['beyond MAX_SAFE_INTEGER as a number', Number.MAX_SAFE_INTEGER + 2],
    ['a negative string', '-5'],
    ['a fractional string', '1.5'],
    ['a non-decimal string', '0x10'],
    ['at 2^64', (1n << 64n).toString()],
    ['null', null],
    ['missing', undefined],
  ] as const) {
    it(`rejects a ${label} value`, () => {
      expect(() => jsonToTx(rawTx(badValue))).toThrow(
        /box value must be a non-negative/,
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

    expect(() => jsonToTx(raw)).toThrow(/box value must be a non-negative/);
  });

  it('coerces PostLockBox originalValue alongside value', () => {
    const raw = {
      inputs: ['cd'.repeat(32)],
      outputs: [
        {
          boxType: 'post_lock',
          value: '5',
          originalValue: '5',
          createdAtBlock: 10,
          owner: ownerHex,
          targetPostId: 'ef'.repeat(32),
          guard: 'epoch_tally',
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const tx = jsonToTx(raw);
    const out = tx.outputs[0]! as { value: bigint; originalValue: bigint };
    expect(out.value).toBe(5n);
    expect(out.originalValue).toBe(5n);
  });
});
