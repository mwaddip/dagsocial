import type { AnyBox, UtxoTransaction } from '@dagsocial/types';
import { ClientError } from '../services/client-error.js';

/**
 * Fields in box types whose runtime value is Uint8Array but arrive as hex
 * strings over the JSON HTTP API.  We convert them back during deserialisation.
 */
const BINARY_BOX_FIELDS = new Set([
  'owner',            // KarmaBox, CreditBox, PostLockBox
  'likerId',          // LikeBox
  'secretHash',       // InviteBox
  'inviterId',        // InviteBox, BondBox
  'inviteePublicKey', // BondBox
]);

/**
 * Convert a JSON tx object (as received over the HTTP API) into a
 * {@link UtxoTransaction}.  Hex-encoded Uint8Array fields in signatures,
 * preimages, and box outputs are decoded to raw `Uint8Array`.
 */
export function jsonToTx(raw: Record<string, unknown>): UtxoTransaction {
  // ---- signatures ----
  const rawSigs = (raw.signatures ?? {}) as Record<string, string>;
  const signatures: Record<string, Uint8Array> = {};
  for (const [key, val] of Object.entries(rawSigs)) {
    if (typeof val !== 'string') {
      throw new ClientError(`signature for ${key} must be a hex string`);
    }
    signatures[key] = hexToBytes(val);
  }

  // ---- preimages ----
  const rawPreimages = (raw.preimages ?? {}) as Record<string, string>;
  const preimages: Record<string, Uint8Array> = {};
  for (const [key, val] of Object.entries(rawPreimages)) {
    if (typeof val !== 'string') {
      throw new ClientError(`preimage for ${key} must be a hex string`);
    }
    preimages[key] = hexToBytes(val);
  }

  // ---- outputs ----
  const rawOutputs = (raw.outputs ?? []) as Record<string, unknown>[];
  const outputs = rawOutputs.map(convertBox) as unknown as AnyBox[];

  // ---- protocolVersion ----
  const protocolVersion = (raw.protocolVersion as number) ?? 1;

  return {
    inputs: (raw.inputs ?? []) as string[],
    outputs,
    signatures,
    preimages: Object.keys(preimages).length > 0 ? preimages : undefined,
    protocolVersion,
  };
}

/**
 * Convert hex-encoded Uint8Array fields inside a single box object, and
 * reject a `value` the ledger cannot account for.
 */
function convertBox(box: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(box)) {
    if (BINARY_BOX_FIELDS.has(key) && typeof val === 'string') {
      out[key] = hexToBytes(val);
    } else {
      out[key] = val;
    }
  }
  assertValidBoxValue(out.value);
  return out;
}

/**
 * A box `value` must be a non-negative integer that JS can sum exactly —
 * negative, fractional, `NaN`, `Infinity`, and above-2^53 values all break
 * conservation arithmetic. Rejecting here gives the client a clear 400;
 * `validateTx` enforces the same rule for txs arriving over gossip or inside
 * a block.
 */
function assertValidBoxValue(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ClientError(
      `box value must be a non-negative integer, got ${String(value)}`,
    );
  }
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
