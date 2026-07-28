import { Encoder, decode } from 'cbor-x';
import type { AnyBox } from '@dagsocial/types';

// Box type discriminators (1 byte each)
const BOX_TYPE_TAG: Record<AnyBox['boxType'], number> = {
  karma: 0x01,
  credit: 0x02,
  like: 0x03,
  invite: 0x04,
  bond: 0x05,
  post_lock: 0x06,
};

const TAG_TO_BOX_TYPE: Record<number, AnyBox['boxType']> = {
  0x01: 'karma',
  0x02: 'credit',
  0x03: 'like',
  0x04: 'invite',
  0x05: 'bond',
  0x06: 'post_lock',
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
 * Serialize an AnyBox to a deterministic Uint8Array.
 * Format: boxTypeTag(1) || CBOR(boxFields)
 *
 * The box `id` is NOT included in the CBOR payload — it is the AVL key,
 * not part of the value. The `boxType` is encoded as a tag byte so
 * deserialization can reconstruct the discriminant.
 */
export function serializeBox(box: AnyBox): Uint8Array {
  const tag = BOX_TYPE_TAG[box.boxType];
  if (tag === undefined) throw new Error(`Unknown box type: ${box.boxType}`);

  // Omit `id` and `boxType` from CBOR — id is the AVL key, boxType is the tag byte
  const { id: _id, boxType: _bt, ...fields } = box;

  const payload = cborEncode(fields);

  const out = new Uint8Array(1 + payload.length);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

/**
 * Deserialize bytes produced by serializeBox back into a box (without `id`).
 * The box `id` is NOT restored — callers must supply it separately
 * (it is the AVL key).
 */
export function deserializeBox(bytes: Uint8Array): Omit<AnyBox, 'id'> {
  if (bytes.length < 2) throw new Error('Truncated box data');

  const tag = bytes[0]!;
  const boxType = TAG_TO_BOX_TYPE[tag];
  if (!boxType) throw new Error(`Unknown box type tag: ${tag}`);

  const payload = bytes.slice(1);
  const fields = decode(payload) as Record<string, unknown>;

  return { boxType, ...normaliseFields(fields) } as Omit<AnyBox, 'id'>;
}

/**
 * Full roundtrip helper: deserializes and restores the `id` field.
 */
export function deserializeBoxWithId(id: string, bytes: Uint8Array): AnyBox {
  const fields = deserializeBox(bytes);
  return { id, ...fields } as AnyBox;
}
