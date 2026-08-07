// packages/node/test/harness/crypto-helpers.ts
import { createHash, sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  computeTxId,
  postPowPreimage,
  signingHash,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
} from '@dagsocial/types';
import type { Post, UtxoTransaction } from '@dagsocial/types';

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

export function blake32(d: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('blake2b512').update(d).digest().subarray(0, 32));
}

export function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrs) { out.set(a, pos); pos += a.length; }
  return out;
}

export function le64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

/**
 * The Post shape the canonical encoders read. `powNonce` and `signature` are
 * excluded from both the PoW preimage and the signing hash, so the placeholders
 * here never reach the bytes.
 */
function preimagePost(
  content: string, author: Uint8Array, parents: string[],
  chal: Uint8Array, ts: number,
): Post {
  return {
    content,
    author,
    parentRefs: parents,
    challenge: chal,
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts,
    signature: new Uint8Array(64),
  };
}

/**
 * PoW preimage — delegates to @dagsocial/types rather than rebuilding the
 * canonical encoding (audit M-1). A local copy here would let the harness mine
 * against bytes the node no longer verifies.
 */
export function powInput(
  content: string, author: Uint8Array, parents: string[],
  chal: Uint8Array, ts: number,
): Uint8Array {
  return postPowPreimage(preimagePost(content, author, parents, chal, ts));
}

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const b of hash) {
    if (b === 0) { bits += 8; continue; }
    let x = b;
    while ((x & 0x80) === 0) { bits++; x <<= 1; }
    break;
  }
  return bits;
}

export function solve(pi: Uint8Array, target: number): number {
  for (let n = 0; n < 100_000_000; n++) {
    if (leadingZeroBits(blake32(concat(pi, le64(n)))) >= target) return n;
  }
  throw new Error('PoW timeout');
}

export function signPost(
  content: string, author: Uint8Array, parents: string[],
  chal: Uint8Array, ts: number, userKey: KeyObject,
): string {
  const h = signingHash(preimagePost(content, author, parents, chal, ts));
  return hex(new Uint8Array(cryptoSign(null, h, userKey)));
}

export function signTx(tx: UtxoTransaction, userKey: KeyObject, pubHex: string): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), userKey);
  tx.signatures[pubHex] = new Uint8Array(sig);
}

export function txToApi(tx: UtxoTransaction): Record<string, unknown> {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map(o => {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        obj[k] = v instanceof Uint8Array ? hex(v)
          : typeof v === 'bigint' ? v.toString()
          : v;
      }
      return obj;
    }),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, hex(v as Uint8Array)]),
    ),
    preimages: tx.preimages
      ? Object.fromEntries(
          Object.entries(tx.preimages).map(([k, v]) => [k, hex(v as Uint8Array)]),
        )
      : undefined,
    protocolVersion: tx.protocolVersion,
    // Present ⟺ the tx is a like (P2-D) — the JSON edge must not drop it,
    // since it sits inside the signed bytes.
    ...(tx.likeTarget !== undefined ? { likeTarget: tx.likeTarget } : {}),
  };
}

/**
 * Post-lock tx — karma(total) → karma(total − lock) + PostLockBox(lock).
 *
 * There is deliberately no generic "spend N karma" builder: a user tx that
 * shrinks a karma box without producing a box for the difference destroys
 * value and the node rejects it. Karma is only burned by block-application
 * paths (decay, bond burn), never inside a user tx.
 */
export function postLockTx(
  boxes: { boxId: string; value: string }[],
  lockAmount: bigint,
  targetPostId: string,
  author: Uint8Array,
): UtxoTransaction {
  // API box values arrive as decimal strings (bigint on the wire).
  const t = boxes.reduce((s, b) => s + BigInt(b.value), 0n);
  return {
    inputs: boxes.map(b => b.boxId),
    outputs: [
      {
        boxType: 'karma', value: t - lockAmount, 
        owner: author, guard: 'owner_signature', proofSource: targetPostId, 
      },
      {
        boxType: 'post_lock', value: lockAmount, originalValue: lockAmount,
        owner: author, targetPostId, guard: 'epoch_tally',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Like tx (P2-D burn shape) — karma(total) → karma(total − LIKE_KARMA_COST),
 * `likeTarget` naming the post inside the signed bytes. The deficit IS the
 * like; there is no LikeBox and no unlike.
 */
export function likeTx(
  boxes: { boxId: string; value: string }[],
  targetPostId: string,
  liker: Uint8Array,
): UtxoTransaction {
  const t = boxes.reduce((s, b) => s + BigInt(b.value), 0n);
  return {
    inputs: boxes.map(b => b.boxId),
    outputs: [
      {
        boxType: 'karma', value: t - LIKE_KARMA_COST,
        owner: liker, guard: 'owner_signature', proofSource: targetPostId,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: targetPostId,
  };
}
