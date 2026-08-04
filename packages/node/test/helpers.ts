import { createHash, sign as cryptoSign, type KeyObject } from 'crypto';
import { computeTxId } from '@dagsocial/types';
import type { UtxoTransaction, AnyBox } from '@dagsocial/types';

/**
 * Convert a short string label to a deterministic 32-byte Uint8Array
 * suitable as a UserId (Ed25519 public key) for testing.
 */
export function uid(label: string): Uint8Array {
  const h = createHash('blake2b512').update(label).digest();
  return new Uint8Array(h.subarray(0, 32));
}

/** Convert a Uint8Array userId to hex for comparison in test assertions */
export function uidHex(label: string): string {
  return Buffer.from(uid(label)).toString('hex');
}

/** Convert a Uint8Array userId to a hex string for HTTP API requests. */
export function toHex(u: Uint8Array): string {
  return Buffer.from(u).toString('hex');
}

// ---------------------------------------------------------------------------
// tx-hash signing helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
export function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/**
 * Sign a UtxoTransaction by computing its txId, signing that hash, and
 * storing the signature in `tx.signatures[pubKeyHex]`.
 */
export function signTransaction(
  tx: UtxoTransaction,
  privKey: KeyObject,
  pubKeyHex: string,
): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  tx.signatures[pubKeyHex] = new Uint8Array(sig);
}

/**
 * Convert a UtxoTransaction to a JSON-safe object suitable for HTTP API
 * requests.  Uint8Array fields are hex-encoded.
 */
export function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map((o) => {
      const obj: Record<string, unknown> = { ...o };
      for (const [k, v] of Object.entries(obj)) {
        if (v instanceof Uint8Array) obj[k] = Buffer.from(v).toString('hex');
        // Box values/amounts are bigint — the JSON API carries them as
        // decimal strings (json-to-tx coerces them back).
        else if (typeof v === 'bigint') obj[k] = v.toString();
      }
      return obj;
    }),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
    ),
    preimages: tx.preimages
      ? Object.fromEntries(
          Object.entries(tx.preimages).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
        )
      : undefined,
    protocolVersion: tx.protocolVersion,
  };
}
