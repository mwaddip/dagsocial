#!/usr/bin/env npx tsx
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { computePostId, computeTxId, signingHash, PROTOCOL_VERSION, LIKE_COST } from '@dagsocial/types';

const N1 = 'http://localhost:4011', N2 = 'http://localhost:4012';
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const rawPub = (k: any): Uint8Array => { const d = k.export({ type: 'spki', format: 'der' }) as Buffer; return new Uint8Array(d.subarray(d.length - 32)); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function api(m: string, url: string, body?: any) {
  const r = await fetch(url, { method: m, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { ok: r.ok, status: r.status, data: t ? JSON.parse(t) : {} };
}
async function get(url: string) { try { return await api('GET', url); } catch { return { ok: false, status: 0, data: {} }; } }

// Convert a tx object to API format (Uint8Array → hex, matching the existing e2e-test.ts)
function txToApi(tx: any): any {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map((o: any) => {
      const obj: any = {};
      for (const [k, v] of Object.entries(o)) obj[k] = v instanceof Uint8Array ? hex(v as Uint8Array) : v;
      return obj;
    }),
    signatures: Object.fromEntries(Object.entries(tx.signatures).map(([k, v]) => [k, hex(v as Uint8Array)])),
    protocolVersion: tx.protocolVersion,
  };
}

function solvePoW(content: string, author: Uint8Array, parentRefs: string[], challenge: Uint8Array, protocolVersion: number, timestamp: number, targetBits: number): number {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(content), author];
  for (const p of parentRefs) parts.push(enc.encode(p));
  parts.push(challenge, enc.encode(String(protocolVersion)), enc.encode(String(timestamp)));
  const len = parts.reduce((s, p) => s + p.length, 0);
  const input = new Uint8Array(len); let off = 0;
  for (const p of parts) { input.set(p, off); off += p.length; }
  for (let n = 0; n < 100_000_000; n++) {
    const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(n));
    const h = createHash('blake2b512').update(Buffer.from(input)).update(nb).digest().subarray(0, 32);
    let bits = 0;
    for (let i = 0; i < 32 && bits < targetBits; i++) {
      if (h[i] === 0) { bits += 8; continue; }
      let mask = 0x80; while ((h[i] & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= targetBits) return n;
  }
  throw new Error('PoW timeout');
}

const P = (r: any, label: string) => { const ok = r.ok; console.log(ok ? `  ✓ ${label}` : `  ✗ ${label} (${r.status}): ${JSON.stringify(r.data).slice(0,250)}`); return ok; };

async function main() {
  console.log('E2E: 2-node post+reply+like+sync\n');
  const aK = generateKeyPairSync('ed25519'), aPub = rawPub(aK.publicKey), aPubH = hex(aPub);
  const bK = generateKeyPairSync('ed25519'), bPub = rawPub(bK.publicKey), bPubH = hex(bPub);
  console.log(`Alice: ${aPubH.slice(0,16)}...  Bob: ${bPubH.slice(0,16)}...`);

  // Faucet
  console.log('\n─── Faucet ───');
  P(await api('POST', `${N1}/faucet`, { userId: aPubH }), 'Alice faucet');
  await sleep(8000);
  let aKb = await get(`${N1}/karma/${aPubH}`);
  if (!P(aKb, `Alice karma`)) process.exit(1);
  console.log(`  Alice: ${aKb.data.total}`);

  P(await api('POST', `${N1}/faucet`, { userId: bPubH }), 'Bob faucet');
  await sleep(8000);
  let bKb = await get(`${N1}/karma/${bPubH}`);
  if (!P(bKb, `Bob karma`)) process.exit(1);
  console.log(`  Bob: ${bKb.data.total}`);

  // Post
  console.log('\n─── Post ───');
  const chal = await api('POST', `${N1}/challenge`, { userId: aPubH });
  P(chal, 'challenge');
  const ts = Date.now(), c = unhex(chal.data.challenge);
  const nonce = solvePoW('Hello DAGsocial!', aPub, [], c, PROTOCOL_VERSION, ts, chal.data.targetBits);
  console.log(`  PoW: ${nonce} (target: ${chal.data.targetBits})`);

  const po: any = { content: 'Hello DAGsocial!', author: aPub, parentRefs: [], challenge: c, powNonce: nonce, protocolVersion: PROTOCOL_VERSION, timestamp: ts, signature: new Uint8Array(64) };
  const pid = computePostId(po);
  // Sign the post
  const postSig = cryptoSign(null, signingHash(po), aK.privateKey);

  // Build karma lock tx with raw bytes, sign in raw bytes
  const aBid = aKb.data.boxes?.[0]?.boxId, aBal = aKb.data.total;
  const ltx: any = { inputs: [aBid], outputs: [
    { boxType: 'karma', value: aBal - 1, createdAtBlock: 0, owner: aPub, guard: 'owner_signature', proofSource: 'post_lock', lastTouchBlock: 0 },
    { boxType: 'post_lock', value: 1, createdAtBlock: 0, targetPostId: pid, originalValue: 1, owner: aPub, guard: 'epoch_tally' }
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  const txId = computeTxId(ltx);
  ltx.signatures[aPubH] = new Uint8Array(cryptoSign(null, Buffer.from(txId, 'hex'), aK.privateKey));

  const pr = await api('POST', `${N1}/posts`, { content: 'Hello DAGsocial!', author: aPubH, parentRefs: [], challenge: chal.data.challenge, powNonce: nonce, protocolVersion: PROTOCOL_VERSION, timestamp: ts, signature: hex(new Uint8Array(postSig)), karmaLockTx: txToApi(ltx) });
  if (!P(pr, 'create post')) process.exit(1);
  const ppid = pr.data.postId;
  console.log(`  postId: ${ppid?.slice(0,14)}...`);
  await sleep(12000);

  let n1posts = await get(`${N1}/posts?limit=5`);
  P(n1posts, `N1 posts: ${n1posts.data?.length ?? 0}`);
  if (n1posts.data?.length > 0) console.log(`  N1: ${n1posts.data[0].id?.slice(0,12)}... "${n1posts.data[0].content}" status:${n1posts.data[0].status}`);

  // Reply
  console.log('\n─── Reply ───');
  let aK2 = await get(`${N1}/karma/${aPubH}`);
  const chal2 = await api('POST', `${N1}/challenge`, { userId: aPubH });
  const ts2 = Date.now(), c2 = unhex(chal2.data.challenge);
  const rn = solvePoW('Reply!', aPub, [ppid], c2, PROTOCOL_VERSION, ts2, chal2.data.targetBits);
  const ro: any = { content: 'Reply!', author: aPub, parentRefs: [ppid], challenge: c2, powNonce: rn, protocolVersion: PROTOCOL_VERSION, timestamp: ts2, signature: new Uint8Array(64) };
  const rid = computePostId(ro);
  const replySig = cryptoSign(null, signingHash(ro), aK.privateKey);

  const aBid2 = aK2.data.boxes?.[0]?.boxId, aBal2 = aK2.data.total;
  const rltx: any = { inputs: [aBid2], outputs: [
    { boxType: 'karma', value: aBal2 - 1, createdAtBlock: 0, owner: aPub, guard: 'owner_signature', proofSource: 'post_lock', lastTouchBlock: 0 },
    { boxType: 'post_lock', value: 1, createdAtBlock: 0, targetPostId: rid, originalValue: 1, owner: aPub, guard: 'epoch_tally' }
  ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
  const rtxId = computeTxId(rltx);
  rltx.signatures[aPubH] = new Uint8Array(cryptoSign(null, Buffer.from(rtxId, 'hex'), aK.privateKey));

  P(await api('POST', `${N1}/posts`, { content: 'Reply!', author: aPubH, parentRefs: [ppid], challenge: chal2.data.challenge, powNonce: rn, protocolVersion: PROTOCOL_VERSION, timestamp: ts2, signature: hex(new Uint8Array(replySig)), karmaLockTx: txToApi(rltx) }), 'create reply');
  await sleep(12000);

  // Like
  console.log('\n─── Like ───');
  let bK2 = await get(`${N1}/karma/${bPubH}`);
  const bBid = bK2.data.boxes?.[0]?.boxId, bBal = bK2.data.total;
  if (bBid && bBal >= LIKE_COST) {
    const ltx2: any = { inputs: [bBid], outputs: [
      { boxType: 'karma', value: bBal - LIKE_COST, createdAtBlock: 0, owner: bPub, guard: 'owner_signature', proofSource: 'like_op', lastTouchBlock: 0 },
      { boxType: 'like', value: LIKE_COST, createdAtBlock: 0, likerId: bPub, targetPostId: ppid, guard: 'epoch_tally' }
    ], signatures: {}, protocolVersion: PROTOCOL_VERSION };
    const ltxId = computeTxId(ltx2);
    ltx2.signatures[bPubH] = new Uint8Array(cryptoSign(null, Buffer.from(ltxId, 'hex'), bK.privateKey));
    P(await api('POST', `${N1}/likes`, { tx: txToApi(ltx2) }), 'cast like');
    await sleep(12000);
    const pw = await get(`${N1}/posts/${ppid}`);
    console.log(`  Post likes: ${pw.data?.likeCount ?? '?'}  status: ${pw.data?.status ?? '?'}`);
  }

  // SYNC
  console.log('\n─── Sync ───');
  await sleep(20000);
  const s1 = await get(`${N1}/status`), s2 = await get(`${N2}/status`);
  const h1 = s1.data?.blockHeight ?? 0, h2 = s2.data?.blockHeight ?? 0;
  console.log(`  N1 height=${h1} posts=${s1.data?.postCount}  N2 height=${h2} posts=${s2.data?.postCount}`);
  console.log(h1 === h2 ? '  ✓ Heights match' : `  ⚠ Delta: ${Math.abs(h1-h2)}`);

  const n2p = await get(`${N2}/posts?limit=10`), n1p = await get(`${N1}/posts?limit=10`);
  console.log(`  N1 posts: ${n1p.data?.length ?? 0}  N2 posts: ${n2p.data?.length ?? 0}`);

  if (n1p.data?.length > 0) for (const p of n1p.data.slice(0, 5)) console.log(`  N1: ${p.id?.slice(0,12)}... "${p.content?.slice(0,30)}" status:${p.status} likes:${p.likeCount}`);
  if (n2p.data?.length > 0) for (const p of n2p.data.slice(0, 5)) console.log(`  N2: ${p.id?.slice(0,12)}... "${p.content?.slice(0,30)}" status:${p.status} likes:${p.likeCount}`);

  console.log(`\n═══════════════════════════`);
  const synced = n2p.data?.length > 0 && h1 === h2;
  console.log(synced ? '  ✓ SYNCED' : '  ⚠ NOT FULLY SYNCED');
  console.log(`═══════════════════════════`);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
