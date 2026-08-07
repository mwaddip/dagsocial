import {
  decodeSubBlock,
  decodeOrderingBlock,
  decodeTx,
  encodeSubBlock,
  encodeOrderingBlock,
  encodeTx,
  postPowPreimage,
} from '@dagsocial/types';
import {
  verifyContentLimits,
  verifyContentCharacters,
  verifyParentRefsCount,
} from '@dagsocial/validation';
import type { SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/interface';
import type { PubSub } from '@libp2p/interface';
import type { GossipsubEvents } from '@chainsafe/libp2p-gossipsub';
import { PenaltyKind } from './types.js';
import type { NetValidators } from './types.js';
import type { PeerManager } from './peer-mgr.js';

// ---------------------------------------------------------------------------
// Minimal interface capturing what gossip.ts needs from a libp2p node.
// The full Libp2p<T> type has `services: T` defaulting to `Record<string,
// unknown>`, so we cannot access `.pubsub` without a type parameter or cast.
// This interface documents the contract: the caller must pass a libp2p node
// whose `services.pubsub` has been configured with gossipsub.
// ---------------------------------------------------------------------------

export interface Libp2pGossip {
  services: {
    pubsub: PubSub<GossipsubEvents>;
  };
}

// ---------------------------------------------------------------------------
// Topic constants
// ---------------------------------------------------------------------------

export const TOPICS = {
  subblock: '/dagsocial/subblock/1',
  orderingBlock: '/dagsocial/ordering-block/1',
  tx: '/dagsocial/tx/1',
} as const;

// ---------------------------------------------------------------------------
// Handlers registered by node
// ---------------------------------------------------------------------------

export interface GossipHandlers {
  onSubBlock: (sb: SubBlock) => void;
  onOrderingBlock: (block: OrderingBlock) => void;
  onTx: (tx: UtxoTransaction) => void;
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

export function subscribeTopics(
  libp2p: Libp2pGossip,
  validators: NetValidators,
  peerMgr: PeerManager,
  handlers: GossipHandlers,
  postPowTargetBits: number,
): void {
  const gs = libp2p.services.pubsub;

  // -------------------------------------------------------------------------
  // Topic validators — run BEFORE forwarding to mesh peers.  Invalid
  // messages are rejected at this layer and never propagated further.
  // -------------------------------------------------------------------------

  gs.topicValidators.set(TOPICS.subblock, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const sb = decodeSubBlock(raw);
      const vr = runStage1SubBlock(sb, validators, postPowTargetBits);
      if (!vr.valid) {
        // Bogus — well-formed message with invalid content.
        // Score accumulates toward temporal ban but is NOT an instant permanent ban.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid sub-block');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed sub-block: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  gs.topicValidators.set(TOPICS.orderingBlock, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const block = decodeOrderingBlock(raw);
      const vr = validators.verifyOrderingBlockStructure(block);
      if (!vr.valid) {
        // Bogus — well-formed message with invalid content.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid ordering block');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(block.header.protocolVersion)) {
        // Bogus — well-formed message with unsupported version.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'unsupported protocol version');
        return TopicValidatorResult.Reject;
      }
      if (!Number.isSafeInteger(block.header.height)) {
        // Bogus — structure's `>= 1` bound admits NaN and floats (audit M-6).
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'ordering block height is not a safe integer');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyOrderingBlockPoW(block.header)) {
        // Bogus — a zero-work block must die at the first hop, not be
        // re-gossiped mesh-wide (audit M-9). Stage 1 checks the header's own
        // floor-bounded target only; the difficulty schedule is apply-time
        // node policy.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'ordering block PoW invalid');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed ordering block: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  gs.topicValidators.set(TOPICS.tx, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const tx = decodeTx(raw);
      const vr = validators.verifyTxStructure(tx);
      if (!vr.valid) {
        // Bogus — well-formed message with invalid content.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid tx');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(tx.protocolVersion)) {
        // Bogus — well-formed message with unsupported version.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'unsupported protocol version');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed tx: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  // -------------------------------------------------------------------------
  // Event listener — dispatches accepted messages to app-layer handlers.
  // Topic validators (above) guarantee only structurally-valid, PoW-verified
  // messages reach this point.
  // -------------------------------------------------------------------------

  gs.addEventListener('gossipsub:message', (evt) => {
    const { detail } = evt;
    if (!detail?.msg) return;

    // Drop messages from peers that are not in Active state
    const sourcePeerId = (detail.msg as { from?: { toString(): string } }).from?.toString();
    if (sourcePeerId && !peerMgr.isPeerActive(sourcePeerId)) {
      return;
    }

    const { topic } = detail.msg;
    const raw = new Uint8Array(detail.msg.data);

    try {
      if (topic === TOPICS.subblock) {
        handlers.onSubBlock(decodeSubBlock(raw));
      } else if (topic === TOPICS.orderingBlock) {
        handlers.onOrderingBlock(decodeOrderingBlock(raw));
      } else if (topic === TOPICS.tx) {
        handlers.onTx(decodeTx(raw));
      }
    } catch {
      // Decode failure here would indicate a validator bug — the message
      // already passed the topic validator.  Log and move on.
    }
  });

  // Subscribe to all three topics
  gs.subscribe(TOPICS.subblock);
  gs.subscribe(TOPICS.orderingBlock);
  gs.subscribe(TOPICS.tx);
}

// ---------------------------------------------------------------------------
// Stage 1 validation for sub-blocks
// ---------------------------------------------------------------------------

function runStage1SubBlock(
  sb: SubBlock,
  v: NetValidators,
  postPowTargetBits: number,
): { valid: boolean; error?: string } {
  const struct = v.verifySubBlockStructure(sb);
  if (!struct.valid) return struct;

  const post = sb.post;

  const content = verifyContentLimits(post.content);
  if (!content.valid) return content;

  const chars = verifyContentCharacters(post.content);
  if (!chars.valid) return chars;

  const refs = verifyParentRefsCount(post.parentRefs);
  if (!refs.valid) return refs;

  if (!v.verifyProtocolVersion(post.protocolVersion)) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // Target from config, never the compile-time constant — post difficulty is
  // per-network (NET_INTERFACE §Consensus parameters net enforces); the
  // constant would make a devnet relay reject its own network's posts.
  const powInput = postPowPreimage(post);
  if (!v.verifyPoW(powInput, post.powNonce, postPowTargetBits)) {
    return { valid: false, error: 'Proof of Work invalid' };
  }

  // PoW first (anti-spam gate), then the ~50µs signature check.
  // `post.author` IS the 32-byte Ed25519 key — the same derivation Stage 2
  // uses in the node's verifyPostForRelay; any drift here splits the relay.
  if (!v.verifyPostSignature(post, post.author)) {
    return { valid: false, error: 'Signature invalid' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export async function broadcastSubBlock(libp2p: Libp2pGossip, sb: SubBlock): Promise<void> {
  const data = encodeSubBlock(sb);
  await libp2p.services.pubsub.publish(TOPICS.subblock, data);
}

export async function broadcastOrderingBlock(libp2p: Libp2pGossip, block: OrderingBlock): Promise<void> {
  const data = encodeOrderingBlock(block);
  await libp2p.services.pubsub.publish(TOPICS.orderingBlock, data);
}

export async function broadcastTx(libp2p: Libp2pGossip, tx: UtxoTransaction): Promise<void> {
  const data = encodeTx(tx);
  await libp2p.services.pubsub.publish(TOPICS.tx, data);
}

// ---------------------------------------------------------------------------
// Serve-before-relay — incoming content request handler
// ---------------------------------------------------------------------------

/**
 * Dependencies for the serve-before-relay handler.
 *
 * The caller (node layer) provides concrete implementations of each callback
 * so gossip.ts stays decoupled from storage and peer management.
 */
export interface GossipDeps {
  /** Check if a modifier is available locally. Returns the serialized data
   *  if found, or null if not present. Called before relaying. */
  localServe: (typeId: number, id: Uint8Array) => Uint8Array | null;
  /** Relay a modifier request to connected peers (excluding the requester). */
  relay: (typeId: number, id: Uint8Array, excludePeer: string) => void;
  /** Send a response directly to a peer. */
  sendTo: (peerId: string, message: Uint8Array) => void;
}

/**
 * Handle an incoming modifier request from a peer.
 *
 * **Invariant:** local store is checked BEFORE relaying. Serve and relay are
 * mutually exclusive per request ID — a request is either served locally
 * OR relayed, never both.
 *
 * @param deps - Callbacks for local lookup, relaying, and direct sending.
 * @param requesterId - The peer that sent the modifier request.
 * @param typeId - Modifier type ID (e.g. MODIFIER_ORDERING_BLOCK).
 * @param id - The modifier identifier to look up.
 */
export function handleModifierRequest(
  deps: GossipDeps,
  requesterId: string,
  typeId: number,
  id: Uint8Array,
): void {
  // Check local store FIRST
  const localData = deps.localServe(typeId, id);
  if (localData) {
    // Serve from local store — do NOT relay
    deps.sendTo(requesterId, localData);
    return;
  }

  // Only relay if not available locally
  deps.relay(typeId, id, requesterId);
}
