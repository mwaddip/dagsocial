import type { SubBlock, OrderingBlock, UtxoTransaction, Post, LikeBox, BlockHeader } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Message codes
// ---------------------------------------------------------------------------

export const MSG_HANDSHAKE = 1;
export const MSG_SYNC_INFO = 2;
export const MSG_INV = 3;
export const MSG_MODIFIER_REQUEST = 4;
export const MSG_MODIFIER_RESPONSE = 5;
export const MSG_GET_SUB_BLOCK = 6;
export const MSG_SUB_BLOCK_RESPONSE = 7;
export const MSG_GET_PEERS = 8;
export const MSG_PEERS = 9;
export const MSG_GET_POSTS = 10;
export const MSG_POSTS = 11;
export const MSG_GET_STUMPS = 12;
export const MSG_STUMPS = 13;

// ---------------------------------------------------------------------------
// Modifier type IDs
// ---------------------------------------------------------------------------

export const MODIFIER_ORDERING_BLOCK = 101;

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

export interface Peer {
  id: string;
  multiaddrs: string[];
  protocols: string[];
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// Penalty
// ---------------------------------------------------------------------------

export type PenaltyType = 'misbehavior' | 'spam' | 'non-delivery' | 'permanent';

export interface PenaltyRecord {
  type: PenaltyType;
  score: number;
  timestamp: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Peer state machine
// ---------------------------------------------------------------------------

export enum PeerState {
  Connecting = 'connecting',
  Handshaking = 'handshaking',
  Active = 'active',
  Disconnected = 'disconnected',
  Failed = 'failed',
  Banned = 'banned',
}

// ---------------------------------------------------------------------------
// Penalty attribution tiers (additive to existing PenaltyType)
// ---------------------------------------------------------------------------

export enum PenaltyKind {
  /** Transient failure — cooldown, not a ban. */
  Transient = 'transient',
  /** Protocol violation — permanent ban. */
  ProtocolViolation = 'protocol_violation',
  /** Rate limit exceeded. */
  RateLimit = 'rate_limit',
}

// ---------------------------------------------------------------------------
// PeerMetadata — runtime peer state tracked by PeerManager
// ---------------------------------------------------------------------------

export interface PeerMetadata {
  peerId: string;
  state: PeerState;
  penaltyCount: number;
  bannedUntil: number | null; // null = not banned, timestamp = ban expiration
  stalled: boolean;
  lastSeenMs: number;
  /**
   * The peer's declared multiaddr, or null until the handshake reveals it.
   * This is the join key between the two ban surfaces: PeerManager bans by
   * peerId, PeerDb bans by address, and every PeerManager ban propagates to
   * PeerDb through this field (contract: "Ban surfaces are unified").
   */
  address: string | null;
}

// ---------------------------------------------------------------------------
// Event types for the biased event loop
// ---------------------------------------------------------------------------

export interface ControlEvent {
  kind: 'reorg' | 'peer_disconnect' | 'new_peer' | 'shutdown';
  peerId?: string;
  data?: unknown;
}

export interface DataEvent {
  kind: 'post_received' | 'post_acknowledged' | 'message';
  peerId: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// PeerRecord — persisted peer metadata
// ---------------------------------------------------------------------------

export interface PeerRecord {
  address: string;
  lastSeenMs: number;
  agentName: string;
  nodeName: string;
  protocolVersion: number;
  capabilities: number[];
}

// ---------------------------------------------------------------------------
// NetConfig
// ---------------------------------------------------------------------------

export interface NetConfig {
  magic?: number;
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
  minPeers?: number;
  peerDbCap?: number;
  outboundFillIntervalMs?: number;
  outboundRedialCooldownMs?: number;
  penaltyScoreThreshold: number;
  temporalBanDurationMs: number;
  penaltySafeIntervalMs: number;
  syncRequestTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// NetValidators — passed at construction, provided by @dagsocial/validation
// ---------------------------------------------------------------------------

export interface NetValidators {
  verifyPoW: (input: Uint8Array, nonce: number, targetBits: number) => boolean;
  verifyOrderingBlockPoW: (header: BlockHeader) => boolean;
  verifyPostSignature: (post: Post, publicKey: Uint8Array) => boolean;
  verifyProtocolVersion: (version: number) => boolean;
  verifyContentLimits: (content: string) => { valid: boolean; error?: string };
  verifyParentRefsCount: (refs: string[]) => { valid: boolean; error?: string };
  verifySubBlockStructure: (sb: SubBlock) => { valid: boolean; error?: string };
  verifyTxStructure: (tx: UtxoTransaction) => { valid: boolean; error?: string };
  verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
}

// ---------------------------------------------------------------------------
// GetPeers / Peers message types
// ---------------------------------------------------------------------------

/**
 * Body of a GetPeers request (code 8). Empty by design — the request carries no
 * parameters. Encoded as an empty CBOR map so a future version can add fields
 * without changing the framing.
 */
export interface GetPeersMsg {}

/**
 * One advertised peer inside a Peers response. This is the wire shape: unlike
 * `PeerRecord` it carries no `lastSeenMs` — a peer's claim about when it last
 * saw someone is worthless hearsay, so the receiver stamps its own clock at
 * intake time.
 */
export interface PeerEntryMsg {
  address: string;
  agentName: string;
  nodeName: string;
  protocolVersion: number;
  capabilities: number[];
}

export interface PeersMsg {
  peers: PeerEntryMsg[];
}

// ---------------------------------------------------------------------------
// GetPosts / Posts message types
// ---------------------------------------------------------------------------

export interface GetPostsMsg {
  postIds: string[];
}

export interface PostsEntry {
  postId: string;
  post: Post;
  likeBoxes: LikeBox[];
}

export interface PostsMsg {
  entries: PostsEntry[];
}

// ---------------------------------------------------------------------------
// GetStumps / Stumps message types
// ---------------------------------------------------------------------------

export interface GetStumpsMsg {
  stumpIds: string[];
}

export interface StumpsEntry {
  stumpId: string;
  stump: import('@dagsocial/types').Stump;
}

export interface StumpsMsg {
  entries: StumpsEntry[];
}
