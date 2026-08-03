/**
 * BLAKE2b for the browser.
 *
 * Isolated in its own module so `chain.js` has a single, aliasable import for
 * the hash function. The node package's mirror test swaps this file for a
 * `node:crypto` shim (see `vitest.config.ts` → `resolve.alias`), which is what
 * lets the browser crypto be unit-tested against `@dagsocial/types` without a
 * browser or a bundler.
 *
 * Node.js v22 has no `blake2b256`, so both sides compute `blake2b512` and
 * truncate to 32 bytes — see the root CLAUDE.md "Platform constraint" note.
 */
export { blake2b } from 'https://cdn.jsdelivr.net/npm/blakejs@1.2.1/+esm';
