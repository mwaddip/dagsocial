import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from './sync-types.js';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE } from './types.js';

function frameMessage(magic: number, code: number, body: unknown): Uint8Array {
  return encodeFrame(magic, code, new Uint8Array(encode(body)));
}

export function encodeSyncInfo(magic: number, info: SyncInfo): Uint8Array {
  return frameMessage(magic, MSG_SYNC_INFO, info);
}

export function encodeInv(magic: number, inv: Inv): Uint8Array {
  return frameMessage(magic, MSG_INV, inv);
}

export function encodeModifierRequest(magic: number, req: ModifierRequest): Uint8Array {
  return frameMessage(magic, MSG_MODIFIER_REQUEST, req);
}

export function encodeModifierResponse(magic: number, resp: ModifierResponse): Uint8Array {
  // CBOR encodes Uint8Array as binary
  return frameMessage(magic, MSG_MODIFIER_RESPONSE, resp);
}

export function decodeSyncInfo(body: Uint8Array): SyncInfo {
  return decode(body) as SyncInfo;
}

export function decodeInv(body: Uint8Array): Inv {
  return decode(body) as Inv;
}

export function decodeModifierRequest(body: Uint8Array): ModifierRequest {
  return decode(body) as ModifierRequest;
}

export function decodeModifierResponse(body: Uint8Array): ModifierResponse {
  return decode(body) as ModifierResponse;
}
