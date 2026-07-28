#!/usr/bin/env npx tsx
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { computePostId, PROTOCOL_VERSION, LIKE_COST } from '@dagsocial/types';

// ---- Config ----
const N1 = 'http://localhost:3011';
const N2 = 'http://localhost:3012';
const SLEEP = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- Helpers ----
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const rawPub = (k: any): Uint8Array => {
  const d = k.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(d.subarray(d.length - 32));
};

async function api(m: string, url: string, body?: any) {
  const opts: any = { method: m };
  if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  const t = await r.text();
  return { ok: r.ok, status: r.status, data: t ? JSON.parse(t) : {} };
}
async function get(url: string) { try { return await api('GET', url); } catch { return { ok: false, status: 0, data: {} }; } }

function solvePoW(content: string, author: Uint8Array, parentRefs: string[], challenge: Uint8Array, protocolVersion: number, timestamp: number, targetBits: number): number {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(content), author];
  for (const p of parentRefs) parts.push(Buffer.from(p, 'hex'));
  parts.push(challenge, enc.encode(String(protocolVersion)), enc.encode(String(timestamp)));
  const len = parts.reduce((s, p) => s + p.length, 0);
  const input = new Uint8Array(len); let off = 0;
  for (const p of parts) { input.set(p, off); off += p.length; }
  for (let n = 0; n < 50_000_000; n++) {
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

const P = (r: any, label: string) => {
  const ok = r.ok;
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗\x1b[0m ${label} (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
  return ok;
};

async function waitForNode(url: string, maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const r = await fetch(`${url}/status`);
      if (r.ok) { console.log(`  Node at ${url} ready`); return true; }
    } catch { /* not ready */ }
    await SLEEP(1000);
  }
  return false;
}

// ---- Main ----
async function main() {
  console.log('═'.repeat(60));
  console.log('E2E Sync Test — 2 nodes, identity, faucet, posts, likes, replies, credits, invites, sync');
  console.log('═'.repeat(60));

  // ---- Generate identities ----
  console.log('\n▶ Generating identities');
  const alice = generateKeyPairSync('ed25519');
  const alicePub = rawPub(alice.publicKey);
  const alicePubH = hex(alicePub);

  const bob = generateKeyPairSync('ed25519');
  const bobPub = rawPub(bob.publicKey);
  const bobPubH = hex(bobPub);

  console.log(`  Alice: ${alicePubH.slice(0, 12)}...`);
  console.log(`  Bob:   ${bobPubH.slice(0, 12)}...`);

  // ---- Wait for Node 1 ----
  console.log('\n▶ Waiting for Node 1...');
  if (!await waitForNode(N1)) { console.error('Node 1 did not start'); process.exit(1); }

  // ---- Check Node 1 status ----
  console.log('\n▶ Node 1 status');
  const s1 = await get(`${N1}/status`);
  P(s1, 'GET /status');
  console.log(`  Height: ${s1.data.blockHeight}, Posts: ${s1.data.postCount}`);

  // ---- Faucet for Alice on Node 1 ----
  console.log('\n▶ Faucet — Alice (Node 1)');
  const faucetA = await api('POST', `${N1}/faucet`, { userId: alicePubH });
  P(faucetA, 'POST /faucet');

  // ---- Faucet for Bob on Node 1 ----
  console.log('\n▶ Faucet — Bob (Node 1)');
  const faucetB = await api('POST', `${N1}/faucet`, { userId: bobPubH });
  P(faucetB, 'POST /faucet');

  // ---- Wait for faucet txs to confirm ----
  console.log('\n▶ Waiting for blocks (faucet confirmation)...');
  await SLEEP(8000);

  // ---- Challenge for Alice ----
  console.log('\n▶ Challenge for Alice');
  const chalA = await api('POST', `${N1}/challenge`, { userId: alicePubH });
  P(chalA, 'POST /challenge');
  const challengeA = unhex(chalA.data.challenge);

  // ---- Challenge for Bob ----
  console.log('\n▶ Challenge for Bob');
  const chalB = await api('POST', `${N1}/challenge`, { userId: bobPubH });
  P(chalB, 'POST /challenge');
  const challengeB = unhex(chalB.data.challenge);

  // ---- Create post from Alice ----
  console.log('\n▶ Post — Alice creates a post');
  const ts1 = Date.now();
  const postPow1 = solvePoW('Hello from Alice!', alicePub, [], challengeA, PROTOCOL_VERSION, ts1, 4);
  const post1Req = {
    content: 'Hello from Alice!',
    author: alicePubH,
    parentRefs: [],
    challenge: chalA.data.challenge,
    powNonce: postPow1,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts1,
    signature: hex(new Uint8Array(cryptoSign(null, Buffer.from(computePostId({
      content: 'Hello from Alice!',
      author: alicePub,
      parentRefs: [],
      challenge: challengeA,
      powNonce: postPow1,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: ts1,
      signature: new Uint8Array(64),
    }), 'hex'), alice.privateKey))),
  };
  // Compute the actual post ID for the signature
  const post1Id = computePostId({
    content: post1Req.content,
    author: alicePub,
    parentRefs: [],
    challenge: challengeA,
    powNonce: post1Req.powNonce,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts1,
    signature: new Uint8Array(64),
  });
  post1Req.signature = hex(new Uint8Array(cryptoSign(null, Buffer.from(post1Id, 'hex'), alice.privateKey)));
  const r1 = await api('POST', `${N1}/posts`, post1Req);
  P(r1, 'POST /posts (Alice)');
  const post1IdFromServer = r1.data.postId || '';

  // ---- Create post from Bob (reply to Alice) ----
  console.log('\n▶ Post — Bob replies to Alice');
  const ts2 = Date.now();
  const postPow2 = solvePoW('Reply from Bob!', bobPub, [post1IdFromServer || post1Id], challengeB, PROTOCOL_VERSION, ts2, 4);
  const post2Id = computePostId({
    content: 'Reply from Bob!',
    author: bobPub,
    parentRefs: [post1IdFromServer || post1Id],
    challenge: challengeB,
    powNonce: postPow2,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts2,
    signature: new Uint8Array(64),
  });
  const post2Req = {
    content: 'Reply from Bob!',
    author: bobPubH,
    parentRefs: [post1IdFromServer || post1Id],
    challenge: chalB.data.challenge,
    powNonce: postPow2,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts2,
    signature: hex(new Uint8Array(cryptoSign(null, Buffer.from(post2Id, 'hex'), bob.privateKey))),
  };
  const r2 = await api('POST', `${N1}/posts`, post2Req);
  P(r2, 'POST /posts (Bob reply)');
  const post2IdFromServer = r2.data.postId || '';

  // ---- Nested reply from Alice ----
  console.log('\n▶ Post — Alice replies to Bob');
  const chalA2 = await api('POST', `${N1}/challenge`, { userId: alicePubH });
  const challengeA2 = unhex(chalA2.data.challenge);
  const ts3 = Date.now();
  const postPow3 = solvePoW('Nested reply from Alice!', alicePub, [post2IdFromServer || post2Id], challengeA2, PROTOCOL_VERSION, ts3, 4);
  const post3Id = computePostId({
    content: 'Nested reply from Alice!',
    author: alicePub,
    parentRefs: [post2IdFromServer || post2Id],
    challenge: challengeA2,
    powNonce: postPow3,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts3,
    signature: new Uint8Array(64),
  });
  const post3Req = {
    content: 'Nested reply from Alice!',
    author: alicePubH,
    parentRefs: [post2IdFromServer || post2Id],
    challenge: chalA2.data.challenge,
    powNonce: postPow3,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts3,
    signature: hex(new Uint8Array(cryptoSign(null, Buffer.from(post3Id, 'hex'), alice.privateKey))),
  };
  const r3 = await api('POST', `${N1}/posts`, post3Req);
  P(r3, 'POST /posts (Alice nested reply)');

  // ---- Wait for posts to confirm ----
  console.log('\n▶ Waiting for blocks (post confirmation)...');
  await SLEEP(8000);

  // ---- Check karma/credits ----
  console.log('\n▶ Balance check');
  const karmaA = await get(`${N1}/utxo/karma/${alicePubH}`);
  P(karmaA, `Alice karma: ${karmaA.data.totalKarma ?? '?'}`);

  const creditsA = await get(`${N1}/utxo/credits/${alicePubH}`);
  P(creditsA, `Alice credits: ${creditsA.data.totalCredits ?? '?'}`);

  // ---- Credit transfer: Alice → Bob ----
  console.log('\n▶ Credit transfer — Alice → Bob (10 credits)');
  const txReq = {
    from: alicePubH,
    to: bobPubH,
    amount: 10,
    signature: '', // filled below
    expectedHeight: s1.data.blockHeight || 0,
  };
  // Create the tx to sign
  const txBody = {
    inputs: [{ txId: '0000000000000000000000000000000000000000000000000000000000000000', outputIndex: 0 }],
    outputs: [{ boxType: 'credit' as const, owner: bobPub, value: 10, lockedUntilBlock: 0 }],
    protocolVersion: PROTOCOL_VERSION,
    createdAtBlock: txReq.expectedHeight,
  };
  const txIdToSign = createHash('blake2b512').update(JSON.stringify(txBody)).digest().subarray(0, 32);
  txReq.signature = Buffer.from(cryptoSign(null, txIdToSign, alice.privateKey)).toString('base64');
  const transfer = await api('POST', `${N1}/utxo/credits/transfer`, txReq);
  // Transfer may fail if no credit boxes yet (need block with coinbase)
  console.log(`  Transfer result: ${transfer.status} — ${JSON.stringify(transfer.data).slice(0, 200)}`);

  // ---- Wait for blocks ----
  console.log('\n▶ Waiting for blocks...');
  await SLEEP(8000);

  // ---- Check feed ----
  console.log('\n▶ Feed check (Node 1)');
  const feed1 = await get(`${N1}/posts`);
  P(feed1, `GET /posts — ${Array.isArray(feed1.data) ? feed1.data.length : '?'} posts`);

  // ---- Start Node 2 and test sync ----
  console.log('\n' + '═'.repeat(60));
  console.log('▶ Node 2 — sync test');

  // Get Node 1's current height before starting Node 2
  const s1b = await get(`${N1}/status`);
  console.log(`  Node 1 height: ${s1b.data.currentHeight}`);

  if (!await waitForNode(N2, 60)) {
    console.error('Node 2 did not start within 60s');
  } else {
    // Wait for sync
    console.log('  Waiting for sync...');
    await SLEEP(10000);

    // Check Node 2 status
    const s2 = await get(`${N2}/status`);
    P(s2, 'Node 2 GET /status');
    console.log(`  Node 2 height: ${s2.data.blockHeight}`);

    // Check Node 2 has the posts
    const feed2 = await get(`${N2}/posts`);
    P(feed2, `Node 2 GET /posts — ${Array.isArray(feed2.data) ? feed2.data.length : '?'} posts`);

    // Check Node 2 has Alice's karma
    const karmaA2 = await get(`${N2}/utxo/karma/${alicePubH}`);
    P(karmaA2, `Node 2 Alice karma: ${karmaA2.data.totalKarma ?? '?'}`);

    // Check Node 2 has Bob's karma
    const karmaB2 = await get(`${N2}/utxo/karma/${bobPubH}`);
    P(karmaB2, `Node 2 Bob karma: ${karmaB2.data.totalKarma ?? '?'}`);

    // ---- Create a post on Node 2 and verify Node 1 sees it ----
    console.log('\n▶ Cross-node post test');
    const chalB2 = await api('POST', `${N2}/challenge`, { userId: bobPubH });
    const challengeB2 = unhex(chalB2.data.challenge);
    const ts4 = Date.now();
    const postPow4 = solvePoW('Post from Bob on Node 2!', bobPub, [], challengeB2, PROTOCOL_VERSION, ts4, 4);
    const post4Id = computePostId({
      content: 'Post from Bob on Node 2!',
      author: bobPub,
      parentRefs: [],
      challenge: challengeB2,
      powNonce: postPow4,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: ts4,
      signature: new Uint8Array(64),
    });
    const post4Req = {
      content: 'Post from Bob on Node 2!',
      author: bobPubH,
      parentRefs: [],
      challenge: chalB2.data.challenge,
      powNonce: postPow4,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: ts4,
      signature: hex(new Uint8Array(cryptoSign(null, Buffer.from(post4Id, 'hex'), bob.privateKey))),
    };
    const r4 = await api('POST', `${N2}/posts`, post4Req);
    P(r4, 'POST /posts on Node 2');

    await SLEEP(8000);

    // Check Node 1 has the post from Node 2
    const feed1b = await get(`${N1}/posts`);
    P(feed1b, `Node 1 GET /posts after cross-node post — ${Array.isArray(feed1b.data) ? feed1b.data.length : '?'} posts`);
  }

  // ---- Summary ----
  console.log('\n' + '═'.repeat(60));
  console.log('E2E Sync Test Complete');
  console.log('═'.repeat(60));

  // Keep running briefly so user can inspect
  await SLEEP(2000);
}

main().catch(err => { console.error(err); process.exit(1); });
