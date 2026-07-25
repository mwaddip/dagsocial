#!/usr/bin/env node

/**
 * DAGsocial miner — polls /mining/template, solves PoW, submits /mining/submit.
 *
 * Usage:
 *   node scripts/miner.js
 *
 * Env vars:
 *   NODE_URL     — node HTTP URL (default http://localhost:3000)
 *   THROTTLE_MS  — sleep between hashing batches (default 0 = full speed)
 *   COOLDOWN_MS  — sleep after solving a block before fetching next template
 *                  (default 45000 = 45s, set 0 to disable)
 *   LOG_EVERY    — log progress every N hashes (default 100000)
 */

import { createHash } from 'crypto';

const NODE_URL = process.env.NODE_URL ?? 'http://localhost:3000';
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS ?? '0', 10);
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS ?? '45000', 10);
const LOG_EVERY = parseInt(process.env.LOG_EVERY ?? '100000', 10);

// ---------------------------------------------------------------------------
// PoW
// ---------------------------------------------------------------------------

function encodeLE64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function solvePoW(powPreimageHex, targetBits) {
  const powPreimage = Buffer.from(powPreimageHex, 'hex');
  let nonce = 0;
  const start = performance.now();

  while (true) {
    const nonceBuf = encodeLE64(nonce);
    const hash = createHash('blake2b512')
      .update(powPreimage)
      .update(nonceBuf)
      .digest()
      .subarray(0, 32);

    // Count leading zero bits
    let bits = 0;
    for (let i = 0; i < 32 && bits < targetBits; i++) {
      if (hash[i] === 0) { bits += 8; continue; }
      let mask = 0x80;
      while ((hash[i] & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
      break;
    }

    if (bits >= targetBits) {
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      const rate = (nonce / (performance.now() - start) * 1000).toFixed(0);
      return { nonce, elapsed, rate };
    }

    nonce++;

    if (nonce % LOG_EVERY === 0) {
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      const rate = (nonce / (performance.now() - start) * 1000).toFixed(0);
      process.stderr.write(`  ${(nonce / 1e6).toFixed(1)}M hashes (${elapsed}s, ${rate} H/s)...\r`);
    }

    if (THROTTLE_MS > 0 && nonce % 10000 === 0) {
      // Throttle CPU usage by yielding every 10K hashes
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, THROTTLE_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastHeight = 0;

while (true) {
  try {
    const tplRes = await fetch(`${NODE_URL}/mining/template`);
    if (!tplRes.ok) {
      const err = await tplRes.json().catch(() => ({}));
      process.stderr.write(`Template error: ${err.error || tplRes.status}\n`);
      await sleep(2000);
      continue;
    }

    const tpl = await tplRes.json();

    // Skip if we already mined this height
    if (tpl.height <= lastHeight) {
      await sleep(500);
      continue;
    }

    console.log(`\n[height=${tpl.height}] Mining with targetBits=${tpl.powTargetBits}...`);
    console.log(`  powPreimage: ${tpl.powPreimage.slice(0, 24)}...`);

    const { nonce, elapsed, rate } = solvePoW(tpl.powPreimage, tpl.powTargetBits);
    console.log(`  Found nonce=${nonce} in ${elapsed}s (${rate} H/s)`);

    // Submit
    const submitRes = await fetch(`${NODE_URL}/mining/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ powNonce: nonce, height: tpl.height }),
    });

    if (submitRes.ok) {
      const result = await submitRes.json();
      console.log(`  ✓ Block ${result.height} mined: ${result.blockHash.slice(0, 16)}...`);
      lastHeight = result.height;
      if (COOLDOWN_MS > 0) {
        console.log(`  Cooling down ${(COOLDOWN_MS / 1000).toFixed(0)}s...`);
        await sleep(COOLDOWN_MS);
      }
    } else {
      const err = await submitRes.json().catch(() => ({}));
      console.log(`  ✗ Submit failed: ${err.error || submitRes.status}`);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    await sleep(2000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
