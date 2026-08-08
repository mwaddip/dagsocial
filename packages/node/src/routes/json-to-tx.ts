import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { AnyBox, UtxoTransaction } from '@dagsocial/types';
import { ClientError } from '../services/client-error.js';

/**
 * Fields in box types whose runtime value is Uint8Array but arrive as hex
 * strings over the JSON HTTP API.  We convert them back during deserialisation.
 */
const BINARY_BOX_FIELDS = new Set([
  'owner',            // KarmaBox, CreditBox, PostLockBox
  'secretHash',       // InviteBox
  'inviterId',        // InviteBox, BondBox
  'inviteePublicKey', // BondBox
  // VouchBox. Missing until 2026-08-08, which made the vouch cast
  // INEXPRESSIBLE over HTTP JSON: both fields arrived as hex strings and died
  // at `validateTx`'s step-4 schema, which wants `bytes32`. Invisible to the
  // suite because vouch coverage was service-level only — raw `Uint8Array`
  // objects, never through this edge. The demo UI's `canonicalBoxBytes` mirror
  // already listed both, so this is the receiver catching up with the sender.
  'voucherId',        // VouchBox
  'targetId',         // VouchBox
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
  // `PROTOCOL_VERSION`, never a hard-coded 1: after a version bump the literal
  // would have this edge mint stale-version txs that `checkTxEnvelope`'s
  // strict-equality clause then rejects. The value still passes through when
  // the client supplies one — the gate owns the equality check, this owns only
  // the default.
  const protocolVersion = (raw.protocolVersion as number) ?? PROTOCOL_VERSION;

  // ---- likeTarget (P2-D) ----
  // Carried through only when present — presence is `!== undefined`, matching
  // the `computeTxId` tail rule. The JSON edge must neither drop nor invent
  // the field: it sits inside the signed bytes, so dropping it breaks every
  // like signature, and `castLike` owns the 64-hex shape check.
  const likeTarget = raw.likeTarget;
  if (likeTarget !== undefined && typeof likeTarget !== 'string') {
    throw new ClientError('likeTarget must be a string post id');
  }

  return {
    inputs: (raw.inputs ?? []) as string[],
    outputs,
    signatures,
    // A conditional SPREAD, not `: undefined` — the same idiom `likeTarget`
    // uses one line below, and for the same reason. `preimages: undefined`
    // leaves a present key holding `undefined`, which `computeTxId` hashes as
    // absent (falsy) but `checkTxEnvelope` rejects as the CBOR-reachable
    // ambiguity it is. Every preimage-free HTTP transaction carried one until
    // the envelope gate measured it, so the contract's claim that this edge
    // "normalizes {} to absent" was true only in effect, never in structure.
    ...(Object.keys(preimages).length > 0 ? { preimages } : {}),
    protocolVersion,
    ...(likeTarget !== undefined ? { likeTarget } : {}),
  };
}

/**
 * Amount fields that are bigint at runtime but arrive as decimal strings (or
 * safe-integer numbers) over the JSON HTTP API: `value` on every box type,
 * `originalValue` on PostLockBox. Coerced before validation — leaving one as
 * a number would change its CBOR encoding and so the computed box id.
 */
const VALUE_BOX_FIELDS = new Set(['value', 'originalValue']);

/**
 * Convert hex-encoded Uint8Array fields inside a single box object, coerce
 * amount fields to bigint, and reject a `value` the ledger cannot account for.
 */
function convertBox(box: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(box)) {
    if (BINARY_BOX_FIELDS.has(key) && typeof val === 'string') {
      out[key] = hexToBytes(val);
    } else if (VALUE_BOX_FIELDS.has(key)) {
      out[key] = coerceBoxValue(val, key);
    } else {
      out[key] = val;
    }
  }
  assertValidBoxValue(out.value);
  return out;
}

/**
 * Coerce an incoming JSON amount (decimal string or safe-integer number) to
 * bigint, rejecting anything not cleanly convertible, then enforce the value
 * bound. This is the HTTP→consensus edge for box values.
 */
function coerceBoxValue(raw: unknown, field: string): bigint {
  let value: bigint;
  if (typeof raw === 'bigint') {
    value = raw;
  } else if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    value = BigInt(raw);
  } else if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    value = BigInt(raw);
  } else {
    throw new ClientError(
      `box ${field} must be a non-negative integer (decimal string or number), got ${String(raw)}`,
    );
  }
  assertValidBoxValue(value, field);
  return value;
}

/**
 * A box `value` must be a non-negative bigint below 2^64 — negative values
 * break conservation arithmetic, and at/above 2^64 the CBOR encoding leaves
 * the uniform uint64 form. Rejecting here gives the client a clear 400;
 * `validateTx`'s step-4 output schema (the `u64` field type) enforces the
 * same tight bound for txs arriving over gossip or inside a block.
 */
function assertValidBoxValue(value: unknown, field = 'value'): void {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << 64n)) {
    throw new ClientError(
      `box ${field} must be a non-negative bigint < 2^64, got ${String(value)}`,
    );
  }
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
