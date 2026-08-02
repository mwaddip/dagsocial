import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from './sync-types.js';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE, MSG_GET_POSTS, MSG_POSTS, MSG_GET_STUMPS, MSG_STUMPS } from './types.js';
import type { GetPostsMsg, PostsMsg, PostsEntry, GetStumpsMsg, StumpsMsg, StumpsEntry } from './types.js';
import type { Post, LikeBox, Stump } from '@dagsocial/types';
import {
  isRecord,
  isBoundedInt,
  isHeight,
  isStringArray,
  isBytes,
  isWorkString,
  MAX_TYPE_ID,
} from './msg-guards.js';

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

// ---------------------------------------------------------------------------
// Decode boundary
//
// Every decoder below takes raw bytes from an unauthenticated peer and returns
// either a fully shape-checked message or `null`. They never throw: malformed
// CBOR, a wrong-typed field, a missing field, or an out-of-range height all
// collapse to `null`, and the caller drops the message and penalizes the peer.
//
// The returned object is rebuilt from the checked fields, so unknown extras in
// the body are ignored (forward compat) and nothing unvalidated leaks inward.
// ---------------------------------------------------------------------------

/** CBOR-decode a body. Returns null when the bytes are not well-formed CBOR. */
function tryDecode(body: Uint8Array): unknown {
  try {
    return decode(body);
  } catch {
    return null;
  }
}

export function decodeSyncInfo(body: Uint8Array): SyncInfo | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isHeight(v.tipHeight)) return null;
  if (typeof v.tipBlockId !== 'string') return null;
  if (!isWorkString(v.tipCumulativeWork)) return null;
  if (!Array.isArray(v.anchors)) return null;

  const anchors: { height: number; blockId: string }[] = [];
  for (const a of v.anchors) {
    if (!isRecord(a) || !isHeight(a.height) || typeof a.blockId !== 'string') return null;
    anchors.push({ height: a.height, blockId: a.blockId });
  }

  return {
    tipHeight: v.tipHeight,
    tipBlockId: v.tipBlockId,
    tipCumulativeWork: v.tipCumulativeWork,
    anchors,
  };
}

/** Inv and ModifierRequest share the `{ typeId, ids }` shape. */
function decodeIdList(body: Uint8Array): { typeId: number; ids: string[] } | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isBoundedInt(v.typeId, MAX_TYPE_ID)) return null;
  if (!isStringArray(v.ids)) return null;
  return { typeId: v.typeId, ids: [...v.ids] };
}

export function decodeInv(body: Uint8Array): Inv | null {
  return decodeIdList(body);
}

export function decodeModifierRequest(body: Uint8Array): ModifierRequest | null {
  return decodeIdList(body);
}

export function decodeModifierResponse(body: Uint8Array): ModifierResponse | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isBoundedInt(v.typeId, MAX_TYPE_ID)) return null;
  if (!Array.isArray(v.modifiers)) return null;

  const modifiers: { id: string; data: Uint8Array }[] = [];
  for (const m of v.modifiers) {
    if (!isRecord(m) || typeof m.id !== 'string' || !isBytes(m.data)) return null;
    modifiers.push({ id: m.id, data: m.data });
  }

  return { typeId: v.typeId, modifiers };
}

export function encodeGetPosts(magic: number, msg: GetPostsMsg): Uint8Array {
  // GetPostsMsg is a simple object — CBOR handles it natively
  return frameMessage(magic, MSG_GET_POSTS, msg);
}

export function decodeGetPosts(body: Uint8Array): GetPostsMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isStringArray(v.postIds)) return null;
  return { postIds: [...v.postIds] };
}

export function encodePosts(magic: number, msg: PostsMsg): Uint8Array {
  return frameMessage(magic, MSG_POSTS, msg);
}

export function decodePosts(body: Uint8Array): PostsMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.entries)) return null;

  const entries: PostsEntry[] = [];
  for (const e of v.entries) {
    if (!isRecord(e) || typeof e.postId !== 'string') return null;
    if (!isRecord(e.post)) return null;
    if (!Array.isArray(e.likeBoxes) || !e.likeBoxes.every(isRecord)) return null;
    // The Post / LikeBox interiors are not inspected here — content validation
    // is Stage 1's job (`@dagsocial/validation`). This boundary only guarantees
    // the envelope can be walked without throwing.
    entries.push({
      postId: e.postId,
      post: e.post as unknown as Post,
      likeBoxes: e.likeBoxes as unknown as LikeBox[],
    });
  }

  return { entries };
}

export function encodeGetStumps(magic: number, msg: GetStumpsMsg): Uint8Array {
  return frameMessage(magic, MSG_GET_STUMPS, msg);
}

export function decodeGetStumps(body: Uint8Array): GetStumpsMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isStringArray(v.stumpIds)) return null;
  return { stumpIds: [...v.stumpIds] };
}

export function encodeStumps(magic: number, msg: StumpsMsg): Uint8Array {
  return frameMessage(magic, MSG_STUMPS, msg);
}

export function decodeStumps(body: Uint8Array): StumpsMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.entries)) return null;

  const entries: StumpsEntry[] = [];
  for (const e of v.entries) {
    if (!isRecord(e) || typeof e.stumpId !== 'string' || !isRecord(e.stump)) return null;
    // Stump interior is Stage 1's job, as with posts above.
    entries.push({ stumpId: e.stumpId, stump: e.stump as unknown as Stump });
  }

  return { entries };
}

// ---------------------------------------------------------------------------
// Legacy /dagsocial/headers/1 request
// ---------------------------------------------------------------------------

/**
 * Body of the legacy headers-protocol request. Raw CBOR, no frame — the
 * protocol predates framing and is kept only for backward compatibility.
 */
export interface LegacyHeadersRequest {
  startHeight: number;
  maxCount?: number;
  endHeight?: number;
  mode?: string;
}

/**
 * Decode and validate a legacy headers request.
 *
 * Both heights drive serve loops that read the store once per height, so both
 * are bounded here exactly like an advertised chain height.
 */
export function decodeLegacyHeadersRequest(body: Uint8Array): LegacyHeadersRequest | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isHeight(v.startHeight)) return null;
  if (v.maxCount !== undefined && !isHeight(v.maxCount)) return null;
  if (v.endHeight !== undefined && !isHeight(v.endHeight)) return null;
  if (v.mode !== undefined && typeof v.mode !== 'string') return null;

  const req: LegacyHeadersRequest = { startHeight: v.startHeight };
  if (v.maxCount !== undefined) req.maxCount = v.maxCount;
  if (v.endHeight !== undefined) req.endHeight = v.endHeight;
  if (v.mode !== undefined) req.mode = v.mode;
  return req;
}
