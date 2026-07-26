import { describe, it, expect } from 'vitest';
import {
  encodeSyncInfo, decodeSyncInfo,
  encodeInv, decodeInv,
  encodeModifierRequest, decodeModifierRequest,
  encodeModifierResponse, decodeModifierResponse,
} from '@dagsocial/net';
import { MAGIC_TESTNET, decodeFrame } from '@dagsocial/net';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE } from '@dagsocial/net';

describe('sync codec', () => {
  it('round-trips SyncInfo', () => {
    const info = {
      tipHeight: 42,
      tipBlockId: 'abc123',
      tipCumulativeWork: '1000000',
      anchors: [{ height: 42, blockId: 'abc123' }],
    };
    const frame = encodeSyncInfo(MAGIC_TESTNET, info);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_SYNC_INFO);
    expect(decodeSyncInfo(body)).toEqual(info);
  });

  it('round-trips Inv', () => {
    const inv = { typeId: 101, ids: ['a', 'b', 'c'] };
    const frame = encodeInv(MAGIC_TESTNET, inv);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_INV);
    expect(decodeInv(body)).toEqual(inv);
  });

  it('round-trips ModifierRequest', () => {
    const req = { typeId: 101, ids: Array.from({length: 400}, (_, i) => `id${i}`) };
    const frame = encodeModifierRequest(MAGIC_TESTNET, req);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_REQUEST);
    expect(decodeModifierRequest(body)).toEqual(req);
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
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_RESPONSE);
    const decoded = decodeModifierResponse(body);
    expect(decoded.typeId).toBe(101);
    expect(decoded.modifiers).toHaveLength(2);
    expect(decoded.modifiers[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });
});
