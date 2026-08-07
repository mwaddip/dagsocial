import { Encoder, decode } from 'cbor-x';
import type { AnyBox } from '@dagsocial/types';
// Type-only: erased at compile time, so state/ does not gain a runtime edge
// into the store module graph.
import type { IdentityRecord } from '../store/identity-records.js';

// Box type discriminators (1 byte each)
const BOX_TYPE_TAG: Record<AnyBox['boxType'], number> = {
  karma: 0x01,
  credit: 0x02,
  like: 0x03,
  invite: 0x04,
  bond: 0x05,
  post_lock: 0x06,
  vouch: 0x07,
};

const TAG_TO_BOX_TYPE: Record<number, AnyBox['boxType']> = {
  0x01: 'karma',
  0x02: 'credit',
  0x03: 'like',
  0x04: 'invite',
  0x05: 'bond',
  0x06: 'post_lock',
  0x07: 'vouch',
};

/**
 * Fields that are Uint8Array in the type system.  cbor-x decodes byte strings
 * as Buffer; we normalise them back to Uint8Array so roundtrip equality holds.
 */
const UINT8ARRAY_FIELDS = new Set([
  'owner',
  'likerId',
  'secretHash',
  'inviterId',
  'inviteePublicKey',
  'voucherId',
  'targetId',
]);

/**
 * Normalise decoded values: convert Buffer to Uint8Array for known
 * binary fields so the caller gets the types the interfaces expect.
 */
function normaliseFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (Buffer.isBuffer(val) && UINT8ARRAY_FIELDS.has(key)) {
      out[key] = new Uint8Array(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

// Deterministic CBOR encoder: definite-length maps, no records
const boxEncoder = new Encoder({ tagUint8Array: false, variableMapSize: false, useRecords: false });
const cborEncode = (obj: unknown): Uint8Array =>
  boxEncoder.encode(obj) as unknown as Uint8Array;

/**
 * Impose a total, caller-independent order on an object's own keys.
 *
 * Mirrors `canonicalBoxBytes`'s rule in `@dagsocial/types` — the same
 * lexicographic sort, applied to the other encoder. `Array.prototype.sort` with
 * no comparator compares UTF-16 code units and is **not** locale-aware, so it is
 * deterministic across platforms; every box field name is ASCII, so the order is
 * plain byte order.
 */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * Serialize an AnyBox to a deterministic Uint8Array.
 * Format: boxTypeTag(1) || CBOR(sorted boxFields)
 *
 * The box `id` is NOT included in the CBOR payload — it is the AVL key,
 * not part of the value. The `boxType` is encoded as a tag byte so
 * deserialization can reconstruct the discriminant.
 *
 * **Key order is imposed here, not inherited from the caller** (Spec G phase
 * G3b, contract hazard 1b). This encoder uses `variableMapSize: false` and
 * cbor-x emits keys in JS insertion order, so before this the caller's field
 * order was consensus-visible in the `stateRoot`. The convention was that
 * `rowToBox` mirrored each producer's order; `post_lock` did not obey it
 * (`originalValue`/`createdAtBlock` transposed), which made wiping the AVL store
 * without wiping the chain silently change the root. Sorting at the single
 * encode site retires that: a producer can no longer get key order wrong,
 * because it no longer chooses it. `withProvenance`'s append-last discipline in
 * `store/utxo.ts` is likewise no longer load-bearing.
 */
export function serializeBox(box: AnyBox): Uint8Array {
  const tag = BOX_TYPE_TAG[box.boxType];
  if (tag === undefined) throw new Error(`Unknown box type: ${box.boxType}`);

  // Omit `id` and `boxType` from CBOR — id is the AVL key, boxType is the tag byte
  const { id: _id, boxType: _bt, ...fields } = box;

  const payload = cborEncode(sortKeys(fields));

  const out = new Uint8Array(1 + payload.length);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

/**
 * Identity-record discriminator (Spec G phase B).
 *
 * Deliberately **outside** the `0x01`–`0x07` box-type range, with the high bit
 * set: "box" versus "not a box" is then a single bit test, and the box-type
 * space stays open for future box kinds without ever colliding with an entity
 * discriminator.
 */
export const IDENTITY_RECORD_TAG = 0x80;

/**
 * Serialize an identity record to a deterministic Uint8Array.
 * Format: 0x80(1) || CBOR({ lastActivityBlock, lastDecayBlock, likeCarry })
 *
 * The AVL key is `blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32]` (see
 * `store/identity-records.ts`), not part of the value — the same split boxes
 * use.
 *
 * Field order is written out explicitly rather than spread from the caller's
 * object: cbor-x emits map keys in insertion order and this encoder uses
 * `variableMapSize: false`, so key order is consensus-visible
 * (NODE_INTERFACE → "Two entity kinds" → 1b). Fixing it at the single encode
 * site means a record cannot acquire the field-order divergence that `post_lock`
 * has between its producer and `rowToBox`.
 *
 * `likeCarry` is ALWAYS PRESENT, zero included (P2-D). Conditional presence
 * would reopen the key-set-exactness fork (contract 1a): the cbor map header
 * counts keys, so an omit-when-zero producer and an always-write producer
 * disagree on every zero-carry record's bytes — and therefore on the
 * `stateRoot`. The type requires the field; do not "optimise" the zero away.
 * bigint deliberately: cbor-x encodes bigint as a fixed 8-byte integer, so
 * the value's width cannot drift with its magnitude, and a `number` sneaking
 * in here would change the bytes (a 1-byte zero) — the type is the guard.
 */
export function serializeIdentityRecord(record: IdentityRecord): Uint8Array {
  const payload = cborEncode({
    lastActivityBlock: record.lastActivityBlock,
    lastDecayBlock: record.lastDecayBlock,
    likeCarry: record.likeCarry,
  });

  const out = new Uint8Array(1 + payload.length);
  out[0] = IDENTITY_RECORD_TAG;
  out.set(payload, 1);
  return out;
}

/** Deserialize bytes produced by `serializeIdentityRecord`. */
export function deserializeIdentityRecord(bytes: Uint8Array): IdentityRecord {
  if (bytes.length < 2) throw new Error('Truncated identity record data');

  const tag = bytes[0]!;
  if (tag !== IDENTITY_RECORD_TAG) {
    throw new Error(`Not an identity record: tag 0x${tag.toString(16)}`);
  }

  const fields = decode(bytes.slice(1)) as Partial<IdentityRecord>;
  return {
    lastActivityBlock: Number(fields.lastActivityBlock),
    lastDecayBlock: Number(fields.lastDecayBlock),
    // BigInt(undefined) throws — bytes missing the field (pre-P2-D, or a
    // hand-rolled conditional-presence encoding) fail loudly here rather
    // than silently defaulting to 0n and masking a key-set fork.
    likeCarry: BigInt(fields.likeCarry as bigint),
  };
}

/**
 * Deserialize bytes produced by serializeBox back into a box (without `id`).
 * The box `id` is NOT restored — callers must supply it separately
 * (it is the AVL key).
 *
 * Rejects any non-box tag rather than mis-decoding it. The tree holds two
 * entity kinds and their keys are indistinguishable from outside — both are 32
 * bytes of hash output — so a caller that can see either value MUST dispatch on
 * the tag via `deserializeAvlValue`, not assume "box".
 */
export function deserializeBox(bytes: Uint8Array): Omit<AnyBox, 'id'> {
  if (bytes.length < 2) throw new Error('Truncated box data');

  const tag = bytes[0]!;
  if (tag === IDENTITY_RECORD_TAG) {
    throw new Error('Value is an identity record, not a box');
  }
  const boxType = TAG_TO_BOX_TYPE[tag];
  if (!boxType) throw new Error(`Unknown box type tag: ${tag}`);

  const payload = bytes.slice(1);
  const fields = decode(payload) as Record<string, unknown>;

  return { boxType, ...normaliseFields(fields) } as Omit<AnyBox, 'id'>;
}

/** A decoded AVL value, discriminated by its tag byte. */
export type AvlValue =
  | { kind: 'box'; box: Omit<AnyBox, 'id'> }
  | { kind: 'record'; record: IdentityRecord };

/**
 * Kind-dispatching decoder — what any caller that can see either entity uses.
 *
 * Phase D owes the proof endpoint this: `GET /api/v1/proof/:boxId` decodes
 * whatever value a key resolves to, and a client can ask for a record key
 * because keys are indistinguishable from outside. Phase B populates no
 * records, so the tree provably contains none and the endpoint has no reachable
 * defect yet.
 */
export function deserializeAvlValue(bytes: Uint8Array): AvlValue {
  if (bytes.length < 2) throw new Error('Truncated AVL value');
  if (bytes[0] === IDENTITY_RECORD_TAG) {
    return { kind: 'record', record: deserializeIdentityRecord(bytes) };
  }
  return { kind: 'box', box: deserializeBox(bytes) };
}

/**
 * Full roundtrip helper: deserializes and restores the `id` field.
 */
export function deserializeBoxWithId(id: string, bytes: Uint8Array): AnyBox {
  const fields = deserializeBox(bytes);
  return { id, ...fields } as AnyBox;
}
