// packages/node/test/global-setup.ts
//
// Rebuild `dist` before any test file runs.
//
// The e2e suites (`test/e2e/*`) spawn `packages/node/dist/index.js` as a child
// process, so they exercise whatever was last built rather than the current
// source. `vitest run` builds nothing, so a suite invoked without a preceding
// build silently reports on a stale binary — that is how a real regression got
// through green tests.
//
// This lives in `globalSetup` rather than a `pretest` script so the guarantee
// holds on every entry point into the suite: `pnpm test`, a bare `vitest run`,
// `test:watch`, and IDE runners all pass through here. It runs once, in the
// Vitest main process, before any worker starts — so the three e2e files can
// never race each other writing the same `dist`.
//
// The filter builds `@dagsocial/node` *and its workspace dependencies* in
// topological order: tsup externalises `@dagsocial/types`, `/validation` and
// `/net`, so the spawned node loads their `dist` too and a stale sibling is the
// same hole one package over.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

export default function buildDistBeforeTests(): void {
  const started = Date.now();

  try {
    execFileSync('pnpm', ['--filter', '@dagsocial/node...', 'build'], {
      cwd: packageRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: string; stderr?: string };
    throw new Error(
      'global-setup: build failed — refusing to run the suite, because the e2e ' +
        'tests would have spawned a stale dist/index.js.\n' +
        `${stdout ?? ''}${stderr ?? ''}`,
    );
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[global-setup] rebuilt @dagsocial/node + workspace deps in ${secs}s`);
}
