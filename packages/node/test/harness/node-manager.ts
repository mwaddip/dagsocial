// packages/node/test/harness/node-manager.ts
import { spawn, type ChildProcess } from 'node:child_process';

export interface NodeConfig {
  index: number;
  mining: boolean;
  bootstrapPeer?: string;
}

export interface NodeProcess {
  process: ChildProcess;
  config: NodeConfig;
  httpUrl: string;
  adminUrl: string;
  libp2pPort: number;
  log: string;
  peerId?: string;
}

const HTTP_BASE = 10300;
const LIBP2P_BASE = 10400;
const ADMIN_BASE = 10500;

const PROJECT_ROOT = new URL('../../../..', import.meta.url).pathname;

function buildEnv(config: NodeConfig): Record<string, string> {
  const httpPort = HTTP_BASE + config.index;
  const lpPort = LIBP2P_BASE + config.index;
  const adminPort = ADMIN_BASE + config.index;

  return {
    ...process.env,
    PORT: String(httpPort),
    ADMIN_PORT: String(adminPort),
    DB_PATH: ':memory:',
    NODE_ROLE: config.mining ? 'miner' : 'server',
    MINING_MODE: 'internal',
    LISTEN_ADDRS: `/ip4/0.0.0.0/tcp/${lpPort}`,
    ORDERING_BLOCK_INTERVAL_MS: '2000',
    KARMA_STALE_THRESHOLD_BLOCKS: '5',
    KARMA_DECAY_INTERVAL_BLOCKS: '3',
    KARMA_DECAY_AMOUNT: '5',
    KARMA_MINIMUM: '10',
    EPOCH_BLOCKS: '10',
    CHALLENGE_WINDOW_BLOCKS: '100',
    ORDERING_BLOCK_POW_TARGET_BITS: '4',
    POST_POW_TARGET_BITS: '4',
    ...(config.bootstrapPeer ? { BOOTSTRAP_PEERS: config.bootstrapPeer } : {}),
  };
}

export function spawnNode(config: NodeConfig): NodeProcess {
  const env = buildEnv(config);
  const httpPort = HTTP_BASE + config.index;
  const lpPort = LIBP2P_BASE + config.index;
  const adminPort = ADMIN_BASE + config.index;

  const proc = spawn('node', ['packages/node/dist/index.js'], {
    env,
    stdio: 'pipe',
    cwd: PROJECT_ROOT,
  });

  const node: NodeProcess = {
    process: proc,
    config,
    httpUrl: `http://localhost:${httpPort}`,
    adminUrl: `http://localhost:${adminPort}`,
    libp2pPort: lpPort,
    log: '',
  };

  proc.stdout!.on('data', (d: Buffer) => { node.log += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { node.log += d.toString(); });
  proc.on('error', (e: Error) => { node.log += `\n[SPAWN ERROR] ${e.message}\n`; });

  return node;
}

export async function waitForReady(
  nodes: NodeProcess[],
  timeoutMs: number = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // First wait for "Net node started" log marker on all nodes
  for (const node of nodes) {
    while (Date.now() < deadline) {
      if (node.log.includes('Net node started')) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!node.log.includes('Net node started')) {
      throw new Error(
        `node-${node.config.index} failed to start within ${timeoutMs}ms.\n` +
        `Log tail: ${node.log.slice(-500)}`,
      );
    }
    // Extract peer ID for bootstrap nodes
    const m = node.log.match(/peer ID:\s*([a-zA-Z0-9]+)/);
    if (m) node.peerId = m[1];
  }

  // Then poll /status until all nodes respond
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Timeout waiting for nodes to start');

  const pollStart = Date.now();
  while (Date.now() < deadline) {
    const results = await Promise.allSettled(
      nodes.map(n => fetch(`${n.httpUrl}/status`)),
    );
    if (results.every(r => r.status === 'fulfilled')) {
      console.log(`All ${nodes.length} nodes ready in ${Date.now() - pollStart}ms`);
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Collect failure info
  const failed = await Promise.all(
    nodes.map(async n => {
      try {
        await fetch(`${n.httpUrl}/status`);
        return null;
      } catch {
        const exited = n.process.exitCode !== null || n.process.killed;
        return `node-${n.config.index}: exited=${exited} exitCode=${n.process.exitCode} log=${n.log.slice(-300)}`;
      }
    }),
  );
  throw new Error(
    `Nodes failed to reach /status within ${timeoutMs}ms:\n` +
    failed.filter(Boolean).join('\n'),
  );
}

export async function killAll(nodes: NodeProcess[]): Promise<void> {
  const procs = nodes.map(n => n.process).filter(Boolean) as ChildProcess[];
  for (const p of procs) p.kill('SIGKILL');
  await Promise.race([
    Promise.all(
      procs.map(p => new Promise<void>(resolve => {
        if (p.killed || p.exitCode !== null) return resolve();
        p.on('exit', () => resolve());
      })),
    ),
    new Promise<void>(resolve => setTimeout(resolve, 5000)),
  ]);
  await new Promise(r => setTimeout(r, 300)); // port release
}
