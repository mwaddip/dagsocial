import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair, getUserId, computePostId } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock } from '@dagsocial/types';
import {
  verifyPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';

function makeConfig(bootstrapPeers: string[] = []): NetConfig {
  return {
    bootstrapPeers,
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3600000,
    penaltySafeIntervalMs: 120000,
    peerEvictionIntervalMs: 3600000,
    syncRequestTimeoutMs: 10000,
  };
}

const validators: NetValidators = {
  verifyPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
};

// Generous timeout — libp2p needs time for peer discovery and connection negotiation
const TIMEOUT = 25000;

describe('Two-node integration', () => {
  let nodeA: NetNode;
  let nodeB: NetNode;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('node A starts and gets a peer ID', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const id = nodeA.peerId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  }, TIMEOUT);

  it('two nodes connect to each other', async () => {
    // Start node A first
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();

    // Get node A's listen addresses for bootstrapping
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    expect(multiaddrs.length).toBeGreaterThan(0);

    // Start node B with A as bootstrap
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();

    // Give them a moment to establish the connection
    await new Promise((r) => setTimeout(r, 3000));

    // Both should see at least 1 peer (each other)
    expect(nodeA.peers().length).toBeGreaterThanOrEqual(1);
    expect(nodeB.peers().length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  it('sub-block propagates from A to B via gossip', async () => {
    // Start node A
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];

    // Start node B with A as bootstrap
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();

    // Wait for connection
    await new Promise((r) => setTimeout(r, 3000));

    // Register handler on B
    let receivedSubBlock: SubBlock | null = null;
    nodeB.onSubBlock((sb) => {
      receivedSubBlock = sb;
    });

    // Create a valid sub-block and broadcast from A
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello from integration test',
      author: getUserId(kp.publicKey),
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const sb: SubBlock = {
      subBlockId: computePostId(post),
      post,
      likeBoxes: [],
      producerId: post.author,
      protocolVersion: 1,
    };

    await nodeA.broadcastSubBlock(sb);

    // Wait for gossip propagation
    await new Promise((r) => setTimeout(r, 4000));

    expect(receivedSubBlock).not.toBeNull();
    expect(receivedSubBlock!.subBlockId).toBe(sb.subBlockId);
    expect(receivedSubBlock!.post.content).toBe('hello from integration test');
  }, TIMEOUT);

  it('ordering block propagates from A to B', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();
    await new Promise((r) => setTimeout(r, 3000));

    let receivedBlock: OrderingBlock | null = null;
    nodeB.onOrderingBlock((block) => {
      receivedBlock = block;
    });

    const block: OrderingBlock = {
      height: 1,
      hash: 'test-hash-123',
      prevBlockHash: '00000000000000000000000000000000',
      subBlockRefs: [],
      likeBoxIds: [],
      utxoTxIds: [],
      stumpIds: [],
      validatorId: 'validator-1',
      validatorSignature: new Uint8Array(64),
      protocolVersion: 1,
      createdAt: Date.now(),
    };

    await nodeA.broadcastOrderingBlock(block);
    await new Promise((r) => setTimeout(r, 4000));

    expect(receivedBlock).not.toBeNull();
    expect(receivedBlock!.height).toBe(1);
    expect(receivedBlock!.hash).toBe('test-hash-123');
  }, TIMEOUT);

  it('invalid sub-block does NOT trigger handler on B', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();
    await new Promise((r) => setTimeout(r, 3000));

    let received = false;
    nodeB.onSubBlock(() => {
      received = true;
    });

    // Broadcast an invalid sub-block (empty content — fails ContentLimits)
    const invalidSb = {
      subBlockId: 'bad',
      post: { content: '', author: 'user1', parentRefs: [], protocolVersion: 1 },
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    } as unknown as SubBlock;

    await nodeA.broadcastSubBlock(invalidSb);
    await new Promise((r) => setTimeout(r, 4000));

    expect(received).toBe(false);
  }, TIMEOUT);
});
