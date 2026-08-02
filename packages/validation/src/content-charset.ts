// ---------------------------------------------------------------------------
// Content character policy — pinned Unicode codepoint table (audit M-4)
// ---------------------------------------------------------------------------
//
// `verifyContentCharacters` is a **consensus Stage-1 check**: every node must
// reach the same verdict for the same bytes. It therefore may NOT be expressed
// with runtime Unicode general-category escapes (`\p{C}` / `\P{C}`).
//
// The old implementation was `/^[\P{C}\n]*$/u`. `\P{C}` excludes `\p{Cn}`
// (unassigned), and which codepoints are unassigned changes with the Unicode
// data version each Node/V8 build ships. Two honest nodes on different builds
// therefore reached *different verdicts* for the same content — a consensus
// split. (Node 22.19 ships Unicode 16.0; Node 20 shipped 15.0/15.1.)
//
// The fix is this static table: the union of the Unicode general categories
// `Cc` (control), `Cf` (format), `Cs` (surrogate) and `Co` (private use),
// enumerated once at a **pinned Unicode version**, minus U+000A (line feed,
// which stays allowed). `Cn` (unassigned) is deliberately NOT rejected —
// allowing it is precisely what removes the version dependence, because a
// codepoint moving from Cn to an assigned category no longer flips the verdict.
//
// Nothing here consults `\p{...}` at runtime.
//
// ---------------------------------------------------------------------------
// PINNED UNICODE VERSION: 16.0
// ---------------------------------------------------------------------------
//
// The table was generated once, at dev time, by enumerating every codepoint in
// U+0000–U+10FFFF against `/\p{Cc}|\p{Cf}|\p{Cs}|\p{Co}/u` on Node v22.19.0
// (`process.versions.unicode === '16.0'`), skipping U+000A, and coalescing the
// hits into ascending inclusive ranges:
//
//   const RE = /\p{Cc}|\p{Cf}|\p{Cs}|\p{Co}/u;
//   const hits = [];
//   for (let cp = 0; cp <= 0x10ffff; cp++) {
//     if (cp === 0x0a) continue;
//     if (RE.test(String.fromCodePoint(cp))) hits.push(cp);
//   }
//   // → coalesce consecutive hits into [start, end] pairs
//
// Result: 139,750 codepoints in 27 ranges. Changing the pinned version is a
// consensus-visible protocol change — it must be coordinated, not incidental
// to a Node upgrade. Re-running the snippet on a newer runtime and pasting the
// output is exactly the mistake this table exists to prevent.

/** The Unicode version the range table below was enumerated at. */
export const PINNED_UNICODE_VERSION = '16.0';

/**
 * Disallowed content codepoints as ascending, non-overlapping, inclusive
 * `[start, end]` ranges. Union of Cc/Cf/Cs/Co at Unicode
 * {@link PINNED_UNICODE_VERSION}, minus U+000A.
 *
 * U+D800–U+F8FF merges the surrogates (Cs, D800–DFFF) with the BMP private-use
 * area (Co, E000–F8FF) — they are adjacent.
 */
const DISALLOWED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0009], // C0 controls below LF (NUL … TAB) — \t stays rejected
  [0x000b, 0x001f], // C0 controls above LF (VT … US), incl. \r
  [0x007f, 0x009f], // DEL + C1 controls
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x0600, 0x0605], // Arabic number signs
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x06dd, 0x06dd], // ARABIC END OF AYAH
  [0x070f, 0x070f], // SYRIAC ABBREVIATION MARK
  [0x0890, 0x0891], // Arabic pound/piastre marks
  [0x08e2, 0x08e2], // ARABIC DISPUTED END OF AYAH
  [0x180e, 0x180e], // MONGOLIAN VOWEL SEPARATOR
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embedding/override controls
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x206f], // bidi isolates + deprecated format controls
  [0xd800, 0xf8ff], // surrogates (Cs) + BMP private use (Co)
  [0xfeff, 0xfeff], // BOM / ZERO WIDTH NO-BREAK SPACE
  [0xfff9, 0xfffb], // interlinear annotation anchors
  [0x110bd, 0x110bd], // KAITHI NUMBER SIGN
  [0x110cd, 0x110cd], // KAITHI NUMBER SIGN ABOVE
  [0x13430, 0x1343f], // Egyptian hieroglyph format controls
  [0x1bca0, 0x1bca3], // Shorthand format controls
  [0x1d173, 0x1d17a], // Musical symbol beam/phrase controls
  [0xe0001, 0xe0001], // LANGUAGE TAG
  [0xe0020, 0xe007f], // tag characters
  [0xf0000, 0xffffd], // supplementary private use area-A
  [0x100000, 0x10fffd], // supplementary private use area-B
];

/**
 * True iff `cp` is a disallowed content codepoint per the pinned table.
 *
 * Ranges are sorted ascending, so the scan exits at the first range starting
 * above `cp` — ASCII text settles in three comparisons, and the worst case is
 * the 27 table entries. Deterministic on every runtime: no runtime Unicode
 * data is consulted.
 */
export function isDisallowedContentCodepoint(cp: number): boolean {
  for (const [start, end] of DISALLOWED_RANGES) {
    if (cp < start) return false;
    if (cp <= end) return true;
  }
  return false;
}
