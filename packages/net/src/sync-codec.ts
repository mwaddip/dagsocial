import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from './sync-types.js';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE, MSG_GET_POSTS, MSG_POSTS, MSG_GET_STUMPS, MSG_STUMPS } from './types.js';
import type { GetPostsMsg, PostsMsg, GetStumpsMsg, StumpsMsg } from './types.js';

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

export function encodeGetPosts(magic: number, msg: GetPostsMsg): Uint8Array {
  // GetPostsMsg is a simple object — CBOR handles it natively
  return frameMessage(magic, MSG_GET_POSTS, msg);
}

export function decodeGetPosts(body: Uint8Array): GetPostsMsg {
  return decode(body) as GetPostsMsg;
}

export function encodePosts(magic: number, msg: PostsMsg): Uint8Array {
  return frameMessage(magic, MSG_POSTS, msg);
}

export function decodePosts(body: Uint8Array): PostsMsg {
  return decode(body) as PostsMsg;
}

export function encodeGetStumps(magic: number, msg: GetStumpsMsg): Uint8Array {
  return frameMessage(magic, MSG_GET_STUMPS, msg);
}

export function decodeGetStumps(body: Uint8Array): GetStumpsMsg {
  return decode(body) as GetStumpsMsg;
}

export function encodeStumps(magic: number, msg: StumpsMsg): Uint8Array {
  return frameMessage(magic, MSG_STUMPS, msg);
}

export function decodeStumps(body: Uint8Array): StumpsMsg {
  return decode(body) as StumpsMsg;
}
