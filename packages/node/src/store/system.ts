import { createPrivateKey, sign } from 'crypto';
import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox, CreditBox } from '@dagsocial/types';
import { getDb } from './db.js';
import { insertBox, getKarmaBox, getCreditBoxes } from './utxo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemKeypair {
  publicKey: Uint8Array;   // 32 raw bytes
  secretKey: Uint8Array;   // PKCS8 DER
}

// ---------------------------------------------------------------------------
// Keypair persistence
// ---------------------------------------------------------------------------

const SYSTEM_KEYPAIR_KEY = 'system_keypair';

/**
 * Retrieve the persistent system keypair. Returns null if not yet initialized.
 */
export function getSystemKeypair(): SystemKeypair | null {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .get(SYSTEM_KEYPAIR_KEY) as { value: Buffer } | undefined;
  if (!row) return null;

  // Value layout: first 32 bytes = publicKey, rest = secretKey (PKCS8 DER)
  const buf = row.value;
  const publicKey = new Uint8Array(buf.subarray(0, 32));
  const secretKey = new Uint8Array(buf.subarray(32));
  return { publicKey, secretKey };
}

// Deterministic system keypair derived from blake2b-256("dagsocial-testnet-system-v1").
// All testnet nodes share this identity so that system box IDs match and
// faucet/invite signatures are verifiable by every peer.
//
// Pre-computed rather than derived at runtime to avoid Node.js version
// differences in PKCS8 JWK export across vitest worker threads.
const SYSTEM_PUBKEY_HEX = '5468d985c3924a95f3d3dc98b67a41ac2c7cc4cfca4fcbf7c5627452f1617f36';
const SYSTEM_PKCS8_HEX = '302e020100300506032b6570042204204504541a393fe199a143e47fbf10cb32ef7ef349eecd2f0997a310487b03abf4';

/**
 * Return the deterministic system keypair. Idempotent — returns the
 * stored keypair if already persisted, otherwise derives and persists
 * the hardcoded deterministic identity.
 */
export function initSystemKeypair(): SystemKeypair {
  const existing = getSystemKeypair();
  if (existing) return existing;

  const pubBytes = new Uint8Array(Buffer.from(SYSTEM_PUBKEY_HEX, 'hex'));
  const privBytes = new Uint8Array(Buffer.from(SYSTEM_PKCS8_HEX, 'hex'));

  // Persist: publicKey (32 raw bytes) || secretKey (PKCS8 DER).
  const db = getDb();
  db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run(
    SYSTEM_KEYPAIR_KEY,
    Buffer.concat([Buffer.from(pubBytes), Buffer.from(privBytes)]),
  );

  return { publicKey: pubBytes, secretKey: privBytes };
}

// ---------------------------------------------------------------------------
// System karma box
// ---------------------------------------------------------------------------

const SYSTEM_KARMA_INITIAL = 50_000;

/**
 * Ensure the system karma box exists with the initial balance.
 * Idempotent — if a system karma box already exists, returns it without creating.
 */
export function ensureSystemKarmaBox(systemPubKey: Uint8Array, currentHeight: number): KarmaBox {
  const existing = getKarmaBox(systemPubKey);
  if (existing) return existing;

  const box: KarmaBox = {
    boxType: 'karma',
    value: SYSTEM_KARMA_INITIAL,
    createdAtBlock: currentHeight > 0 ? currentHeight : 1,
    owner: systemPubKey,
    guard: 'owner_signature',
    proofSource: 'genesis:system',
    lastTouchBlock: currentHeight > 0 ? currentHeight : 1,
  };
  box.id = computeBoxId(box);
  insertBox(box);
  return box;
}

// ---------------------------------------------------------------------------
// System credit box (faucet)
// ---------------------------------------------------------------------------

const FAUCET_CREDITS_INITIAL = 100_000;

/**
 * Ensure the system keypair has a credit box with FAUCET_CREDITS_INITIAL
 * credits for the testnet faucet. Idempotent — if the system already has
 * unspent credit boxes, does nothing.
 */
export function ensureFaucetCreditBox(
  systemPubKey: Uint8Array,
  currentHeight: number,
): void {
  const existing = getCreditBoxes(systemPubKey);
  if (existing.length > 0) return;

  const box: CreditBox = {
    boxType: 'credit',
    value: FAUCET_CREDITS_INITIAL,
    createdAtBlock: currentHeight > 0 ? currentHeight : 1,
    owner: systemPubKey,
    guard: 'owner_signature',
    proofSource: currentHeight > 0 ? currentHeight : 1,
  };
  box.id = computeBoxId(box);
  insertBox(box);
}

/**
 * Sign a txId with the system keypair.
 */
export function signWithSystemKey(txId: string, secretKey: Uint8Array): Uint8Array {
  const privKey = createPrivateKey({
    key: Buffer.from(secretKey),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = sign(null, Buffer.from(txId, 'hex'), privKey);
  return new Uint8Array(sig);
}
