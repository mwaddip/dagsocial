#!/usr/bin/env npx tsx
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { computePostId, signingHash, PROTOCOL_VERSION, LIKE_COST } from '@dagsocial/types';

const N1 = 'http://localhost:4011', N2 = 'http://localhost:4012';

function hex(u: Uint8Array): string { return Buffer.from(u).toString('hex'); }
function unhex(s: string) { return new Uint8Array(Buffer.from(s, 'hex')); }
function rawPub(keyObj: any): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function post(url: string, body?: any) {
  const r = await fetch(url, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { ok: r.ok, status: r.status, data: t ? JSON.parse(t) : {} };
}
async function get(url: string) {
  try {
    const r = await fetch(url); const t = await r.text();
    return { ok: r.ok, status: r.status, data: t ? JSON.parse(t) : {} };
  } catch { return { ok: false, status: 0, data: {} }; }
}

function signTxId(tx: any, privKey: any, pubHex: string): void {
  const { computeTxId } = require('@dagsocial/types');
  tx.signatures[pubHex] = hex(new Uint8Array(cryptoSign(null, Buffer.from(computeTxId(tx), 'hex'), privKey)));
}

// PoW — matches node implementation: concat(content, author, ...parents.map(encoder.encode), challenge, encoder.encode(String(protocolVersion)), encoder.encode(String(timestamp)))
function solvePoW(content: string, author: Uint8Array, parentRefs: string[], challenge: Uint8Array, protocolVersion: number, timestamp: number, targetBits: number): number {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode(content), author];
  for (const p of parentRefs) parts.push(encoder.encode(p));
  parts.push(challenge, encoder.encode(String(protocolVersion)), encoder.encode(String(timestamp)));
  const len = parts.reduce((s, p) => s + p.length, 0);
  const input = new Uint8Array(len); let off = 0;
  for (const p of parts) { input.set(p, off); off += p.length; }

  for (let n = 0; n < 100_000_000; n++) {
    const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(n));
    const h = createHash('blake2b512').update(Buffer.from(input)).update(nb).digest().subarray(0, 32);
    let bits = 0;
    for (let i = 0; i < 32 && bits < targetBits; i++) {
      if (h[i] === 0) { bits += 8; continue; }
      let mask = 0x80;
      while ((h[i] & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= targetBits) return n;
  }
  throw new Error('PoW timeout');
}

const P = (r: any, label: string) => {
  const ok = r.ok;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label} (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
  return ok;
};

async function main() {
  console.log('Quick E2E — 3s blocks\n');

  // Generate keys
  const aK = generateKeyPairSync('ed25519'), aPub = rawPub(aK.publicKey), aPubH = hex(aPub);
  const bK = generateKeyPairSync('ed25519'), bPub = rawPub(bK.publicKey), bPubH = hex(bPub);
  console.log(`Alice: ${aPubH.slice(0,16)}...  Bob: ${bPubH.slice(0,16)}...`);

  // ===== Faucet (submit to N1, will sync to N2) =====
  console.log('\n─── Faucet ───');
  if (!P(await post('${N1}/faucet', { userId: aPubH }), 'Alice faucet')) process.exit(1);
  if (!P(await post('${N1}/faucet', { userId: bPubH }), 'Bob faucet')) process.exit(1);
  await sleep(8000);

  let aKb = await get(`${N1}/karma/${aPubH}`), bKb = await get(`${N1}/karma/${bPubH}`);
  if (!P(aKb, 'Alice karma') || !P(bKb, 'Bob karma')) process.exit(1);
  console.log(`  Alice: ${aKb.data.total}  Bob: ${bKb.data.total}`);

  // ===== Post =====
  console.log('\n─── Post ───');
  const chal = await post(N1, '/challenge', { userId: aPubH });
  if (!P(chal, 'challenge')) process.exit(1);
  const ts = Date.now(), c = unhex(chal.data.challenge);
  const nonce = solvePoW('Hello DAGsocial!', aPub, [], c, PROTOCOL_VERSION, ts, chal.data.targetBits);
  console.log(`  PoW nonce: ${nonce}`);

  const po: any = { content: 'Hello DAGsocial!', author: aPub, parentRefs: [], challenge: c,
    powNonce: nonce, protocolVersion: PROTOCOL_VERSION, timestamp: ts, signature: new Uint8Array(64) };
  const pid = computePostId(po);
  po.signature = new Uint8Array(cryptoSign(null, signingHash(po), aK.privateKey));

  // Build karma lock tx
  const aBal = aKb.data.total, aBid = aKb.data.boxes?.[0]?.boxId;
  if (!aBid) { console.log('  ✗ No karma box'); process.exit(1); }
  const lockTx: any = { inputs: [aBid], outputs: [
    { boxType: 'karma', value: aBal - 1, createdAtBlock: 0, owner: aPub, guard: 'owner_signature', proofSource: 'post_lock', lastTouchBlock: 0 },
    { boxType: 'post_lock', value: 1, createdAtBlock: 0, targetPostId: pid, originalValue: 1, owner: aPub, guard: 'epoch_tally' }
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  signTxId(lockTx, aK.privateKey, aPubH);

  const pr = await post(N1, '/posts', {
    content: 'Hello DAGsocial!', author: aPubH, parentRefs: [],
    challenge: chal.data.challenge, powNonce: nonce, protocolVersion: PROTOCOL_VERSION,
    timestamp: ts, signature: hex(po.signature), karmaLockTx: lockTx
  });
  if (!P(pr, `create post`)) process.exit(1);
  const ppid = pr.data.postId;
  console.log(`  postId: ${ppid?.slice(0,16)}...`);
  await sleep(8000);

  // Verify post visible
  const posts = await get(`${N1}/posts?limit=5`);
  P(posts, `N1 posts (${posts.data?.length ?? 0})`);

  // ===== Reply =====
  console.log('\n─── Reply ───');
  let aK2 = await get(`${N1}/karma/${aPubH}`);
  const chal2 = await post(N1, '/challenge', { userId: aPubH });
  const ts2 = Date.now(), c2 = unhex(chal2.data.challenge);
  const rn = solvePoW('Reply!', aPub, [ppid], c2, PROTOCOL_VERSION, ts2, chal2.data.targetBits);
  const ro: any = { content: 'Reply!', author: aPub, parentRefs: [ppid], challenge: c2,
    powNonce: rn, protocolVersion: PROTOCOL_VERSION, timestamp: ts2, signature: new Uint8Array(64) };
  ro.signature = new Uint8Array(cryptoSign(null, signingHash(ro), aK.privateKey));

  const aBid2 = aK2.data.boxes?.[0]?.boxId, aBal2 = aK2.data.total;
  const rLockTx: any = { inputs: [aBid2], outputs: [
    { boxType: 'karma', value: aBal2 - 1, createdAtBlock: 0, owner: aPub, guard: 'owner_signature', proofSource: 'post_lock', lastTouchBlock: 0 },
    { boxType: 'post_lock', value: 1, createdAtBlock: 0, targetPostId: ro.signature ? '' : '', originalValue: 1, owner: aPub, guard: 'epoch_tally' }
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  const rid = computePostId(ro);
  rLockTx.outputs[1].targetPostId = rid;
  signTxId(rLockTx, aK.privateKey, aPubH);

  const rr = await post(N1, '/posts', {
    content: 'Reply!', author: aPubH, parentRefs: [ppid],
    challenge: chal2.data.challenge, powNonce: rn, protocolVersion: PROTOCOL_VERSION,
    timestamp: ts2, signature: hex(ro.signature), karmaLockTx: rLockTx
  });
  P(rr, `create reply`);
  await sleep(8000);

  // ===== Like (Bob likes Alice's post) =====
  console.log('\n─── Like ───');
  let bK2 = await get(`${N1}/karma/${bPubH}`);
  const bBid = bK2.data.boxes?.[0]?.boxId, bBal = bK2.data.total;
  if (bBid && bBal >= LIKE_COST) {
    const ltx: any = { inputs: [bBid], outputs: [
      { boxType: 'karma', value: bBal - LIKE_COST, createdAtBlock: 0, owner: bPub, guard: 'owner_signature', proofSource: 'like_op', lastTouchBlock: 0 },
      { boxType: 'like', value: LIKE_COST, createdAtBlock: 0, likerId: bPub, targetPostId: ppid, guard: 'epoch_tally' }
    ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
    signTxId(ltx, bK.privateKey, bPubH);
    const lr = await post(N1, '/likes', { tx: ltx });
    P(lr, 'cast like');
    await sleep(8000);

    const pWithLikes = await get(`${N1}/posts/${ppid}`);
    console.log(`  Post likes: ${pWithLikes.data?.likeCount ?? 'unknown'}`);
  }

  // ===== SYNC VERIFICATION =====
  console.log('\n─── Sync Check ───');
  await sleep(12000);

  const n1s = await get(`${N1}/status`);
  const n2s = await get(`${N2}/status`);
  const h1 = n1s.data?.blockHeight ?? 0, h2 = n2s.data?.blockHeight ?? 0;
  console.log(`  N1: height=${h1} posts=${n1s.data?.postCount}`);
  console.log(`  N2: height=${h2} posts=${n2s.data?.postCount}`);
  console.log(h1 === h2 ? '  ✓ Heights match' : `  ⚠ Height delta: ${Math.abs(h1-h2)}`);

  const n2posts = await get(`${N2}/posts?limit=10`);
  console.log(`  N2 posts: ${n2posts.data?.length ?? 0}`);
  if (n2posts.data?.length > 0) {
    for (const p of n2posts.data.slice(0, 5)) {
      console.log(`    ${p.id?.slice(0,14)}... "${p.content?.slice(0,40)}" status:${p.status} likes:${p.likeCount}`);
    }
  } else {
    console.log('  ⚠ N2 has no posts — sync may not have completed');
  }

  // N1 final state
  const n1posts = await get(`${N1}/posts?limit=10`);
  console.log(`  N1 posts: ${n1posts.data?.length ?? 0}`);
  if (n1posts.data?.length > 0) {
    for (const p of n1posts.data.slice(0, 5)) {
      console.log(`    ${p.id?.slice(0,14)}... "${p.content?.slice(0,40)}" status:${p.status} likes:${p.likeCount}`);
    }
  }

  console.log('\n═══════════════════════════');
  const synced = n2posts.data?.length > 0;
  console.log(synced ? '  ✓ SYNCED — N2 has posts from N1' : '  ⚠ NOT SYNCED — N2 missing posts');
  console.log('═══════════════════════════');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
