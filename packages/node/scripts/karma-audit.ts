/**
 * Karma audit: creates identities, posts, likes, and tracks karma balances
 * step by step to detect inflation.
 *
 * Usage: npx tsx packages/node/scripts/karma-audit.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, createHash, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  computeTxId,
  PROTOCOL_VERSION,
  LIKE_COST,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
import type { UtxoTransaction, KarmaBox, LikeBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const P1 = 10401, P2 = 10402, LP1 = P1 + 100, LP2 = P2 + 100;
const A1 = `http://localhost:${P1}`;
const ENV = {
  ...process.env,
  PORT: String(P1),
  DB_PATH: ':memory:',
  NODE_ROLE: 'miner',
  MINING_MODE: 'internal',
  LISTEN_ADDRS: `/ip4/0.0.0.0/tcp/${LP1}`,
  ORDERING_BLOCK_INTERVAL_MS: '10000',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const encoder = new TextEncoder();

async function get(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} ${r.status}`);
  return r.json();
}
async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${url} ${r.status}: ${t}`);
  return t ? JSON.parse(t) : {};
}

/** Derive raw 32-byte public key from SPKI DER. */
function rawPublicKey(pub: KeyObject): Uint8Array {
  const der = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** PoW solver (same algorithm as demo UI). */
function blake32(d: Uint8Array) {
  return new Uint8Array(
    createHash('blake2b512').update(d).digest().subarray(0, 32),
  );
}
function concat(...arrs: Uint8Array[]) {
  const t = arrs.reduce((s, a) => s + a.length, 0);
  const o = new Uint8Array(t);
  let p = 0;
  for (const a of arrs) { o.set(a, p); p += a.length; }
  return o;
}
function le64(n: number) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}
function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const b of hash) {
    if (b === 0) { bits += 8; continue; }
    let x = b;
    while ((x & 0x80) === 0) { bits++; x <<= 1; }
    break;
  }
  return bits;
}
function solve(pi: Uint8Array, target: number): number {
  for (let n = 0; n < 100_000_000; n++) {
    if (leadingZeroBits(blake32(concat(pi, le64(n)))) >= target) return n;
  }
  throw new Error('PoW timeout');
}
function powInput(content: string, author: Uint8Array, parents: string[], chal: Uint8Array, ts: number): Uint8Array {
  return concat(encoder.encode(content), author, ...parents.map(p => encoder.encode(p)), chal, encoder.encode(String(PROTOCOL_VERSION)), encoder.encode(String(ts)));
}
function signPost(content: string, author: Uint8Array, parents: string[], chal: Uint8Array, ts: number, key: KeyObject): string {
  const h = createHash('blake2b512');
  h.update(content);
  h.update(author);
  for (const ref of parents) h.update(ref);
  h.update(chal);
  h.update(String(PROTOCOL_VERSION));
  h.update(String(ts));
  return hex(new Uint8Array(cryptoSign(null, h.digest().subarray(0, 32), key)));
}

/** Build a karma-lock tx for post creation. */
function karmaLockTx(karmaBoxes: { boxId: string; value: number }[], lockAmount: number, proofSource: string, pubRaw: Uint8Array): UtxoTransaction {
  let selectedTotal = 0;
  const selected: typeof karmaBoxes = [];
  for (const b of karmaBoxes) {
    selected.push(b);
    selectedTotal += b.value;
    if (selectedTotal >= lockAmount) break;
  }
  const change = selectedTotal - lockAmount;
  const outputs: any[] = [];
  if (change > 0) {
    outputs.push({
      boxType: 'karma',
      value: change,
      createdAtBlock: 0,
      owner: pubRaw,
      guard: 'owner_signature',
      proofSource,
      lastTouchBlock: 0,
    });
  }
  outputs.push({
    boxType: 'post_lock',
    value: lockAmount,
    originalValue: lockAmount,
    createdAtBlock: 0,
    owner: pubRaw,
    targetPostId: '', // filled in by server
    guard: 'epoch_tally',
  });
  return {
    inputs: selected.map(b => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

function likeTx(karmaBoxes: { boxId: string; value: number }[], targetPostId: string, pubRaw: Uint8Array): UtxoTransaction {
  let selectedTotal = 0;
  const selected: typeof karmaBoxes = [];
  for (const b of karmaBoxes) {
    selected.push(b);
    selectedTotal += b.value;
    if (selectedTotal >= LIKE_COST) break;
  }
  const change = selectedTotal - LIKE_COST;
  const outputs: any[] = [{
    boxType: 'karma',
    value: change,
    createdAtBlock: 0,
    owner: pubRaw,
    guard: 'owner_signature',
    proofSource: targetPostId,
    lastTouchBlock: 0,
  }, {
    boxType: 'like',
    value: LIKE_COST,
    createdAtBlock: 0,
    likerId: pubRaw,
    targetPostId,
    guard: 'epoch_tally',
  }];
  return {
    inputs: selected.map(b => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

function signTx(tx: UtxoTransaction, key: KeyObject, pubHex: string): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), key);
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

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
interface Identity {
  name: string;
  key: KeyObject;
  pub: Uint8Array;
  pubHex: string;
}

function makeIdentity(name: string): Identity {
  const kp = generateKeyPairSync('ed25519');
  return {
    name,
    key: kp.privateKey,
    pub: rawPublicKey(kp.publicKey),
    pubHex: hex(rawPublicKey(kp.publicKey)),
  };
}

// ---------------------------------------------------------------------------
// Karma tracker
// ---------------------------------------------------------------------------
interface Snapshot {
  timestamp: number;
  blockHeight: number;
  identities: Record<string, { karma: number; credits: number; boxes: number }>;
}

const snapshots: Snapshot[] = [];

async function snapshot(identities: Identity[], label: string): Promise<void> {
  const status = await get(`${A1}/status`) as { blockHeight: number };
  const h = status.blockHeight;
  const snap: Snapshot = { timestamp: Date.now(), blockHeight: h, identities: {} };

  for (const id of identities) {
    try {
      const k = await get(`${A1}/karma/${id.pubHex}`) as { total: number; boxes: { boxId: string; value: number }[] };
      snap.identities[id.name] = { karma: k.total, credits: 0, boxes: k.boxes.length };
    } catch {
      snap.identities[id.name] = { karma: 0, credits: 0, boxes: 0 };
    }
  }

  snapshots.push(snap);
  const parts = snap.identities;
  console.log(
    `[${label}] h=${h} | ` +
    Object.entries(parts).map(([n, s]) => `${n}:${s.karma} (${s.boxes}b)`).join(' | '),
  );
}

// ---------------------------------------------------------------------------
// Post creation
// ---------------------------------------------------------------------------
async function createPost(
  identity: Identity,
  content: string,
  parentRefs: string[],
  lockAmount: number,
  proofSource: string,
): Promise<string> {
  const chal = await post(`${A1}/challenge`, { userId: identity.pubHex }) as {
    challenge: string;
    targetBits: number;
  };
  const ts = Date.now();
  const chalBytes = unhex(chal.challenge);
  const pi = powInput(content, identity.pub, parentRefs, chalBytes, ts);
  const nonce = solve(pi, chal.targetBits);
  const sig = signPost(content, identity.pub, parentRefs, chalBytes, ts, identity.key);

  const k = await get(`${A1}/karma/${identity.pubHex}`) as { boxes: { boxId: string; value: number }[] };
  const lockTx = karmaLockTx(k.boxes, lockAmount, proofSource, identity.pub);
  signTx(lockTx, identity.key, identity.pubHex);

  const r = await post(`${A1}/posts`, {
    content,
    author: identity.pubHex,
    parentRefs,
    challenge: chal.challenge,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts,
    powNonce: nonce,
    signature: sig,
    karmaLockTx: txToApi(lockTx),
  }) as { status: string; postId: string };
  return r.postId;
}

// ---------------------------------------------------------------------------
// Like
// ---------------------------------------------------------------------------
async function castLike(identity: Identity, targetPostId: string): Promise<string> {
  const k = await get(`${A1}/karma/${identity.pubHex}`) as { boxes: { boxId: string; value: number }[] };
  const tx = likeTx(k.boxes, targetPostId, identity.pub);
  signTx(tx, identity.key, identity.pubHex);
  const r = await post(`${A1}/likes`, { tx: txToApi(tx) }) as { status: string; txId?: string; likeId?: string };
  return r.txId ?? r.likeId ?? '';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== KARMA AUDIT ===\n');

  // 1. Start node
  const root = process.cwd();
  console.log(`Starting node on :${P1} (cwd: ${root})...`);
  const n1 = spawn('node', ['packages/node/dist/index.js'], {
    env: ENV,
    stdio: 'pipe',
    cwd: root,
  });
  n1.stderr!.on('data', d => process.stderr.write(d));
  n1.on('error', e => { console.error('Node error:', e); process.exit(1); });

  let n1Log = '';
  n1.stdout!.on('data', d => { n1Log += d.toString(); });

  for (let i = 0; i < 120; i++) {
    try { await get(`${A1}/status`); break; } catch { await wait(500); }
  }
  console.log('Node ready.\n');

  // 2. Create identities
  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');
  const carol = makeIdentity('Carol');
  const identities = [alice, bob, carol];

  await snapshot(identities, 'initial');

  // 3. Faucet each identity (one at a time — block creator applies each in separate blocks)
  for (const id of identities) {
    const f = await post(`${A1}/faucet`, { userId: id.pubHex }) as { status: string };
    console.log(`  Faucet ${id.name}: ${f.status}`);
    await wait(12000); // wait for confirmation before next faucet
  }
  await snapshot(identities, 'after-faucet');

  // 4. Posts
  console.log('\n--- Creating posts ---');
  const alicePost1 = await createPost(alice, 'Alice thread 1', [], POST_LOCK_THREAD_COST, 'audit');
  // 4. Posts (one at a time with long waits to avoid mempool batching)
  console.log('\n--- Creating posts ---');
  const alicePost1 = await createPost(alice, 'Alice thread 1', [], POST_LOCK_THREAD_COST, 'audit');
  console.log(`  Alice thread: ${alicePost1.slice(0, 16)}...`);
  await wait(12000);
  const bobPost1 = await createPost(bob, 'Bob thread 1', [], POST_LOCK_THREAD_COST, 'audit');
  console.log(`  Bob thread: ${bobPost1.slice(0, 16)}...`);
  await wait(12000);
  const carolPost1 = await createPost(carol, 'Carol thread 1', [], POST_LOCK_THREAD_COST, 'audit');
  console.log(`  Carol thread: ${carolPost1.slice(0, 16)}...`);
  await wait(12000);
  await snapshot(identities, 'after-3-posts');

  // 5. Replies
  console.log('\n--- Creating replies ---');
  const aliceReply1 = await createPost(alice, 'Reply to Bob', [bobPost1], POST_LOCK_REPLY_COST, 'audit');
  console.log(`  Alice→Bob: ${aliceReply1.slice(0, 16)}...`);
  await wait(12000);
  const bobReply1 = await createPost(bob, 'Reply to Alice', [alicePost1], POST_LOCK_REPLY_COST, 'audit');
  console.log(`  Bob→Alice: ${bobReply1.slice(0, 16)}...`);
  await wait(12000);
  const carolReply1 = await createPost(carol, 'Reply to Alice', [alicePost1], POST_LOCK_REPLY_COST, 'audit');
  console.log(`  Carol→Alice: ${carolReply1.slice(0, 16)}...`);
  await wait(12000);
  await snapshot(identities, 'after-3-replies');

  // 6. Nested reply
  console.log('\n--- Creating nested reply ---');
  const aliceNested1 = await createPost(alice, 'Nested reply', [aliceReply1], POST_LOCK_REPLY_COST, 'audit');
  console.log(`  Alice nested: ${aliceNested1.slice(0, 16)}...`);
  await wait(12000);
  await snapshot(identities, 'after-nested');

  // 7. Likes
  console.log('\n--- Casting likes ---');
  await castLike(alice, bobPost1); console.log('  Alice→Bob post');
  await wait(12000);
  await castLike(bob, alicePost1); console.log('  Bob→Alice post');
  await wait(12000);
  await castLike(carol, alicePost1); console.log('  Carol→Alice post');
  await wait(12000);
  await castLike(alice, carolPost1); console.log('  Alice→Carol post');
  await wait(12000);
  await castLike(bob, carolPost1); console.log('  Bob→Carol post');
  await wait(12000);
  await snapshot(identities, 'after-5-likes');

  // 8. More likes
  console.log('\n--- More likes ---');
  await castLike(carol, bobPost1); console.log('  Carol→Bob post');
  await wait(12000);
  await castLike(bob, aliceReply1); console.log('  Bob→Alice reply');
  await wait(12000);
  await snapshot(identities, 'after-7-likes');

  // 9. Idle monitoring
  console.log('\n--- Idle monitoring (2 min, snapshots every 15s) ---');
  const startTime = Date.now();
  const durationMs = 2 * 60 * 1000;
  let tick = 0;
  while (Date.now() - startTime < durationMs) {
    await wait(15000);
    tick++;
    await snapshot(identities, `idle-${tick * 15}s`);
  }

  // 10. Final snapshot
  await snapshot(identities, 'final');

  // 11. Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Total snapshots: ${snapshots.length}`);
  console.log(`Final height: ${snapshots[snapshots.length - 1]!.blockHeight}`);

  for (const id of identities) {
    const first = snapshots[0]!.identities[id.name]!;
    const last = snapshots[snapshots.length - 1]!.identities[id.name]!;
    console.log(
      `${id.name}: ${first.karma} → ${last.karma} ` +
      `(delta=${last.karma - first.karma}, ` +
      `${last.karma > first.karma + 100 ? '⚠️ INFLATED' : '✓'})`,
    );
  }

  // 12. Dump full timeline
  console.log('\n=== FULL TIMELINE ===');
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).toISOString().slice(11, 19);
    const parts = Object.entries(s.identities)
      .map(([n, st]) => `${n}:${st.karma}`)
      .join(' ');
    console.log(`  ${ts} h=${s.blockHeight} ${parts}`);
  }

  n1.kill();
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
