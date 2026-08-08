import { describe, it, expect } from 'vitest';
import { encode } from 'cbor-x';
import {
  encodeSyncInfo, decodeSyncInfo,
  encodeInv, decodeInv,
  encodeModifierRequest, decodeModifierRequest,
  encodeModifierResponse, decodeModifierResponse,
  decodeGetPosts, decodePosts,
  decodeLegacyHeadersRequest,
} from '@dagsocial/net';
import { MAGIC_TESTNET, decodeFrame, MAX_ADVERTISED_HEIGHT } from '@dagsocial/net';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE } from '@dagsocial/net';

/** CBOR-encode a value as a raw message body (no frame). */
function body(v: unknown): Uint8Array {
  return new Uint8Array(encode(v));
}

/** Bytes that are not well-formed CBOR. */
const GARBAGE = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

describe('sync codec', () => {
  it('round-trips SyncInfo', () => {
    const info = {
      tipHeight: 42,
      tipBlockId: 'abc123',
      tipCumulativeWork: '1000000',
      anchors: [{ height: 42, blockId: 'abc123' }],
    };
    const frame = encodeSyncInfo(MAGIC_TESTNET, info);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_SYNC_INFO);
    expect(decodeSyncInfo(b)).toEqual(info);
  });

  it('round-trips Inv', () => {
    const inv = { typeId: 101, ids: ['a', 'b', 'c'] };
    const frame = encodeInv(MAGIC_TESTNET, inv);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_INV);
    expect(decodeInv(b)).toEqual(inv);
  });

  it('round-trips ModifierRequest', () => {
    const req = { typeId: 101, ids: Array.from({length: 400}, (_, i) => `id${i}`) };
    const frame = encodeModifierRequest(MAGIC_TESTNET, req);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_REQUEST);
    expect(decodeModifierRequest(b)).toEqual(req);
  });

  it('round-trips ModifierResponse with binary data', () => {
    const resp = {
      typeId: 101,
      modifiers: [
        { id: 'header1', data: new Uint8Array([1, 2, 3]) },
        { id: 'header2', data: new Uint8Array([4, 5, 6]) },
      ],
    };
    const frame = encodeModifierResponse(MAGIC_TESTNET, resp);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_RESPONSE);
    const decoded = decodeModifierResponse(b);
    expect(decoded!.typeId).toBe(101);
    expect(decoded!.modifiers).toHaveLength(2);
    expect(decoded!.modifiers[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });
});

// ---------------------------------------------------------------------------
// Decode boundary — malformed input yields null, never a throw (audit C-7)
// ---------------------------------------------------------------------------

describe('sync codec decode boundary', () => {
  const decoders = {
    decodeSyncInfo,
    decodeInv,
    decodeModifierRequest,
    decodeModifierResponse,
    decodeGetPosts,
    decodePosts,
    decodeLegacyHeadersRequest,
  };

  for (const [name, decodeFn] of Object.entries(decoders)) {
    it(`${name} returns null on non-CBOR bytes`, () => {
      expect(decodeFn(GARBAGE)).toBeNull();
    });

    it(`${name} returns null on a non-map body`, () => {
      expect(decodeFn(body(7))).toBeNull();
      expect(decodeFn(body([1, 2]))).toBeNull();
      expect(decodeFn(body(null))).toBeNull();
    });

    it(`${name} returns null on an empty map`, () => {
      expect(decodeFn(body({}))).toBeNull();
    });
  }

  describe('SyncInfo', () => {
    const valid = {
      tipHeight: 10,
      tipBlockId: 'abc',
      tipCumulativeWork: '99',
      anchors: [{ height: 5, blockId: 'def' }],
    };

    it('accepts a well-formed body', () => {
      expect(decodeSyncInfo(body(valid))).toEqual(valid);
    });

    it('rejects a negative tipHeight', () => {
      expect(decodeSyncInfo(body({ ...valid, tipHeight: -1 }))).toBeNull();
      expect(decodeSyncInfo(body({ ...valid, tipHeight: -1_000_000_000 }))).toBeNull();
    });

    it('rejects a tipHeight above MAX_ADVERTISED_HEIGHT', () => {
      expect(decodeSyncInfo(body({ ...valid, tipHeight: MAX_ADVERTISED_HEIGHT + 1 }))).toBeNull();
    });

    it('rejects a fractional or NaN tipHeight', () => {
      expect(decodeSyncInfo(body({ ...valid, tipHeight: 1.5 }))).toBeNull();
      expect(decodeSyncInfo(body({ ...valid, tipHeight: NaN }))).toBeNull();
    });

    it('rejects a negative anchor height', () => {
      expect(decodeSyncInfo(body({ ...valid, anchors: [{ height: -5, blockId: 'x' }] }))).toBeNull();
    });

    it('rejects a non-array anchors', () => {
      expect(decodeSyncInfo(body({ ...valid, anchors: 'none' }))).toBeNull();
    });

    it('rejects an anchor that is not a map', () => {
      expect(decodeSyncInfo(body({ ...valid, anchors: ['nope'] }))).toBeNull();
    });

    it('rejects a non-numeric cumulative work string', () => {
      expect(decodeSyncInfo(body({ ...valid, tipCumulativeWork: 'lots' }))).toBeNull();
      expect(decodeSyncInfo(body({ ...valid, tipCumulativeWork: 99 }))).toBeNull();
    });

    it('ignores unknown extra fields', () => {
      expect(decodeSyncInfo(body({ ...valid, futureField: true }))).toEqual(valid);
    });
  });

  describe('Inv / ModifierRequest', () => {
    it('rejects a body missing ids — the audit payload {typeId: 101}', () => {
      expect(decodeModifierRequest(body({ typeId: 101 }))).toBeNull();
      expect(decodeInv(body({ typeId: 101 }))).toBeNull();
    });

    it('rejects ids that is not an array', () => {
      expect(decodeModifierRequest(body({ typeId: 101, ids: 'all' }))).toBeNull();
    });

    it('rejects ids holding a non-string', () => {
      expect(decodeModifierRequest(body({ typeId: 101, ids: ['a', 5] }))).toBeNull();
    });

    it('rejects a missing or negative typeId', () => {
      expect(decodeInv(body({ ids: ['a'] }))).toBeNull();
      expect(decodeInv(body({ typeId: -1, ids: ['a'] }))).toBeNull();
    });

    it('accepts an unknown but bounded typeId — handlers decide, not the boundary', () => {
      expect(decodeInv(body({ typeId: 999, ids: ['a'] }))).toEqual({ typeId: 999, ids: ['a'] });
    });

    it('accepts an empty id list', () => {
      expect(decodeInv(body({ typeId: 101, ids: [] }))).toEqual({ typeId: 101, ids: [] });
    });
  });

  describe('ModifierResponse', () => {
    it('rejects a body missing modifiers', () => {
      expect(decodeModifierResponse(body({ typeId: 101 }))).toBeNull();
    });

    it('rejects a modifier that is not a map', () => {
      expect(decodeModifierResponse(body({ typeId: 101, modifiers: ['x'] }))).toBeNull();
    });

    it('rejects a modifier with non-binary data', () => {
      expect(decodeModifierResponse(body({ typeId: 101, modifiers: [{ id: 'a', data: 'hex' }] }))).toBeNull();
    });

    it('rejects a modifier with a non-string id', () => {
      expect(decodeModifierResponse(body({ typeId: 101, modifiers: [{ id: 5, data: new Uint8Array([1]) }] }))).toBeNull();
    });
  });

  describe('GetPosts', () => {
    it('rejects a body missing its id list', () => {
      expect(decodeGetPosts(body({ ids: ['a'] }))).toBeNull();
    });

    it('rejects a non-string id', () => {
      expect(decodeGetPosts(body({ postIds: [1] }))).toBeNull();
    });

    it('accepts a well-formed request', () => {
      expect(decodeGetPosts(body({ postIds: ['a', 'b'] }))).toEqual({ postIds: ['a', 'b'] });
    });
  });

  describe('Posts responses', () => {
    it('rejects an entry whose envelope is not walkable', () => {
      expect(decodePosts(body({ entries: ['nope'] }))).toBeNull();
      expect(decodePosts(body({ entries: [{ postId: 'a', post: 'not-a-map' }] }))).toBeNull();
    });

    // P2-D acceptance pin, two-sided: this exact entry — no likeBoxes — was
    // rejected by the pre-P2-D decoder (reproduced on cffc202: decodePosts →
    // null). The Posts envelope no longer carries the field; the same entry
    // must decode.
    it('accepts a well-formed envelope without likeBoxes (P2-D pin)', () => {
      const posts = { entries: [{ postId: 'a', post: { content: 'hi' } }] };
      expect(decodePosts(body(posts))).toEqual(posts);
    });

    // The stated wire-compat posture (no shim): unknown keys are ignored, so a
    // stale peer's old-style entry still decodes — and the retired field does
    // not leak inward: the rebuilt entry carries no likeBoxes key.
    it("ignores a stale peer's likeBoxes field", () => {
      const stale = { entries: [{ postId: 'a', post: { content: 'hi' }, likeBoxes: [] }] };
      expect(decodePosts(body(stale))).toEqual({ entries: [{ postId: 'a', post: { content: 'hi' } }] });
    });
  });

  describe('legacy headers request', () => {
    it('accepts a well-formed request', () => {
      expect(decodeLegacyHeadersRequest(body({ startHeight: 10, maxCount: 5 })))
        .toEqual({ startHeight: 10, maxCount: 5 });
      expect(decodeLegacyHeadersRequest(body({ startHeight: 1, endHeight: 3, mode: 'blocks' })))
        .toEqual({ startHeight: 1, endHeight: 3, mode: 'blocks' });
    });

    it('rejects a negative startHeight', () => {
      expect(decodeLegacyHeadersRequest(body({ startHeight: -1 }))).toBeNull();
    });

    it('rejects out-of-range endHeight — a 1e15 span would freeze the serve loop', () => {
      expect(decodeLegacyHeadersRequest(body({ startHeight: 0, endHeight: 1e15, mode: 'blocks' }))).toBeNull();
    });

    it('rejects a non-integer maxCount', () => {
      expect(decodeLegacyHeadersRequest(body({ startHeight: 1, maxCount: -5 }))).toBeNull();
      expect(decodeLegacyHeadersRequest(body({ startHeight: 1, maxCount: 'all' }))).toBeNull();
    });
  });
});
