/**
 * Structural guards for decoded, untrusted wire messages.
 *
 * Every stream message arrives as CBOR from a peer we do not trust. `decode()`
 * returns `any`, so casting the result straight to a message interface lets a
 * missing field surface as a `TypeError` deep inside a handler — or, worse, lets
 * a negative height reach a loop that walks the chain one block at a time.
 *
 * These predicates are the decode boundary: shape first (field presence, types,
 * array-ness), then bounds on every height and count, before the value is used.
 * Unknown extra fields are ignored, not rejected — forward compatibility.
 */

/**
 * Largest chain height a peer may advertise.
 *
 * Advertised heights drive serve loops that walk the chain height by height, so
 * an unbounded — or negative — value turns a single packet into a multi-second
 * synchronous DB scan. 100M blocks is ~190 years at one block per minute: far
 * beyond any real chain, far below anything that costs us a loop.
 */
export const MAX_ADVERTISED_HEIGHT = 100_000_000;

/**
 * Largest modifier type id accepted at the boundary.
 *
 * Unknown-but-bounded type ids pass this check and are dropped by the handler
 * that understands (or does not understand) them — the invariant is that
 * unknown codes are preserved, not rejected.
 */
export const MAX_TYPE_ID = 65_535;

/** Largest value for a uint32 wire field (session magic). */
export const MAX_UINT32 = 0xffff_ffff;

/** Largest protocol version / capability code accepted in a handshake. */
export const MAX_CAPABILITY_CODE = 65_535;

/**
 * Cumulative work travels as a decimal bigint string. 80 digits is far past any
 * plausible chain total and keeps `BigInt(...)` on the consuming side total.
 */
const WORK_STRING_RE = /^[0-9]{1,80}$/;

/** True for a plain CBOR map — an object that is neither null nor an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * True for a non-negative integer no greater than `max`.
 *
 * Rejects `NaN`, `Infinity`, fractions, negatives, and bigints — CBOR can carry
 * all of them, and `Number.isInteger` alone lets negatives through.
 */
export function isBoundedInt(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/** True for a height a peer may legitimately advertise. */
export function isHeight(v: unknown): v is number {
  return isBoundedInt(v, MAX_ADVERTISED_HEIGHT);
}

/** True for an array whose every element is a string. */
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** True for an array whose every element is a bounded non-negative integer. */
export function isBoundedIntArray(v: unknown, max: number): v is number[] {
  return Array.isArray(v) && v.every((x) => isBoundedInt(x, max));
}

/** True for a byte string. cbor-x decodes CBOR byte strings to Buffer, a Uint8Array subclass. */
export function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

/** True for a decimal-digit string that `BigInt()` can parse. */
export function isWorkString(v: unknown): v is string {
  return typeof v === 'string' && WORK_STRING_RE.test(v);
}
