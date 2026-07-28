// packages/node/test/harness/chapter-runner.ts
import type { NodeProcess } from './node-manager.js';
import { killAll } from './node-manager.js';
import type { ApiClient } from './api-client.js';
import type { IdentityPool } from './identity-pool.js';

export interface HarnessState {
  nodes: NodeProcess[];
  clients: ApiClient[];
  pool: IdentityPool;
}

export interface Chapter {
  name: string;
  fn: (state: HarnessState) => Promise<void>;
  /** Timeout in ms. Defaults to 120000 (2 min). */
  timeoutMs?: number;
}

const OVERALL_DEADLINE_MS = 8 * 60 * 1000; // 8 minutes

export async function runChapters(
  chapters: Chapter[],
  state: HarnessState,
): Promise<void> {
  const startTime = Date.now();
  let passed = 0;
  let failed: string | null = null;

  for (const chapter of chapters) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= OVERALL_DEADLINE_MS) {
      failed = `Overall deadline (8 min) exceeded before chapter "${chapter.name}"`;
      break;
    }

    console.log(`\n── Chapter: ${chapter.name} ──`);
    const chapterStart = Date.now();

    try {
      const timeout = chapter.timeoutMs ?? 120_000;
      await Promise.race([
        chapter.fn(state),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Chapter "${chapter.name}" timed out after ${timeout}ms`)), timeout),
        ),
      ]);

      const duration = ((Date.now() - chapterStart) / 1000).toFixed(1);
      console.log(`✓ ${chapter.name} (${duration}s)`);
      passed++;
    } catch (err) {
      failed = chapter.name;
      console.error(`✗ ${chapter.name} FAILED:`);
      console.error(err);

      // Dump node logs
      for (const node of state.nodes) {
        const tail = node.log.slice(-2000);
        if (tail.length > 0) {
          console.error(`\n── node-${node.config.index} log tail (last 2000 chars) ──`);
          console.error(tail);
        }
      }

      break; // Stop on first failure
    }
  }

  // Always teardown
  console.log('\n── Teardown ──');
  await killAll(state.nodes);
  console.log('All nodes killed');

  // Summary
  const total = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${passed}/${chapters.length} chapters passed in ${total}s`);

  if (failed) {
    throw new Error(`Chapter "${failed}" failed. ${passed}/${chapters.length} passed.`);
  }
}
