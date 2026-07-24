import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'crypto';
import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { getDb } from './db.js';
import { insertBox, getKarmaBox } from './utxo.js';

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

/**
 * Generate and persist the system keypair. Idempotent — returns existing
 * keypair if already initialized.
 */
export function initSystemKeypair(): SystemKeypair {
  const existing = getSystemKeypair();
  if (existing) return existing;

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

  // Extract raw 32-byte public key from SPKI DER
  const pubBytes = new Uint8Array(pubDer.subarray(pubDer.length - 32));
  const privBytes = new Uint8Array(privDer);

  // Store concatenated: publicKey (32) || secretKey (PKCS8 DER)
  const value = Buffer.concat([Buffer.from(pubBytes), Buffer.from(privBytes)]);
  const db = getDb();
  db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run(
    SYSTEM_KEYPAIR_KEY,
    value,
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
