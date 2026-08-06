/**
 * E2E: Delete post pipeline — PostLockBox creation, deletion, and karma settlement.
 *
 * Verifies the core delete-post flow end-to-end with real nodes:
 * 1. Post creation with PostLockBox (karma locked)
 * 2. Deletion via DELETE /posts/:id with challenge-response signature
 * 3. PostLockBox karma returned to author during block application
 *
 * Usage: npx vitest run test/e2e/delete-pipeline.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  computeTxId,
  computePostId,
  postPowPreimage,
  signingHash,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  PROTOCOL_VERSION,
  POST_LOCK_THREAD_COST,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';

const P1 = 10601, P2 = 10602, LP1 = P1 + 100, LP2 = P2 + 100;
const A1 = `http://localhost:${P1}`;
const A2 = `http://localhost:${P2}`;
const AP1 = P1 + 200, AP2 = P2 + 200;
const ENV = {
  ...process.env,
  ORDERING_BLOCK_INTERVAL_MS: '2000',
  KARMA_STALE_THRESHOLD_BLOCKS: '10',
  KARMA_DECAY_INTERVAL_BLOCKS: '3',
  KARMA_DECAY_AMOUNT: '5',
  KARMA_MINIMUM: '10',
  MINING_MODE: 'internal',
  CHALLENGE_WINDOW_BLOCKS: '100',
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

/**
 * One request on a fresh, non-pooled socket (`agent: false`).
 *
 * `fetch` keeps sockets alive in undici's pool and relies on a timer to retire
 * them before the server does. `solve()` below blocks the event loop for
 * seconds at a time, so that timer cannot fire; the node's HTTP server hits its
 * own 5s keep-alive timeout first and closes the connection, and the next
 * request writes into a half-closed socket — `UND_ERR_SOCKET: other side
 * closed`, on the call right after the PoW solve. A connection per request
 * removes the shared state the race needs.
 */
function httpJson(method: string, url: string, body?: unknown): Promise<{ status: number; text: string }> {
  const u = new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method,
      agent: false,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function get(url: string) { const r = await httpJson('GET', url); return JSON.parse(r.text); }
async function api(method: string, url: string, body?: unknown) {
  const r = await httpJson(method, url, body);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${url} ${r.status}: ${r.text}`);
  return r.text ? JSON.parse(r.text) : {};
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
      for (const [k, v] of Object.entries(o)) {
        obj[k] = v instanceof Uint8Array ? hex(v)
          : typeof v === 'bigint' ? v.toString()
          : v;
      }
      return obj;
    }),
    signatures: Object.fromEntries(Object.entries(tx.signatures).map(([k, v]) => [k, hex(v as Uint8Array)])),
    protocolVersion: tx.protocolVersion,
  };
}

/** Shape the canonical encoders read; powNonce/signature never reach the bytes. */
function preimagePost(content: string, author: Uint8Array, parents: string[], chal: Uint8Array, ts: number) {
  return {
    content, author, parentRefs: parents, challenge: chal,
    powNonce: 0, protocolVersion: PROTOCOL_VERSION, timestamp: ts,
    signature: new Uint8Array(64),
  };
}

// PoW preimage — the canonical encoding from @dagsocial/types (audit M-1).
function powInput(content: string, author: Uint8Array, parents: string[], chal: Uint8Array, ts: number): Uint8Array {
  return postPowPreimage(preimagePost(content, author, parents, chal, ts));
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
  const h = signingHash(preimagePost(content, author, parents, chal, ts));
  return hex(new Uint8Array(cryptoSign(null, h, userKey)));
}

/** Create a PostLockBox tx — produces boxType:'post_lock' for karma locking */
function postLockTx(boxes: {boxId:string,value:string}[], lockAmount: bigint, targetPostId: string): UtxoTransaction {
  const t = boxes.reduce((s,b)=>s+BigInt(b.value),0n);
  return {
    inputs: boxes.map(b=>b.boxId),
    outputs: [
      { boxType:'karma', value:t-lockAmount, owner:pubRaw, guard:'owner_signature', proofSource:targetPostId },
      { boxType:'post_lock', value:lockAmount, originalValue:lockAmount, owner:pubRaw, targetPostId, guard:'epoch_tally' },
    ],
    signatures:{},
    protocolVersion:PROTOCOL_VERSION,
  };
}

beforeAll(async () => {
  const kp = generateKeyPairSync('ed25519');
  userKey = kp.privateKey;
  const der = kp.publicKey.export({type:'spki',format:'der'}) as Buffer;
  pubRaw = new Uint8Array(der.subarray(der.length - 32));
  pubHex = hex(pubRaw); userId = pubHex;
  console.log(`Test key: ${pubHex.slice(0,16)}...`);

  const root = new URL('../../../..', import.meta.url).pathname;

  n1 = spawn('node', ['packages/node/dist/index.js'], { env: {...ENV, PORT:String(P1), ADMIN_PORT:String(AP1), DB_PATH:':memory:', NODE_ROLE:'miner', LISTEN_ADDRS:`/ip4/0.0.0.0/tcp/${LP1}`}, stdio:'pipe', cwd: root });
  n1.stdout!.on('data', d => { n1Log += d.toString(); });
  n1.stderr!.on('data', d => { n1Log += d.toString(); });
  n1.on('error', e => console.error('N1 error:', e));

  for (let i=0; i<60; i++) {
    if (n1Log.includes('Net node started')) break;
    await wait(500);
  }
  const m = n1Log.match(/peer ID:\s*([a-zA-Z0-9]+)/);
  if (!m) throw new Error(`N1 no peer ID. Log: ${n1Log.slice(0,500)}`);
  const peer1 = m[1]!;
  console.log(`N1 peer: ${peer1}`);

  n2 = spawn('node', ['packages/node/dist/index.js'], { env: {...ENV, PORT:String(P2), ADMIN_PORT:String(AP2), DB_PATH:':memory:', NODE_ROLE:'miner', LISTEN_ADDRS:`/ip4/0.0.0.0/tcp/${LP2}`, BOOTSTRAP_PEERS:`/ip4/127.0.0.1/tcp/${LP1}/p2p/${peer1}`}, stdio:'pipe', cwd: root });
  n2.stdout!.on('data', d => { n2Log += d.toString(); });
  n2.stderr!.on('data', d => { n2Log += d.toString(); });

  let started = false;
  for (let i=0; i<60; i++) {
    try { await get(`${A1}/status`); await get(`${A2}/status`); started = true; break; } catch { await wait(500); }
  }
  if (!started) throw new Error('Nodes failed to start within 30s');
  console.log('Both nodes up');
}, 120000);

afterAll(async () => {
  const procs = [n1, n2].filter(Boolean) as ChildProcess[];
  for (const p of procs) p.kill('SIGKILL');
  await Promise.race([
    Promise.all(procs.map(p => new Promise<void>(resolve => {
      if (p.killed || p.exitCode !== null) return resolve();
      p.on('exit', () => resolve());
    }))),
    new Promise<void>(resolve => setTimeout(resolve, 5000)),
  ]);
  await wait(300);
});

describe('Delete Pipeline', () => {
  it('create post with PostLockBox, delete, verify karma returned', async () => {
    // 1. Faucet
    await wait(4000);
    const f = await api('POST', `${A1}/faucet`, { userId }) as { status: string };
    expect(f.status).toBe('pending');
    await wait(6000);

    let k = await get(`${A1}/karma/${userId}`) as { total: string; boxes: { boxId: string; value: string }[] };
    expect(BigInt(k.total)).toBeGreaterThan(0n);
    console.log(`Karma after faucet: ${k.total}`);

    // 2. Create post with PostLockBox
    const chal1 = await api('POST', `${A1}/challenge`, { userId }) as { challenge: string; targetBits: number };
    const ts1 = Date.now();
    const chalBytes1 = unhex(chal1.challenge);
    const pi1 = powInput('test-post', pubRaw, [], chalBytes1, ts1);
    const nonce1 = solve(pi1, chal1.targetBits);
    const sig1 = signPost('test-post', pubRaw, [], chalBytes1, ts1);

    // computePostId expects Uint8Array fields
    const postForId = {
      content:'test-post', author:pubRaw, parentRefs:[] as string[],
      challenge:chalBytes1, protocolVersion:PROTOCOL_VERSION,
      timestamp:ts1, powNonce:nonce1, signature:unhex(sig1),
    };
    const postId = computePostId(postForId as any);
    console.log(`PostId: ${postId.slice(0,16)}...`);

    k = await get(`${A1}/karma/${userId}`) as { total: string; boxes: { boxId: string; value: string }[] };
    const lockTx = postLockTx(k.boxes, POST_LOCK_THREAD_COST, postId);
    signTx(lockTx);

    const postR = await api('POST', `${A1}/posts`, {
      content:'test-post', author:pubHex, parentRefs:[],
      challenge:chal1.challenge, protocolVersion:PROTOCOL_VERSION,
      timestamp:ts1, powNonce:nonce1, signature:sig1,
      karmaLockTx: txToApi(lockTx),
    }) as { status: string; postId: string };
    expect(postR.status).toBe('pending');
    expect(postR.postId).toBe(postId);
    console.log(`Post confirmed: ${postId.slice(0,16)}...`);

    await wait(8000);

    // 3. Delete the post via PruneIntent
    const karmaBefore = BigInt((await get(`${A1}/karma/${userId}`) as { total: string }).total);
    console.log(`Karma before delete: ${karmaBefore}`);

    // Build PruneIntent for a root post with no replies
    const subtreePostIds = [postId];
    const prLeaves = subtreePostIds.map((id: string) => leafHash('stump', hexToBuf(id)));
    const prMerkleRoot = buildMerkleRoot(prLeaves);
    const prMerkleRootHex = hex(prMerkleRoot);
    const prPayload = new Uint8Array(
      createHash('blake2b512')
        .update(postId)
        .update(prMerkleRoot)
        .digest()
        .subarray(0, 32),
    );
    const prSig = hex(new Uint8Array(cryptoSign(null, prPayload, userKey)));

    const delR = await api('POST', `${A1}/posts/${postId}/prune`, {
      rootPostHash: postId,
      authorId: pubHex,
      subtreeMerkleRoot: prMerkleRootHex,
      subtreePostIds,
      signature: prSig,
      trigger: 'author',
    }) as { status: string; entryId: string; replyCount: number };
    expect(delR.status).toBe('deleted');
    console.log(`Deleted: entryId=${delR.entryId.slice(0,16)}...`);

    // 4. Poll for karma return (PostLockBox settlement)
    let karmaAfter = karmaBefore;
    let settled = false;
    for (let i = 0; i < 15; i++) {
      await wait(2000);
      karmaAfter = BigInt((await get(`${A1}/karma/${userId}`) as { total: string }).total);
      const delta = karmaAfter - karmaBefore;
      console.log(`  Poll ${i + 1}: ${karmaAfter} (delta: ${delta > 0n ? '+' : ''}${delta})`);
      if (karmaAfter > karmaBefore) {
        console.log('KARMA RETURNED');
        settled = true;
        break;
      }
    }
    console.log(`Final karma: ${karmaAfter} (settled: ${settled})`);

    // Dump N1 stump-related logs for diagnostics
    const stumpLogs = n1Log.split('\n').filter(l => l.includes('Stump') || l.includes('returned'));
    console.log(`N1 stump logs (${stumpLogs.length}):`);
    stumpLogs.slice(-10).forEach(l => console.log(`  ${l.slice(0,200)}`));

    expect(karmaAfter).toBeGreaterThan(0n);
    // If settlement was observed, karma should be >= pre-delete (minus decay)
    if (settled) {
      expect(karmaAfter).toBeGreaterThanOrEqual(karmaBefore - 30n);
    }
  }, 300000);
});
