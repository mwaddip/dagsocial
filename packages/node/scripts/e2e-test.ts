#!/usr/bin/env npx tsx
/** E2E feature test — exercises every feature against a running 2-node setup. */

import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { computePostId, computeTxId, signingHash, PROTOCOL_VERSION,
  LIKE_COST, INVITE_KARMA_AMOUNT, INVITE_BOND_KARMA } from '@dagsocial/types';
import type { KarmaBox, LikeBox, InviteBox, BondBox, UtxoTransaction } from '@dagsocial/types';

const NODES = [process.argv[2] ?? 'http://localhost:4011', process.argv[3] ?? 'http://localhost:4012'];
const WAIT = 30000; // block interval + cooldown

function rawPublicKey(keyObj: any): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}
function hex(u: Uint8Array): string { return Buffer.from(u).toString('hex'); }
function signTxId(tx: UtxoTransaction, privKey: any, pubKeyHex: string): void {
  tx.signatures[pubKeyHex] = new Uint8Array(cryptoSign(null, Buffer.from(computeTxId(tx), 'hex'), privKey));
}
function solvePoW(challenge: Uint8Array, content: string, author: Uint8Array,
                  parentRefs: string[], protocolVersion: number, timestamp: number, targetBits: number): number {
  const encoder = new TextEncoder();
  const parts = [encoder.encode(content), author, ...parentRefs.map(r => encoder.encode(r)),
    challenge, encoder.encode(String(protocolVersion)), encoder.encode(String(timestamp))];
  const input = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0; for (const p of parts) { input.set(p, off); off += p.length; }
  let nonce = 0;
  while (true) {
    const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
    const h = createHash('blake2b512').update(Buffer.from(input)).update(nb).digest().subarray(0, 32);
    let bits = 0;
    for (let i = 0; i < 32 && bits < targetBits; i++) {
      if (h[i] === 0) { bits += 8; continue; }
      let mask = 0x80;
      while ((h[i] & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= targetBits) return nonce;
    nonce++;
  }
}
function txToJson(tx: UtxoTransaction): any {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map((o: any) => {
      const obj: any = {};
      for (const [k, v] of Object.entries(o)) obj[k] = v instanceof Uint8Array ? hex(v) : v;
      return obj;
    }),
    signatures: Object.fromEntries(Object.entries(tx.signatures).map(([k, v]) => [k, hex(v)])),
    protocolVersion: tx.protocolVersion,
  };
}

async function postTo(node: string, path: string, body?: any) {
  const r = await fetch(`${node}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, data: await r.json() };
}
async function postBoth(path: string, body?: any) {
  const [r1, r2] = await Promise.all([postTo(NODES[0], path, body), postTo(NODES[1], path, body)]);
  return r1;
}
async function getBoth(path: string) {
  const r = await fetch(`${NODES[0]}${path}`);
  try { return { ok: r.ok, data: await r.json() }; }
  catch { return { ok: false, data: { error: 'not JSON' } }; }
}
async function getKarma(u: string) { return getBoth(`/karma/${u}`); }
function check(r: any, label: string): boolean {
  console.log(r.ok ? `  ✓ ${label}` : `  ✗ ${label} (${r.status}): ${JSON.stringify(r.data)}`);
  return r.ok;
}

async function wait(label: string) {
  console.log(`  waiting ${WAIT/1000}s for ${label}...`);
  await new Promise(r => setTimeout(r, WAIT));
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`E2E test against ${NODES[0]} + ${NODES[1]}\n`);
  let p = 0, f = 0;
  const pass = (r: any, l: string) => { if (check(r, l)) p++; else f++; return r.ok; };

  // Generate keys
  const aK = generateKeyPairSync('ed25519'), aPub = rawPublicKey(aK.publicKey), aPubH = hex(aPub);
  const bK = generateKeyPairSync('ed25519'), bPub = rawPublicKey(bK.publicKey), bPubH = hex(bPub);

  // ---- Identity + Faucet ----
  console.log('─── Identity + Faucet ───');
  if (!pass(await postBoth('/identity/import', { publicKey: aPubH }), 'Alice identity') ||
      !pass(await postBoth('/identity/import', { publicKey: bPubH }), 'Bob identity') ||
      !pass(await postBoth('/faucet', { userId: aPubH }), 'faucet Alice') ||
      !pass(await postBoth('/faucet', { userId: bPubH }), 'faucet Bob')) { process.exit(1); }
  await wait('faucet confirm');

  let aKb = await getKarma(aPubH), bKb = await getKarma(bPubH);
  if (!pass(aKb, 'Alice karma') || !pass(bKb, 'Bob karma')) { process.exit(1); }
  console.log(`    Alice: ${aKb.data.balance}  Bob: ${bKb.data.balance}`);

  // ---- Post ----
  console.log('\n─── Post ───');
  const chal = await postTo(NODES[0], '/challenge', { userId: aPubH });
  if (!pass(chal, 'challenge')) { process.exit(1); }
  const ts = Date.now(), c = new Uint8Array(Buffer.from(chal.data.challenge, 'hex'));
  const nonce = solvePoW(c, 'Hello DAGsocial!', aPub, [], PROTOCOL_VERSION, ts, 20);
  const po: any = { content: 'Hello DAGsocial!', author: aPub, parentRefs: [], challenge: c,
    powNonce: nonce, protocolVersion: PROTOCOL_VERSION, timestamp: ts, signature: new Uint8Array(64) };
  const pid = computePostId(po);
  po.signature = new Uint8Array(cryptoSign(null, signingHash(po), aK.privateKey));

  const aBal1 = aKb.data.balance, aBid1 = aKb.data.boxId;
  const ltx: UtxoTransaction = { inputs: [aBid1], outputs: [
    { boxType: 'karma', value: aBal1 - 1, createdAtBlock: 0, owner: aPub,
      guard: 'owner_signature', proofSource: 'post_lock', lastTouchBlock: 0 } as KarmaBox,
    { boxType: 'post_lock', value: 1, createdAtBlock: 0, targetPostId: pid, originalValue: 1,
      owner: aPub, guard: 'epoch_tally' } as any,
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  signTxId(ltx, aK.privateKey, aPubH);

  const pr = await postBoth('/posts', {
    content: po.content, author: aPubH, parentRefs: [], challenge: chal.data.challenge,
    powNonce: nonce, protocolVersion: PROTOCOL_VERSION, timestamp: ts,
    signature: hex(po.signature), karmaLockTx: txToJson(ltx),
  });
  if (!pass(pr, 'create post')) { process.exit(1); }
  console.log(`    postId: ${pr.data.postId?.slice(0,16)}...`);
  const ppid = pr.data.postId;
  await wait('post confirm');

  // ---- Reply ----
  console.log('\n─── Reply ───');
  let aK2 = await getKarma(aPubH);
  if (!pass(aK2, 'Alice karma after post')) { process.exit(1); }
  console.log(`    balance: ${aK2.data.balance}`);

  const chal2 = await postTo(NODES[0], '/challenge', { userId: aPubH });
  if (!pass(chal2, 'challenge reply')) { process.exit(1); }
  const ts2 = Date.now(), c2 = new Uint8Array(Buffer.from(chal2.data.challenge, 'hex'));
  const rn = solvePoW(c2, 'Reply!', aPub, [ppid], PROTOCOL_VERSION, ts2, 20);
  const ro: any = { content: 'Reply!', author: aPub, parentRefs: [ppid], challenge: c2,
    powNonce: rn, protocolVersion: PROTOCOL_VERSION, timestamp: ts2, signature: new Uint8Array(64) };
  const rid = computePostId(ro);
  ro.signature = new Uint8Array(cryptoSign(null, signingHash(ro), aK.privateKey));

  const rltx: UtxoTransaction = { inputs: [aK2.data.boxId], outputs: [
    { boxType: 'karma', value: aK2.data.balance - 1, createdAtBlock: 0, owner: aPub,
      guard: 'owner_signature', proofSource: 'post_lock', lastTouchBlock: 0 } as KarmaBox,
    { boxType: 'post_lock', value: 1, createdAtBlock: 0, targetPostId: rid, originalValue: 1,
      owner: aPub, guard: 'epoch_tally' } as any,
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  signTxId(rltx, aK.privateKey, aPubH);

  const rr = await postBoth('/posts', {
    content: ro.content, author: aPubH, parentRefs: [ppid], challenge: chal2.data.challenge,
    powNonce: rn, protocolVersion: PROTOCOL_VERSION, timestamp: ts2,
    signature: hex(ro.signature), karmaLockTx: txToJson(rltx),
  });
  if (!pass(rr, 'create reply')) { process.exit(1); }
  console.log(`    replyId: ${rr.data.postId?.slice(0,16)}...`);
  await wait('reply confirm');

  // ---- Like ----
  console.log('\n─── Like ───');
  let bK2 = await getKarma(bPubH);
  if (!pass(bK2, 'Bob karma for like')) { process.exit(1); }
  console.log(`    Bob balance: ${bK2.data.balance}`);
  const likeTx: UtxoTransaction = { inputs: [bK2.data.boxId], outputs: [
    { boxType: 'karma', value: bK2.data.balance - LIKE_COST, createdAtBlock: 0, owner: bPub,
      guard: 'owner_signature', proofSource: 'like_op', lastTouchBlock: 0 } as KarmaBox,
    { boxType: 'like', value: LIKE_COST, createdAtBlock: 0, likerId: bPub,
      targetPostId: ppid, guard: 'epoch_tally' } as LikeBox,
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  signTxId(likeTx, bK.privateKey, bPubH);
  if (!pass(await postBoth('/likes', { tx: txToJson(likeTx) }), 'cast like')) { process.exit(1); }
  await wait('like confirm');

  // ---- Invite ----
  console.log('\n─── Invite ───');
  let aK3 = await getKarma(aPubH);
  if (!pass(aK3, 'Alice karma for invite')) { process.exit(1); }
  console.log(`    Alice balance: ${aK3.data.balance}`);
  const secret = new Uint8Array(Buffer.from('secret-for-invite-1234'));
  const sh = new Uint8Array(createHash('blake2b512').update(secret).digest().subarray(0, 32));
  const chg = aK3.data.balance - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA;
  const invTx: UtxoTransaction = { inputs: [aK3.data.boxId], outputs: [
    { boxType: 'karma', value: chg, createdAtBlock: 0, owner: aPub,
      guard: 'owner_signature', proofSource: 'invite_create', lastTouchBlock: 0 } as KarmaBox,
    { boxType: 'invite', value: INVITE_KARMA_AMOUNT, createdAtBlock: 0,
      inviterId: aPub, secretHash: sh, guard: 'hash_preimage' } as InviteBox,
    { boxType: 'bond', value: INVITE_BOND_KARMA, createdAtBlock: 0, inviterId: aPub,
      inviteePublicKey: new Uint8Array(0), probationStartBlock: 0, probationEndBlock: 0,
      guard: 'inviter_signature' } as BondBox,
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  signTxId(invTx, aK.privateKey, aPubH);
  if (!pass(await postBoth('/invites', { tx: txToJson(invTx) }), 'create invite')) { process.exit(1); }
  await wait('invite confirm');

  // ---- Final query ----
  console.log('\n─── Final State ───');
  const qr = await getBoth('/posts?limit=10');
  if (pass(qr, 'query posts') && Array.isArray(qr.data)) {
    for (const p of qr.data) {
      console.log(`    ${p.id?.slice(0,14)}... "${(p.content||'').slice(0,40)}" status:${p.status} likes:${p.likeCount}`);
    }
  }
  const thread = await getBoth(`/posts?rootPostId=${ppid}&limit=10`);
  if (pass(thread, 'thread')) console.log(`    thread size: ${thread.data?.length}`);

  const aF = await getKarma(aPubH), bF = await getKarma(bPubH);
  pass(aF, 'Alice final karma'); pass(bF, 'Bob final karma');
  console.log(`    Alice: ${aF.data.balance} (started ${aBal1}, diff ${aF.data.balance - aBal1})`);
  console.log(`    Bob: ${bF.data.balance} (started ${bKb.data.balance}, diff ${bF.data.balance - bKb.data.balance})`);

  console.log(`\n═══════════════════════════════════`);
  console.log(`  Passed: ${p}  Failed: ${f}`);
  console.log(`═══════════════════════════════════`);
  if (f > 0) process.exit(1);
}
main().catch(err => { console.error('Fatal:', err); process.exit(1); });
