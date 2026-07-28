// packages/node/test/harness/crypto-helpers.ts
import { createHash, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { computeTxId, PROTOCOL_VERSION, LIKE_COST, POST_LOCK_THREAD_COST, POST_LOCK_REPLY_COST } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';

const encoder = new TextEncoder();

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

export function powInput(
  content: string, author: Uint8Array, parents: string[],
  chal: Uint8Array, ts: number,
): Uint8Array {
  return concat(
    encoder.encode(content), author,
    ...parents.map(p => encoder.encode(p)),
    chal,
    encoder.encode(String(PROTOCOL_VERSION)),
    encoder.encode(String(ts)),
  );
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
  const h = createHash('blake2b512');
  h.update(content);
  h.update(author);
  for (const ref of parents) h.update(ref);
  h.update(chal);
  h.update(String(PROTOCOL_VERSION));
  h.update(String(ts));
  return hex(new Uint8Array(cryptoSign(null, h.digest().subarray(0, 32), userKey)));
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
        obj[k] = v instanceof Uint8Array ? hex(v) : v;
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
  };
}

export function karmaTx(
  boxes: { boxId: string; value: number }[],
  spend: number,
  proof: string,
  owner: Uint8Array,
): UtxoTransaction {
  const t = boxes.reduce((s, b) => s + b.value, 0);
  return {
    inputs: boxes.map(b => b.boxId),
    outputs: [{
      boxType: 'karma', value: t - spend, createdAtBlock: 0,
      owner, guard: 'owner_signature', proofSource: proof, lastTouchBlock: 0,
    }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

export function postLockTx(
  boxes: { boxId: string; value: number }[],
  lockAmount: number,
  targetPostId: string,
  author: Uint8Array,
): UtxoTransaction {
  const t = boxes.reduce((s, b) => s + b.value, 0);
  return {
    inputs: boxes.map(b => b.boxId),
    outputs: [
      {
        boxType: 'karma', value: t - lockAmount, createdAtBlock: 0,
        owner: author, guard: 'owner_signature', proofSource: targetPostId, lastTouchBlock: 0,
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

export function likeTx(
  boxes: { boxId: string; value: number }[],
  targetPostId: string,
  liker: Uint8Array,
): UtxoTransaction {
  const t = boxes.reduce((s, b) => s + b.value, 0);
  return {
    inputs: boxes.map(b => b.boxId),
    outputs: [
      {
        boxType: 'karma', value: t - LIKE_COST, createdAtBlock: 0,
        owner: liker, guard: 'owner_signature', proofSource: targetPostId, lastTouchBlock: 0,
      },
      {
        boxType: 'like', value: LIKE_COST, createdAtBlock: 0,
        likerId: liker, targetPostId, guard: 'epoch_tally',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}
