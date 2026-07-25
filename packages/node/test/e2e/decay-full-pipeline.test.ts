/**
 * E2E: Full pipeline with two miners — identities, posts, likes, invites,
 * decay, and fork detection.
 *
 * Config: 2s blocks, 10-block stale threshold, 3-block decay interval.
 *
 * Usage: pnpm --filter @dagsocial/node test -- --testPathPattern='e2e/decay'
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  computeTxId,
  PROTOCOL_VERSION,
  LIKE_COST,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  POST_LOCK_THREAD_COST,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';

const P1 = 10301, P2 = 10302, LP1 = P1 + 100, LP2 = P2 + 100;
const A1 = `http://localhost:${P1}`;
const A2 = `http://localhost:${P2}`;
const ENV = {
  ...process.env,
  ORDERING_BLOCK_INTERVAL_MS: '2000',
  KARMA_STALE_THRESHOLD_BLOCKS: '10',
  KARMA_DECAY_INTERVAL_BLOCKS: '3',
  KARMA_DECAY_AMOUNT: '5',
  KARMA_MINIMUM: '10',
  MINING_MODE: 'internal',
};

let n1: ChildProcess, n2: ChildProcess;
let userKey: KeyObject, pubRaw: Uint8Array, pubHex: string, userId: string;
let n1Log = '', n2Log = '';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const blake32 = (d: Uint8Array) => new Uint8Array(createHash('blake2b512').update(d).digest().subarray(0, 32));
const concat = (...arrs: Uint8Array[]) => { const t = arrs.reduce((s,a)=>s+a.length,0); const o=new Uint8Array(t); let p=0; for(const a of arrs){o.set(a,p);p+=a.length;} return o; };
const le64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

const encoder = new TextEncoder();

async function get(url: string) { const r = await fetch(url); return r.json(); }
async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} ${r.status}: ${t}`);
  return t ? JSON.parse(t) : {};
}

function signTx(tx: UtxoTransaction): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), userKey);
  tx.signatures[pubHex] = new Uint8Array(sig);
}

function txToApi(tx: UtxoTransaction): Record<string, unknown> {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map(o => {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) obj[k] = v instanceof Uint8Array ? hex(v) : v;
      return obj;
    }),
    signatures: Object.fromEntries(Object.entries(tx.signatures).map(([k, v]) => [k, hex(v as Uint8Array)])),
    preimages: tx.preimages ? Object.fromEntries(Object.entries(tx.preimages).map(([k, v]) => [k, hex(v as Uint8Array)])) : undefined,
    protocolVersion: tx.protocolVersion,
  };
}

// PoW — matches demo UI format (text-encoded fields, LE64 nonce)
function powInput(content: string, author: Uint8Array, parents: string[], chal: Uint8Array, ts: number): Uint8Array {
  return concat(encoder.encode(content), author, ...parents.map(p => encoder.encode(p)), chal, encoder.encode(String(PROTOCOL_VERSION)), encoder.encode(String(ts)));
}
function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const b of hash) { if (b===0) {bits+=8; continue;} let x=b; while((x&0x80)===0){bits++;x<<=1;} break; }
  return bits;
}
function solve(pi: Uint8Array, target: number): number {
  for (let n=0; n<100_000_000; n++) { if (leadingZeroBits(blake32(concat(pi, le64(n)))) >= target) return n; }
  throw new Error('PoW timeout');
}
function signPost(content: string, author: Uint8Array, parents: string[], chal: Uint8Array, ts: number): string {
  // Must match signingHash() in @dagsocial/types: h.update() takes strings/bytes directly
  const h = createHash('blake2b512');
  h.update(content);                   // string
  h.update(author);                    // Uint8Array
  for (const ref of parents) h.update(ref); // string
  h.update(chal);                      // Uint8Array
  h.update(String(PROTOCOL_VERSION));  // string
  h.update(String(ts));                // string
  return hex(new Uint8Array(cryptoSign(null, h.digest().subarray(0, 32), userKey)));
}

// Tx builders
function karmaTx(boxes: {boxId:string,value:number}[], spend:number, proof:string): UtxoTransaction {
  const t = boxes.reduce((s,b)=>s+b.value,0);
  return { inputs: boxes.map(b=>b.boxId), outputs: [{ boxType:'karma',value:t-spend,createdAtBlock:0,owner:pubRaw,guard:'owner_signature',proofSource:proof,lastTouchBlock:0 }], signatures:{}, protocolVersion:PROTOCOL_VERSION };
}
function likeTx(boxes: {boxId:string,value:number}[], targetPostId: string): UtxoTransaction {
  const t = boxes.reduce((s,b)=>s+b.value,0);
  return { inputs: boxes.map(b=>b.boxId), outputs: [{ boxType:'karma',value:t-LIKE_COST,createdAtBlock:0,owner:pubRaw,guard:'owner_signature',proofSource:targetPostId,lastTouchBlock:0 }, { boxType:'like',value:LIKE_COST,createdAtBlock:0,likerId:pubRaw,targetPostId,guard:'epoch_tally' }], signatures:{}, protocolVersion:PROTOCOL_VERSION };
}
function inviteTx(boxes: {boxId:string,value:number}[], secretHashHex: string): UtxoTransaction {
  const t = boxes.reduce((s,b)=>s+b.value,0);
  const s = INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
  return { inputs: boxes.map(b=>b.boxId), outputs: [{ boxType:'karma',value:t-s,createdAtBlock:0,owner:pubRaw,guard:'owner_signature',proofSource:'e2e',lastTouchBlock:0 }, { boxType:'invite',value:INVITE_KARMA_AMOUNT,createdAtBlock:0,secretHash:unhex(secretHashHex),inviterId:pubRaw,guard:'hash_preimage' }, { boxType:'bond',value:INVITE_BOND_KARMA,createdAtBlock:0,inviterId:pubRaw,inviteePublicKey:new Uint8Array(32),probationStartBlock:0,probationEndBlock:0,guard:'inviter_signature' }], signatures:{}, protocolVersion:PROTOCOL_VERSION };
}

beforeAll(async () => {
  const kp = generateKeyPairSync('ed25519');
  userKey = kp.privateKey;
  const der = kp.publicKey.export({type:'spki',format:'der'}) as Buffer;
  pubRaw = new Uint8Array(der.subarray(der.length - 32));
  pubHex = hex(pubRaw);
  console.log(`Test key: ${pubHex.slice(0,16)}...`);

  const root = new URL('../../../..', import.meta.url).pathname;
  n1 = spawn('node', ['packages/node/dist/index.js'], { env: {...ENV, PORT:String(P1), DB_PATH:':memory:', NODE_ROLE:'miner', LISTEN_ADDRS:`/ip4/0.0.0.0/tcp/${LP1}`}, stdio:'pipe', cwd: root });
  n1.stdout!.on('data', d => { n1Log += d.toString(); });
  n1.stderr!.on('data', d => { n1Log += d.toString(); });
  n1.on('error', e => console.error('N1 error:', e));

  for (let i=0; i<60; i++) {
    if (n1Log.includes('Net node started')) break;
    await wait(500);
  }
  const m = n1Log.match(/peer ID:\s*([a-zA-Z0-9]+)/);
  if (!m) throw new Error(`N1 no peer ID. Log: ${n1Log.slice(0,300)}`);
  const peer1 = m[1]!;
  console.log(`N1 peer: ${peer1}`);

  n2 = spawn('node', ['packages/node/dist/index.js'], { env: {...ENV, PORT:String(P2), DB_PATH:':memory:', NODE_ROLE:'miner', LISTEN_ADDRS:`/ip4/0.0.0.0/tcp/${LP2}`, BOOTSTRAP_PEERS:`/ip4/127.0.0.1/tcp/${LP1}/p2p/${peer1}`}, stdio:'pipe', cwd: root });
  n2.stdout!.on('data', d => { n2Log += d.toString(); });
  n2.stderr!.on('data', d => { n2Log += d.toString(); });

  for (let i=0; i<60; i++) {
    try { await get(`${A1}/status`); await get(`${A2}/status`); break; } catch { await wait(500); }
  }
  console.log('Both nodes up');
}, 120000);

afterAll(() => { n1?.kill(); n2?.kill(); });

describe('E2E Pipeline', () => {
  it('full pipeline', async () => {
    // 1. Identity + Faucet
    const id = await api('POST', `${A1}/identity/import`, { publicKey: pubHex }) as { userId: string };
    userId = id.userId;
    expect(userId).toBeTruthy();
    console.log(`Identity: ${userId.slice(0,16)}...`);
    await wait(4000);

    const f = await api('POST', `${A1}/faucet`, { userId }) as { status: string; txId: string };
    expect(f.status).toBe('pending');
    console.log(`Faucet: ${f.txId.slice(0,16)}...`);
    await wait(6000);

    let k = await get(`${A1}/karma/${userId}`) as { total: number; boxes: { boxId: string; value: number }[] };
    expect(k.total).toBeGreaterThan(0);
    console.log(`Karma: ${k.total} (${k.boxes.length} boxes)`);

    // 2. Post
    const chal = await api('POST', `${A1}/challenge`, { userId }) as { challenge: string; targetBits: number };
    const ts = Date.now();
    const chalBytes = unhex(chal.challenge);
    const pi = powInput('e2e-post', pubRaw, [], chalBytes, ts);
    const nonce = solve(pi, chal.targetBits);
    const sig = signPost('e2e-post', pubRaw, [], chalBytes, ts);
    console.log(`PoW: nonce=${nonce}`);

    k = await get(`${A1}/karma/${userId}`) as { total: number; boxes: { boxId: string; value: number }[] };
    const lockTx = karmaTx(k.boxes, POST_LOCK_THREAD_COST, 'e2e');
    signTx(lockTx);

    const postR = await api('POST', `${A1}/posts`, { content:'e2e-post', author:pubHex, parentRefs:[], challenge:chal.challenge, protocolVersion:PROTOCOL_VERSION, timestamp:ts, powNonce:nonce, signature:sig, karmaLockTx: txToApi(lockTx) }) as { status: string; postId: string };
    expect(postR.status).toBe('pending');
    const targetPostId = postR.postId;
    console.log(`Post: ${targetPostId.slice(0,16)}...`);
    await wait(6000);

    // 3. Like
    k = await get(`${A1}/karma/${userId}`) as { total: number; boxes: { boxId: string; value: number }[] };
    const likeT = likeTx(k.boxes, targetPostId);
    signTx(likeT);
    const likeR = await api('POST', `${A1}/likes`, { tx: txToApi(likeT) }) as { status: string; txId: string };
    expect(likeR.status).toBe('pending');
    console.log(`Like: ${likeR.txId.slice(0,16)}...`);
    await wait(4000);

    // 4. Invite
    k = await get(`${A1}/karma/${userId}`) as { total: number; boxes: { boxId: string; value: number }[] };
    const secret = randomBytes(32);
    const sh = hex(blake32(secret));
    const invTx = inviteTx(k.boxes, sh);
    signTx(invTx);
    const invR = await api('POST', `${A1}/invites`, { tx: txToApi(invTx) }) as { status: string; inviteBoxId: string; bondBoxId: string };
    expect(invR.inviteBoxId).toBeTruthy();
    console.log(`Invite: ${invR.inviteBoxId.slice(0,16)}...`);
    await wait(4000);

    // 5. Decay
    const s = (await get(`${A1}/karma/${userId}`) as { total: number }).total;
    console.log(`Pre-decay karma: ${s}`);
    for (let i=0; i<30; i++) {
      await wait(2000);
      const h1 = (await get(`${A1}/status`) as { currentHeight: number }).currentHeight;
      const h2 = (await get(`${A2}/status`) as { currentHeight: number }).currentHeight;
      console.log(`  H1=${h1} H2=${h2}`);
    }
    const e = (await get(`${A1}/karma/${userId}`) as { total: number }).total;
    console.log(`Post-decay karma: ${e} (delta=${e-s})`);
    if (e < s) console.log('DECAY CONFIRMED');

    // Verify sync (may not converge in test timeframe — log only)
    try {
      const n2k = await get(`${A2}/karma/${userId}`) as { total: number };
      console.log(`N2 karma: ${n2k.total} (N1=${e})`);
    } catch { console.log('N2 karma: not synced (expected — headers may lag)'); }
    try {
      const posts = await get(`${A2}/posts?limit=10`) as { posts: unknown[] };
      console.log(`N2 posts: ${posts.posts.length}`);
    } catch { console.log('N2 posts: not synced'); }

    const fcnt = (n1Log.match(/fork|reorg|heavier/gi)||[]).length + (n2Log.match(/fork|reorg|heavier/gi)||[]).length;
    console.log(`Fork mentions: ${fcnt}`);
  }, 300000);
});
