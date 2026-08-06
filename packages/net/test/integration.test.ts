import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair, computePostId, postPowPreimage, signingHash } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, BlockHeader } from '@dagsocial/types';
import {
  verifyPoW,
  verifyOrderingBlockPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import { createHash, createPrivateKey, sign } from 'crypto';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';

function makeConfig(bootstrapPeers: string[] = []): NetConfig {
  return {
    // Testnet magic — both nodes must agree; also proves the wire path does
    // not silently frame as mainnet (P2-A phase 3b).
    magic: 0x54444147,
    // Matches the 20-bit target the fixtures below are mined at.
    postPowTargetBits: 20,
    bootstrapPeers,
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3600000,
    penaltySafeIntervalMs: 120000,
    syncRequestTimeoutMs: 10000,
  };
}

const validators: NetValidators = {
  verifyPoW,
  verifyOrderingBlockPoW,
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

/**
 * Brute-force a PoW nonce. 20 bits target (~1M iterations worst case,
 * typically a few hundred ms in Node.js).
 */
function solvePoW(input: Uint8Array, targetBits: number): number {
  for (let nonce = 0; nonce < 100_000_000; nonce++) {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    const hash = createHash('blake2b512')
      .update(Buffer.concat([Buffer.from(input), nonceBuf]))
      .digest()
      .subarray(0, 32);

    let valid = true;
    for (let i = 0; i < targetBits; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      if ((hash[byteIdx]! & (1 << bitIdx)) !== 0) {
        valid = false;
        break;
      }
    }
    if (valid) return nonce;
  }
  throw new Error('PoW solution not found within nonce limit');
}

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
    const postBase: Omit<Post, 'powNonce'> = {
      content: 'hello from integration test',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    // Compute valid PoW nonce (20-bit target, Stage 1 validates it).
    // The preimage comes from @dagsocial/types — gossip's Stage-1 check calls
    // postPowPreimage(post), so mining against a local copy of the encoding
    // (as this test used to) silently stops matching (audit M-1).
    // powNonce is excluded from the preimage, so the placeholder is irrelevant.
    const powInput = postPowPreimage({ ...postBase, powNonce: 0 });
    const nonce = solvePoW(powInput, 20);
    const post: Post = { ...postBase, powNonce: nonce };
    // Stage 1 now verifies the post signature before relay (NET_INTERFACE
    // Stage-1 de-drift) — an unsigned fixture dies at B's topic validator.
    // signingHash excludes powNonce and signature, so signing after mining
    // is sound.
    post.signature = new Uint8Array(
      sign(null, signingHash(post), createPrivateKey({
        key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8',
      })),
    );
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

    const validatorId = new Uint8Array(32);
    // Stage 1 now PoW-gates ordering-block relay (audit M-9) — an unmined
    // header dies at B's topic validator, so mine the real 12-bit nonce
    // (~4K tries) with the same function the relay gate calls.
    const headerBase: BlockHeader = {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId,
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    };
    let blockNonce = -1;
    for (let n = 0; n < 10_000_000; n++) {
      if (verifyOrderingBlockPoW({ ...headerBase, powNonce: n })) { blockNonce = n; break; }
    }
    expect(blockNonce).toBeGreaterThanOrEqual(0);
    const block: OrderingBlock = {
      header: { ...headerBase, powNonce: blockNonce },
      subBlockTree: {
        subBlockRefs: [],
        subBlockEntries: [],
        pruneEntries: [],
      },
      utxoTxTree: {
        utxoTxIds: [],
        utxoTxs: [],
        likeBoxIds: [],
        coinbaseOutputs: [],
      },
      validatorSignature: new Uint8Array(64),
    };

    await nodeA.broadcastOrderingBlock(block);
    await new Promise((r) => setTimeout(r, 4000));

    expect(receivedBlock).not.toBeNull();
    expect(receivedBlock!.header.height).toBe(1);
    expect(receivedBlock!.header.protocolVersion).toBe(1);
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
