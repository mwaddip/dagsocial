import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createPrivateKey, sign } from 'crypto';
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
import {
  generateKeyPair,
  computePostId,
  postPowPreimage,
  signingHash,
  subBlockFromPost,
  encodeSubBlock,
  encodeOrderingBlock,
  decodeOrderingBlock,
  EMPTY_STATE_ROOT,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  POST_POW_TARGET_BITS,
} from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, BlockHeader } from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/interface';
import { subscribeTopics, TOPICS } from '../src/gossip.js';
import type { Libp2pGossip } from '../src/gossip.js';
import { PeerManager } from '../src/peer-mgr.js';
import type { NetConfig, NetValidators } from '../src/types.js';

// These tests drive the REAL topic validators registered by subscribeTopics —
// not an inline copy of their bodies. A copied harness would contain the fix
// under test and pass by construction; here every assertion runs the same
// closures production gossipsub invokes, over wire-encoded messages, against
// the real @dagsocial/validation functions and a real PeerManager.

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

function makeConfig(): NetConfig {
  return {
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 1000,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 0,
    syncRequestTimeoutMs: 10_000,
  };
}

type CapturedValidator = (
  peer: { toString(): string },
  msg: { data: Uint8Array },
) => TopicValidatorResult;

function makeHarness() {
  const topicValidators = new Map<string, CapturedValidator>();
  const stub = {
    services: {
      pubsub: {
        topicValidators,
        subscribe: () => {},
        addEventListener: () => {},
      },
    },
  } as unknown as Libp2pGossip;

  const peerMgr = new PeerManager(makeConfig());
  subscribeTopics(stub, validators, peerMgr, {
    onSubBlock: () => {},
    onOrderingBlock: () => {},
    onTx: () => {},
    onStump: () => {},
  });

  const penaltySpy = vi.spyOn(peerMgr, 'recordPenalty');
  return { topicValidators, peerMgr, penaltySpy };
}

let peerSeq = 0;
function newPeer(peerMgr: PeerManager): { id: string; toString(): string } {
  const id = `test-peer-${peerSeq++}`;
  peerMgr.addPeer({ id, multiaddrs: [], protocols: [], connectedAt: Date.now() });
  return { id, toString: () => id };
}

// ---------------------------------------------------------------------------
// Ordering-block topic validator — relay PoW gate (audit M-9, M-6)
// ---------------------------------------------------------------------------

describe('ordering-block topic validator (relay PoW gate)', () => {
  const baseHeader: BlockHeader = {
    protocolVersion: 1,
    height: 7,
    prevBlockHash: '11'.repeat(32),
    subBlockRoot: '22'.repeat(32),
    utxoTxRoot: '33'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(9),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR, // 4 — the structure floor
    createdAt: 1_722_470_400_000,
  };

  function makeBlock(header: BlockHeader): OrderingBlock {
    return {
      header,
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], likeBoxIds: [], coinbaseOutputs: [] },
      // 64-byte dummy — Stage 1 does not verify the validator signature.
      validatorSignature: new Uint8Array(64),
    };
  }

  let minedNonce = -1;
  let failingNonce = -1;

  beforeAll(() => {
    // Mine the real nonce (~16 tries at 4 bits) and record a genuinely
    // failing one, both via the same verifyOrderingBlockPoW that gates relay.
    for (let n = 0; minedNonce < 0 || failingNonce < 0; n++) {
      if (n > 1_000_000) throw new Error('ordering-block PoW search exhausted');
      const ok = verifyOrderingBlockPoW({ ...baseHeader, powNonce: n });
      if (ok && minedNonce < 0) minedNonce = n;
      if (!ok && failingNonce < 0) failingNonce = n;
    }
  });

  it('accepts a mined block with zero penalties (control anchor)', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: minedNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(0);
  });

  it('rejects the same block with a wrong nonce and records one misbehavior penalty', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    // Self-check: this nonce genuinely fails PoW (no 1-in-16 flake).
    expect(verifyOrderingBlockPoW({ ...baseHeader, powNonce: failingNonce })).toBe(false);

    const block = makeBlock({ ...baseHeader, powNonce: failingNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'ordering block PoW invalid',
    );
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(1);
  });

  it('rejects the same block with powNonce NaN (M-6 — pre-fix code Accepted this)', () => {
    // Vacuity evidence: against pre-fix gossip.ts this exact message was
    // ACCEPTED and forwarded mesh-wide. verifyOrderingBlockStructure guards
    // powNonce with `typeof !== 'number' || < 0`, and `typeof NaN ===
    // 'number'` while `NaN < 0` is false — so structure passed, the version
    // check passed, and nothing else ran before Accept. The single-field-delta
    // control that Accepts is the mined-nonce case above.
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: Number.NaN });
    const encoded = encodeOrderingBlock(block);

    // NaN survives the CBOR wire round-trip — this is a reachable network
    // input, not an in-process artifact.
    expect(Number.isNaN(decodeOrderingBlock(encoded).header.powNonce)).toBe(true);

    const result = validate(peer, { data: encoded });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'ordering block PoW invalid',
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['1.5', 1.5],
  ])('rejects height %s via the height guard, attributably', (_label, badHeight) => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    // Single-field delta from the accepted anchor: only height changes.
    // Pre-fix, height NaN/floats passed structure (`< 1` is false for NaN;
    // 1.5 >= 1) and were forwarded. The distinct reason string proves the
    // rejection comes from the height guard, not from PoW (which the height
    // change also breaks).
    const block = makeBlock({ ...baseHeader, powNonce: minedNonce, height: badHeight });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'ordering block height is not a safe integer',
    );
  });
});

// ---------------------------------------------------------------------------
// Sub-block topic validator — Stage 1 (structure, limits, PoW, signature)
// ---------------------------------------------------------------------------

describe('sub-block topic validator (Stage 1)', () => {
  let keyPair: ReturnType<typeof generateKeyPair>;
  let validPost: Post;
  let validSubBlock: SubBlock;
  let failingPostNonce = -1;

  beforeAll(() => {
    keyPair = generateKeyPair();
    const basePost: Post = {
      content: 'gossip stage-1 fixture',
      author: keyPair.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32).fill(7),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_722_470_400_000,
      signature: new Uint8Array(64),
    };

    // Mine the real 20-bit post PoW (~1M tries expected; the preimage
    // excludes powNonce and signature, so mining and signing commute).
    const powInput = postPowPreimage(basePost);
    let nonce = -1;
    for (let n = 0; n < 100_000_000; n++) {
      const ok = verifyPoW(powInput, n, POST_POW_TARGET_BITS);
      if (ok && nonce < 0) { nonce = n; break; }
      if (!ok && failingPostNonce < 0) failingPostNonce = n;
    }
    if (nonce < 0) throw new Error('post PoW search exhausted');

    validPost = { ...basePost, powNonce: nonce };
    validPost.signature = new Uint8Array(
      sign(null, signingHash(validPost), createPrivateKey({
        key: Buffer.from(keyPair.secretKey), format: 'der', type: 'pkcs8',
      })),
    );
    validSubBlock = subBlockFromPost(validPost, computePostId(validPost));
  }, 120_000);

  function validateSubBlock(sb: SubBlock) {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.subblock)!;
    const peer = newPeer(peerMgr);
    const result = validate(peer, { data: encodeSubBlock(sb) });
    return { result, peer, peerMgr, penaltySpy };
  }

  it('accepts a mined, signed sub-block with zero penalties (control anchor)', () => {
    const { result, peer, peerMgr, penaltySpy } = validateSubBlock(validSubBlock);
    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(0);
  });

  it('rejects the same sub-block with a corrupted signature (pre-fix code Accepted this)', () => {
    // Vacuity evidence: against pre-fix gossip.ts this exact message was
    // ACCEPTED and forwarded — runStage1SubBlock never called
    // verifyPostSignature, and the PoW preimage excludes the signature, so
    // every check that did run still passes here. The single-field-delta
    // control that Accepts is the real-signature case above. This is the
    // NET_INTERFACE Stage-1 drift being closed.
    const badSig = new Uint8Array(validPost.signature);
    badSig[0] = badSig[0]! ^ 0xff;
    const sb: SubBlock = {
      ...validSubBlock,
      post: { ...validPost, signature: badSig },
    };

    const { result, peer, penaltySpy } = validateSubBlock(sb);

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Signature invalid');
  });

  it('rejects a wrong post PoW nonce before the signature check runs', () => {
    // Self-check the nonce genuinely fails, then confirm the reason is the
    // PoW gate — the anti-spam check stays in front of the ~50µs signature.
    expect(verifyPoW(postPowPreimage(validPost), failingPostNonce, POST_POW_TARGET_BITS)).toBe(false);
    const sb: SubBlock = {
      ...validSubBlock,
      post: { ...validPost, powNonce: failingPostNonce },
    };

    const { result, peer, penaltySpy } = validateSubBlock(sb);

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Proof of Work invalid');
  });

  // Regression coverage from the pre-rewrite suite, now driven through the
  // real registered validator instead of an inline copy. Each delta trips a
  // check that runs before PoW, so the unmined variants stay cheap; the
  // asserted reason string pins the rejection to the intended check.

  it('rejects empty content', () => {
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, content: '' } };
    const { result, peer, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Content is empty');
  });

  it('rejects content exceeding 300 bytes', () => {
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, content: 'x'.repeat(301) } };
    const { result, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
  });

  it('rejects too many parent refs', () => {
    const refs = Array.from({ length: 9 }, () => 'ab'.repeat(32));
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, parentRefs: refs } };
    const { result, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported protocol version', () => {
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, protocolVersion: 999 } };
    const { result, peer, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'Unsupported protocol version',
    );
  });

  it('rejects a sub-block with a missing post', () => {
    const { post: _post, ...rest } = validSubBlock;
    const { result, peer, penaltySpy } = validateSubBlock(rest as SubBlock);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Sub-block missing post');
  });

  it('rejects a sub-block with non-array likeBoxes', () => {
    const sb = { ...validSubBlock, likeBoxes: 'not-array' } as unknown as SubBlock;
    const { result, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
  });
});
