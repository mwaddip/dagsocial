import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Test-time module resolution for the workspace — the contract is
// contracts/ARCHITECTURE.md → "Build and test resolution". Inside a vitest
// process every `@dagsocial/*` import resolves to that package's src barrel
// instead of following package.json `exports` to `dist/`, so a source edit is
// visible to every suite without a rebuild. Production resolution is
// untouched: `exports` still points at `dist`.
//
// The target is `src/index.ts`, not `src/` — the barrel stays the surface
// under test, so a symbol exported by a module but missing from index.ts
// still fails at import.
//
// Applied uniformly to all five packages: aliasing some and not others puts
// two copies of the same module in one process (one from src, one bundled in
// dist), which breaks `instanceof` and duplicates module-level singletons.
//
// Spawned child processes are exempt by nature — the alias exists only inside
// vitest. Anything that spawns dist/index.js still needs a real build first.
const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dagsocial/types': src('types'),
      '@dagsocial/wire': src('wire'),
      '@dagsocial/validation': src('validation'),
      '@dagsocial/net': src('net'),
      '@dagsocial/node': src('node'),
    },
  },
});
