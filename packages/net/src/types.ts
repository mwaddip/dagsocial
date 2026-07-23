import type { SubBlock, OrderingBlock, UtxoTransaction, Post } from '@dagsocial/types';

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
// NetConfig
// ---------------------------------------------------------------------------

export interface NetConfig {
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
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
