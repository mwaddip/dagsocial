import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeTxId,
  computeBoxId,
  canonicalBoxBytes,
  encodeTx,
  u32BE,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
  CREDIT_MINER_REWARD_DELAY,
  EMPTY_STATE_ROOT,
} from '@dagsocial/types';
import { verifyOrderingBlockPoW, blockHash } from '@dagsocial/validation';
import { materializeOutput } from '../src/services/utxo-engine.js';
import type {
  UtxoTransaction,
  AnyBox,
  Post,
  LikeBox,
  KarmaBox,
  BlockHeader,
  OrderingBlock,
  SubBlockEntry,
  PruneEntry,
} from '@dagsocial/types';

/**
 * Convert a short string label to a deterministic 32-byte Uint8Array
 * suitable as a UserId (Ed25519 public key) for testing.
 */
export function uid(label: string): Uint8Array {
  const h = createHash('blake2b512').update(label).digest();
  return new Uint8Array(h.subarray(0, 32));
}

/** Convert a Uint8Array userId to hex for comparison in test assertions */
export function uidHex(label: string): string {
  return Buffer.from(uid(label)).toString('hex');
}

/** Convert a Uint8Array userId to a hex string for HTTP API requests. */
export function toHex(u: Uint8Array): string {
  return Buffer.from(u).toString('hex');
}

// ---------------------------------------------------------------------------
// tx-hash signing helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
export function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/**
 * Sign a UtxoTransaction by computing its txId, signing that hash, and
 * storing the signature in `tx.signatures[pubKeyHex]`.
 */
export function signTransaction(
  tx: UtxoTransaction,
  privKey: KeyObject,
  pubKeyHex: string,
): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  tx.signatures[pubKeyHex] = new Uint8Array(sig);
}

// ---------------------------------------------------------------------------
// Shared block/box fixtures (used by block-apply, fork-resolution, and the
// journal round-trip suites — one definition, no per-file copies)
// ---------------------------------------------------------------------------

export interface TestIdentity {
  userId: Uint8Array;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

export function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  const userId = pubKey;
  return { userId, publicKey: pubKey, privateKey };
}

export function makePost(authorId: Uint8Array, content = 'test post'): Post {
  return {
    content,
    author: authorId,
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  };
}

/**
 * Synthetic creating-transaction provenance for a seeded fixture box.
 *
 * Fixtures seed boxes directly into the store rather than through a real
 * transaction or a mint, so they have no txId of their own — but `tx_id` and
 * `output_index` are NOT NULL as of Spec G phase G3b, and the box id now derives
 * from them. This manufactures a stand-in.
 *
 * Deterministic on the candidate bytes plus the seed height, so a fixture built
 * twice with the same arguments gets the same box id and golden vectors stay
 * stable across runs and file orderings. A counter would not: it would make ids
 * depend on how many boxes a test happened to build first.
 *
 * `nonce` is the escape hatch for a test that deliberately seeds two *identical*
 * boxes — without it they would derive one txId and trip
 * `UNIQUE(tx_id, output_index)`, which is the collision the id PK used to have.
 *
 * Its own domain tag, so a fixture id can never be mistaken for one a real mint
 * or transaction would produce.
 */
const FIXTURE_TX_DOMAIN = new TextEncoder().encode('dagsocial/test-fixture-tx/1');

export function fixtureProvenance(
  candidate: object,
  seedHeight: number,
  nonce = 0,
): { txId: string; index: number } {
  const txId = createHash('blake2b512')
    .update(FIXTURE_TX_DOMAIN)
    .update(canonicalBoxBytes(candidate as never))
    .update(u32BE(seedHeight))
    .update(u32BE(nonce))
    .digest()
    .subarray(0, 32)
    .toString('hex');
  return { txId, index: 0 };
}

/**
 * Give a hand-built candidate the provenance and id a stored box must have.
 *
 * The shape every local fixture factory needs since phase G3b: seeding a box
 * straight into the store now requires `tx_id`/`output_index` (NOT NULL) and an
 * `id` that actually derives from them. Mutates in place so a factory that
 * already holds a reference to the candidate keeps seeing the finished box.
 */
export function seedProvenance<T extends AnyBox>(candidate: object, seedHeight = 1, nonce = 0): T {
  Object.assign(candidate, fixtureProvenance(candidate, seedHeight, nonce));
  Object.assign(candidate, { id: computeBoxId(candidate as T) });
  return candidate as T;
}

/**
 * Seed several candidates as outputs of **one** synthetic transaction.
 *
 * The shape an invite/bond pair needs since the bond resolves its InviteBox from
 * `(bond.txId, bond.inviteOutputIndex)` (user decision, 2026-08-06). Seeding them
 * with independent provenance would leave the bond pointing at an index of a
 * transaction that has no invite at it — which is exactly the mispairing the
 * index form makes inexpressible in production, so a fixture must not fake it.
 *
 * Returns the boxes in the order given; each `index` is its position here.
 */
export function seedAsOneTx(candidates: object[], seedHeight = 1, nonce = 0): AnyBox[] {
  const { txId } = fixtureProvenance(candidates[0]!, seedHeight, nonce);
  return candidates.map((candidate, index) => {
    const box = { ...candidate, txId, index } as AnyBox;
    return { ...box, id: computeBoxId(box) } as AnyBox;
  });
}

export function makeLikeBox(
  likerId: Uint8Array,
  targetPostId: string,
  seedHeight: number,
  nonce = 0,
): LikeBox {
  const candidate = {
    boxType: 'like' as const,
    value: 2n,
    likerId,
    targetPostId,
    guard: 'epoch_tally' as const,
  };
  const box: LikeBox = { ...candidate, ...fixtureProvenance(candidate, seedHeight, nonce) };
  box.id = computeBoxId(box);
  return box;
}

export function makeKarmaBox(
  value: bigint,
  owner: Uint8Array,
  seedHeight: number,
  nonce = 0,
): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value,
    owner,
    guard: 'owner_signature' as const,
    proofSource: 'genesis',
  };
  const box: KarmaBox = { ...candidate, ...fixtureProvenance(candidate, seedHeight, nonce) };
  box.id = computeBoxId(box);
  return box;
}

/**
 * Build a signed like transaction — the P2-D burn shape a real client submits:
 * the liker's karma box is consumed into a single karma change box at
 * `−LIKE_KARMA_COST`, with `likeTarget` naming the post inside the signed
 * bytes. No LikeBox exists.
 *
 * Block application re-validates every embedded tx in full, so a fixture that
 * omitted the signature or mis-stated the deficit would be indistinguishable
 * from a forgery and would take the whole block down with it.
 */
export function makeLikeTx(
  liker: TestIdentity,
  karmaBox: KarmaBox,
  targetPostId: string,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaBox.value - LIKE_KARMA_COST,
        owner: liker.userId,
        guard: 'owner_signature',
        proofSource: 'like_op',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: targetPostId,
  };
  signTransaction(tx, liker.privateKey, Buffer.from(liker.userId).toString('hex'));
  return tx;
}

/**
 * The karma change box a `makeLikeTx` output creates, with its stored id.
 *
 * Routed through the production `materializeOutput` rather than re-deriving
 * here: the id now binds the creating transaction, so a fixture that computed it
 * any other way would be asserting against its own arithmetic instead of the
 * node's.
 */
export function changeBoxOf(tx: UtxoTransaction): KarmaBox {
  return materializeOutput(tx.outputs[0]!, computeTxId(tx), 0) as KarmaBox;
}

export const ZERO_HASH = '0'.repeat(64);

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * The first nonce that satisfies the header's declared target, found with the
 * production verifier.
 *
 * Hand-built blocks have to carry a real solution now that `powTargetBits` must
 * equal the height schedule: declaring target 0 to sail past PoW — how these
 * tests used to reach the checks behind it — is itself a rejected block.
 */
export function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

/**
 * The validator signature a block creator produces: raw Ed25519 over the 32
 * bytes of `blockHash(header)` (block-creator.ts:238, :556).
 *
 * Hand-built blocks have to carry a real signature now that apply verifies it
 * (H-1) — an all-zero placeholder is rejected before any check behind it, which
 * would make every post-signature rejection test assert its own reason
 * vacuously. Call this only once `powNonce` is final: the nonce is a header
 * field, so it is inside the hash being signed.
 */
export function signHeader(header: BlockHeader, privateKey: KeyObject): Uint8Array {
  return new Uint8Array(cryptoSign(null, Buffer.from(blockHash(header), 'hex'), privateKey));
}

/**
 * A PruneEntry that is internally valid in every respect a node can check
 * without knowing who the author is: the Merkle root is the real root over the
 * subtree ids, and the signature is a real Ed25519 signature over
 * blake2b(rootPostHash ‖ merkleRoot) from `signWith`, whose public key it
 * carries as `authorId`. What a test varies is *whose* key that is.
 */
export function makePruneEntry(
  rootPostHash: string,
  subtreePostIds: string[],
  signWith: TestIdentity,
): PruneEntry {
  const leaves = [...subtreePostIds].sort().map((id) => leafHash('stump', hexToBuf(id)));
  const subtreeMerkleRoot = buildMerkleRoot(leaves);
  const payload = createHash('blake2b512')
    .update(rootPostHash)
    .update(Buffer.from(subtreeMerkleRoot))
    .digest()
    .subarray(0, 32);
  return {
    rootPostHash,
    subtreePostIds,
    subtreeMerkleRoot,
    authorId: signWith.userId,
    authorSignature: new Uint8Array(cryptoSign(null, payload, signWith.privateKey)),
    trigger: 'author',
  };
}

/**
 * A hand-built block that passes every apply check: chain-linked at genesis,
 * correct Merkle roots, coinbase paying exactly the scheduled emission with the
 * scheduled maturity lock, the post-block AVL state root, a real PoW solution
 * at the scheduled target, and a real validator signature from the key its
 * header names.
 *
 * Each override deviates in exactly one respect, so what a test measures is
 * that deviation and nothing else.
 *
 * The state root is computed against the state *as it stands when this is
 * called*, because that is the state the mutation phase runs on. A block built
 * now and applied after the chain has moved carries a stale root and is
 * rejected — build it against the state it will be applied to.
 */
export async function makeApplicableBlock(
  opts: {
    powTargetBits?: number;
    lockedUntilBlock?: number;
    /** Override the post-block state root — a block committing to state it
     *  does not produce (H-6 divergence). */
    stateRoot?: string;
    /** Sign with this key instead of the miner's — a block whose signature does
     *  not come from the key its `validatorId` names (H-1 forged authorship). */
    signWith?: KeyObject;
    /** Height to build at; anything above 1 chain-links to the stored block below. */
    height?: number;
    /** Sub-block entries this block confirms (topology + authorship). */
    subBlockEntries?: SubBlockEntry[];
    /** Prune entries this block settles. */
    pruneEntries?: PruneEntry[];
    /** Mine to this identity (coinbase owner + validatorId) instead of a fresh
     *  one — lets a test seed pre-existing boxes for the coinbase owner. */
    miner?: TestIdentity;
    /** Embed these UTXO transactions directly — the validator-embeds-a-tx
     *  shape, bypassing every gateway (mempool intake, castLike's
     *  one-signature rule). Ids and CBOR are derived here, so the Merkle
     *  commitment is honest; whether the txs are *valid* is exactly what the
     *  suite's apply measures. Listed in the order given — dependency order
     *  is the apply loop's job. */
    utxoTxs?: UtxoTransaction[];
    /** Split the coinbase across these owners instead of paying the miner
     *  alone — the shape a node with `creditTreasuryPct > 0` produces. The
     *  shares must sum to the scheduled emission or apply rejects the block. */
    coinbaseSplit?: Array<{ owner: Uint8Array; value: bigint; isTreasury: boolean }>;
  } = {},
): Promise<OrderingBlock> {
  const { computeSubBlockRoot, computeUtxoTxRoot, computeBlockReward } = await import(
    '../src/services/block-creator.js'
  );
  const { expectedTarget } = await import('../src/services/difficulty.js');

  const height = opts.height ?? 1;
  let prevBlockHash = ZERO_HASH;
  if (height > 1) {
    const { getOrderingBlock } = await import('../src/store/ordering.js');
    const prev = getOrderingBlock(height - 1) as OrderingBlock | null;
    if (!prev) throw new Error(`makeApplicableBlock: no stored block at height ${height - 1}`);
    prevBlockHash = blockHash(prev.header);
  }
  const miner = opts.miner ?? makeTestIdentity();
  const subBlockEntries = opts.subBlockEntries ?? [];
  const subBlockTree = {
    subBlockRefs: subBlockEntries.map((e) => e.postId),
    subBlockEntries,
    pruneEntries: opts.pruneEntries ?? [],
  };
  const lockedUntilBlock = opts.lockedUntilBlock ?? height + CREDIT_MINER_REWARD_DELAY;
  const embeddedTxs = opts.utxoTxs ?? [];
  const utxoTxTree = {
    utxoTxIds: embeddedTxs.map((tx) => computeTxId(tx)),
    utxoTxs: embeddedTxs.map((tx) => encodeTx(tx)),
    likeBoxIds: [],
    coinbaseOutputs: (
      opts.coinbaseSplit ?? [
        { owner: miner.userId, value: computeBlockReward(height), isTreasury: false },
      ]
    ).map((share) => ({ ...share, lockedUntilBlock })),
  };

  const header = {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash,
    subBlockRoot: computeSubBlockRoot(subBlockTree),
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: miner.userId,
    powNonce: 0,
    powTargetBits: opts.powTargetBits ?? expectedTarget(height),
    createdAt: Date.now(),
  } as BlockHeader;

  const block = {
    header,
    subBlockTree,
    utxoTxTree,
    validatorSignature: new Uint8Array(64),
  } as unknown as OrderingBlock;

  // Post-block state root (H-6), obtained the way the block creator obtains
  // it: by running this body through the apply path's own mutation phase and
  // rolling it back. It has to be final before the nonce and the signature,
  // which both cover the header. No prover — most suites — speculates
  // `no-prover`, and apply skips the check there, so EMPTY_STATE_ROOT stands
  // in. A `body-rejected` body gets EMPTY_STATE_ROOT too: the helper's job is
  // to hand the caller its block either way, and the suite's own apply will
  // reject the body loudly.
  const { computePostBlockStateRoot } = await import('../src/services/block-apply.js');
  const speculation = computePostBlockStateRoot(block, height);
  header.stateRoot =
    opts.stateRoot ??
    (speculation.kind === 'computed' ? speculation.stateRoot : EMPTY_STATE_ROOT);

  header.powNonce = solveHeaderPow(header);
  block.validatorSignature = signHeader(header, opts.signWith ?? miner.privateKey);
  return block;
}

/**
 * Convert a UtxoTransaction to a JSON-safe object suitable for HTTP API
 * requests.  Uint8Array fields are hex-encoded.
 */
export function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map((o) => {
      const obj: Record<string, unknown> = { ...o };
      for (const [k, v] of Object.entries(obj)) {
        if (v instanceof Uint8Array) obj[k] = Buffer.from(v).toString('hex');
        // Box values/amounts are bigint — the JSON API carries them as
        // decimal strings (json-to-tx coerces them back).
        else if (typeof v === 'bigint') obj[k] = v.toString();
      }
      return obj;
    }),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
    ),
    preimages: tx.preimages
      ? Object.fromEntries(
          Object.entries(tx.preimages).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
        )
      : undefined,
    protocolVersion: tx.protocolVersion,
    // Present ⟺ the tx is a like (P2-D) — the JSON edge must not drop it,
    // since it sits inside the signed bytes.
    ...(tx.likeTarget !== undefined ? { likeTarget: tx.likeTarget } : {}),
  };
}
