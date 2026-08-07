// packages/node/test/global-setup.ts
//
// Rebuild `dist` before any test file runs, when the run can include the e2e
// suite.
//
// The e2e suites (`test/e2e/*`) spawn `packages/node/dist/index.js` as a child
// process, so they exercise whatever was last built rather than the current
// source. `vitest run` builds nothing, so a suite invoked without a preceding
// build silently reports on a stale binary — that is how a real regression got
// through green tests.
//
// The e2e suite is the build's ONLY consumer: unit tests resolve `@dagsocial/*`
// to `src` via the workspace vitest alias (contracts/ARCHITECTURE.md → "Build
// and test resolution") and never read `dist`. So while `test/e2e/**` sits in
// the effective exclude list the build is skipped — it would cost a full
// workspace build per run and write four siblings' `dist` for nothing, and
// concurrent `dist` writes are the recorded race surface in the multi-window
// workflow. The gate keys on the resolved config, so the post-P2-D rewrite
// that removes the exclusion re-arms the build automatically.
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
import type { GlobalSetupContext } from 'vitest/node';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

export default function buildDistBeforeTests({ config }: GlobalSetupContext): void {
  if (config.exclude.includes('test/e2e/**')) {
    console.log('[global-setup] e2e excluded — skipping dist rebuild (unit tests resolve src)');
    return;
  }

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
