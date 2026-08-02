import type { EpochTally, LikeReward } from '@dagsocial/types';

/**
 * Canonical serialization of the epoch tally.
 *
 * The tally's `rewards` map is keyed by postId in Map insertion order, which is
 * the row order of the like queries, which is the order this node happened to
 * receive those likes over gossip.  Two honest nodes holding the same logical
 * tally therefore produce different `JSON.stringify` bytes.  Those bytes gate
 * epoch-block acceptance (`block-apply`) and form the `'epoch'` Merkle leaf
 * (`block-creator`), so with insertion-order serialization honest nodes reject
 * each other's valid epoch blocks at every epoch boundary (audit C-6).
 *
 * Serializing canonically — rather than making the producers emit rows in a
 * fixed order — is what actually fixes it: a tally also reaches these two sites
 * after a CBOR round-trip (wire, or the block store), which preserves the
 * *sender's* key order, so the receiver can never rely on its own ordering.
 *
 * Canonical form, the documented sort order ARCHITECTURE's "sort-order
 * determinism" invariant requires:
 *
 *   - object keys ascending by UTF-16 code unit (`Array#sort`'s default, and
 *     the same order `<` gives on strings)
 *   - set-like arrays sorted by their elements' own canonical form
 *   - byte arrays as lowercase hex, so a `Uint8Array` and a `Buffer` over the
 *     same bytes serialize identically
 *   - `undefined` properties omitted, as `JSON.stringify` does
 *   - no insignificant whitespace
 *
 * Both consumers go through this module so the compare and the hash cannot
 * drift apart.
 */

/** Serialize any plain-data value with object keys in sorted order. */
function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  // Buffer extends Uint8Array, so this covers both representations.
  if (value instanceof Uint8Array) {
    return JSON.stringify(Buffer.from(value).toString('hex'));
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, (value as Record<string, unknown>)[key]] as const)
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalValue(v)}`);
    return `{${entries.join(',')}}`;
  }

  // Strings, numbers, booleans. `JSON.stringify` returns undefined for values
  // with no JSON representation (functions, symbols); nothing in an EpochTally
  // is one, but fall back to `null` rather than emitting the literal
  // "undefined" and producing invalid output.
  return JSON.stringify(value) ?? 'null';
}

/**
 * Order an array by its elements' canonical form — a total order that needs no
 * designated key field, so it stays correct if a box gains or loses one.
 */
function sortByCanonicalForm<T>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, key: canonicalValue(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.item);
}

/**
 * Canonical form of the `postId → LikeReward` map, including each reward's
 * nested `likerId → refund` map.  Used for the epoch-tally equality check that
 * gates block acceptance.
 */
export function canonicalRewardsJson(rewards: Record<string, LikeReward>): string {
  return canonicalValue(rewards);
}

/**
 * Canonical form of a whole `EpochTally` — the preimage of the `'epoch'` Merkle
 * leaf.  The id arrays and replacement boxes are sets, not sequences: they come
 * out of SQLite in rowid order and are applied by set membership, so they are
 * sorted here rather than committed in whatever order the producer had.
 *
 * Fields are spread rather than listed, so a field added to `EpochTally` later
 * is committed to by default instead of silently dropping out of the leaf.
 */
export function canonicalEpochTallyJson(tally: EpochTally): string {
  return canonicalValue({
    ...tally,
    talliedLockedLikeBoxIds: [...(tally.talliedLockedLikeBoxIds ?? [])].sort(),
    processedFreeLikeIds: [...(tally.processedFreeLikeIds ?? [])].sort(),
    consumedPostLockBoxIds: [...(tally.consumedPostLockBoxIds ?? [])].sort(),
    newPostLockBoxes: sortByCanonicalForm(tally.newPostLockBoxes ?? []),
  });
}
