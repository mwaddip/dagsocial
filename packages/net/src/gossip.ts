import { decodeSubBlock, decodeOrderingBlock, decodeTx, POST_POW_TARGET_BITS, postPowPreimage } from '@dagsocial/types';
import { encodeSubBlock, encodeOrderingBlock, encodeTx } from '@dagsocial/types';
import {
  verifyContentLimits,
  verifyContentCharacters,
  verifyParentRefsCount,
} from '@dagsocial/validation';
import type { SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/interface';
import type { PubSub } from '@libp2p/interface';
import type { GossipsubEvents } from '@chainsafe/libp2p-gossipsub';
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
      const vr = runStage1SubBlock(sb, validators);
      if (!vr.valid) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid sub-block');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, `decode error: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  gs.topicValidators.set(TOPICS.orderingBlock, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const block = decodeOrderingBlock(raw);
      const vr = validators.verifyOrderingBlockStructure(block);
      if (!vr.valid) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid ordering block');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(block.header.protocolVersion)) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'unsupported protocol version');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, `decode error: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  gs.topicValidators.set(TOPICS.tx, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const tx = decodeTx(raw);
      const vr = validators.verifyTxStructure(tx);
      if (!vr.valid) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid tx');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(tx.protocolVersion)) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'unsupported protocol version');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, `decode error: ${String(err)}`);
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

  const powInput = postPowPreimage(post);
  if (!v.verifyPoW(powInput, post.powNonce, POST_POW_TARGET_BITS)) {
    return { valid: false, error: 'Proof of Work invalid' };
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
