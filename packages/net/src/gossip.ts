import { decodeSubBlock, decodeOrderingBlock, decodeTx } from '@dagsocial/types';
import { encodeSubBlock, encodeOrderingBlock, encodeTx } from '@dagsocial/types';
import {
  verifyContentLimits,
  verifyParentRefsCount,
} from '@dagsocial/validation';
import type { SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
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

  gs.addEventListener('gossipsub:message', (evt) => {
    const { detail } = evt;
    if (!detail?.msg) return;

    const { topic, data } = detail.msg;
    const peerId = 'from' in detail.msg ? detail.msg.from.toString() : 'unknown';
    const raw = new Uint8Array(data);

    try {
      if (topic === TOPICS.subblock) {
        const sb = decodeSubBlock(raw);
        const vr = runStage1SubBlock(sb, validators);
        if (!vr.valid) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid sub-block');
          return;
        }
        // Forward to mesh (gossipsub handles this automatically via mesh)
        handlers.onSubBlock(sb);
      } else if (topic === TOPICS.orderingBlock) {
        const block = decodeOrderingBlock(raw);
        const vr = validators.verifyOrderingBlockStructure(block);
        if (!vr.valid) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid ordering block');
          return;
        }
        if (!validators.verifyProtocolVersion(block.protocolVersion)) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, 'unsupported protocol version');
          return;
        }
        handlers.onOrderingBlock(block);
      } else if (topic === TOPICS.tx) {
        const tx = decodeTx(raw);
        const vr = validators.verifyTxStructure(tx);
        if (!vr.valid) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid tx');
          return;
        }
        if (!validators.verifyProtocolVersion(tx.protocolVersion)) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, 'unsupported protocol version');
          return;
        }
        handlers.onTx(tx);
      }
    } catch (err) {
      // CBOR decode failure — structural invalidity
      peerMgr.recordPenalty('misbehavior', peerId, 100, `decode error: ${String(err)}`);
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

  const refs = verifyParentRefsCount(post.parentRefs);
  if (!refs.valid) return refs;

  if (!v.verifyProtocolVersion(post.protocolVersion)) {
    return { valid: false, error: 'Unsupported protocol version' };
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
