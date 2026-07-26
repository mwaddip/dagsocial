import type { SubBlock, OrderingBlock, UtxoTransaction, Post } from '@dagsocial/types';

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
  peerEvictionIntervalMs: number;
  syncRequestTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// NetValidators — passed at construction, provided by @dagsocial/validation
// ---------------------------------------------------------------------------

export interface NetValidators {
  verifyPoW: (input: Uint8Array, nonce: number, targetBits: number) => boolean;
  verifyPostSignature: (post: Post, publicKey: Uint8Array) => boolean;
  verifyProtocolVersion: (version: number) => boolean;
  verifyContentLimits: (content: string) => { valid: boolean; error?: string };
  verifyParentRefsCount: (refs: string[]) => { valid: boolean; error?: string };
  verifySubBlockStructure: (sb: SubBlock) => { valid: boolean; error?: string };
  verifyTxStructure: (tx: UtxoTransaction) => { valid: boolean; error?: string };
  verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
}
