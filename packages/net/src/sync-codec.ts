import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from './sync-types.js';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE, MSG_GET_PEERS, MSG_PEERS, MSG_GET_POSTS, MSG_POSTS } from './types.js';
import type { GetPeersMsg, PeersMsg, PeerEntryMsg, GetPostsMsg, PostsMsg, PostsEntry } from './types.js';
import type { Post, LikeBox } from '@dagsocial/types';
import {
  isRecord,
  isBoundedInt,
  isBoundedIntArray,
  isHeight,
  isStringArray,
  isBytes,
  isWorkString,
  MAX_TYPE_ID,
  MAX_CAPABILITY_CODE,
  MAX_PEERS_ENTRIES,
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

export function encodeGetPeers(magic: number): Uint8Array {
  // Empty CBOR map rather than zero bytes, so a future version can add fields
  // without a framing change.
  return frameMessage(magic, MSG_GET_PEERS, {});
}

/**
 * A GetPeers body carries no information, so nothing about its content can be
 * wrong: an empty body and a body with fields we do not know are both accepted
 * (forward compat — a future version may add fields). The only rejection is
 * bytes that are not well-formed CBOR at all, which violates the framing
 * convention shared by every stream message.
 */
export function decodeGetPeers(body: Uint8Array): GetPeersMsg | null {
  if (body.length === 0) return {};
  if (tryDecode(body) === null) return null;
  return {};
}

export function encodePeers(magic: number, msg: PeersMsg): Uint8Array {
  return frameMessage(magic, MSG_PEERS, msg);
}

/**
 * Every field of every entry is checked before use: `address` reaches dial
 * paths, the rest reach PeerDb and are re-served to other peers, so nothing
 * may pass through unvalidated. `protocolVersion` and `capabilities` get the
 * same treatment the handshake gives the same fields (`validateHandshake`).
 *
 * A body declaring more than MAX_PEERS_ENTRIES collapses to `null` like every
 * other malformed body — the contract makes both a permanent ban, so the
 * caller has no need to tell them apart.
 */
export function decodePeers(body: Uint8Array): PeersMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.peers)) return null;
  if (v.peers.length > MAX_PEERS_ENTRIES) return null;

  const peers: PeerEntryMsg[] = [];
  for (const e of v.peers) {
    if (!isRecord(e)) return null;
    if (typeof e.address !== 'string') return null;
    if (typeof e.agentName !== 'string') return null;
    if (typeof e.nodeName !== 'string') return null;
    if (!isBoundedInt(e.protocolVersion, MAX_CAPABILITY_CODE)) return null;
    if (!isBoundedIntArray(e.capabilities, MAX_CAPABILITY_CODE)) return null;
    peers.push({
      address: e.address,
      agentName: e.agentName,
      nodeName: e.nodeName,
      protocolVersion: e.protocolVersion,
      capabilities: [...e.capabilities],
    });
  }

  return { peers };
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
