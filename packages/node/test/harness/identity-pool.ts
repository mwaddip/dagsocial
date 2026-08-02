// packages/node/test/harness/identity-pool.ts
import { generateKeyPairSync } from 'node:crypto';
import type { ApiClient, IdentityKey } from './api-client.js';

export interface PoolIdentity {
  role: string;
  key: IdentityKey;
  /** Hex-encoded public key — the DAGsocial identity string */
  userId: string;
  funded: boolean;
  lastActivityBlock: number;
}

export interface IdentityPool {
  identities: Map<string, PoolIdentity>;
  /** Get an identity by role name */
  get(role: string): PoolIdentity;
  /** All identities in pool order */
  all(): PoolIdentity[];
  /** Faucet-fund all unfunded identities and wait for confirmation */
  fundAll(client: ApiClient, waitBlocks?: number): Promise<void>;
}

function createIdentity(): IdentityKey {
  const kp = generateKeyPairSync('ed25519');
  const keyObject = kp.privateKey;
  const der = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKey = new Uint8Array(der.subarray(der.length - 32));
  const publicKeyHex = Buffer.from(publicKey).toString('hex');
  return { keyObject, publicKey, publicKeyHex };
}

export function createIdentityPool(roles: string[]): IdentityPool {
  const identities = new Map<string, PoolIdentity>();

  for (const role of roles) {
    const key = createIdentity();
    identities.set(role, {
      role,
      key,
      userId: key.publicKeyHex,
      funded: false,
      lastActivityBlock: 0,
    });
  }

  return {
    identities,
    get(role: string): PoolIdentity {
      const id = identities.get(role);
      if (!id) throw new Error(`Identity not found: ${role}`);
      return id;
    },
    all(): PoolIdentity[] {
      return [...identities.values()];
    },
    async fundAll(client: ApiClient, waitBlocks: number = 2): Promise<void> {
      // Faucet identities one at a time, polling for karma confirmation
      // before proceeding. This avoids TX conflicts where multiple faucet
      // calls reference the same unspent system karma box.
      for (const id of identities.values()) {
        if (id.funded) continue;

        let confirmed = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          // Request faucet. The node grants one allocation per identity ever,
          // so a retry after an accepted grant answers 409 — that means the
          // grant is already pending or settled, and we should keep polling
          // for it rather than treat it as a failure.
          try {
            await client.faucet(id.userId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/\b409\b/.test(msg)) throw e;
          }

          // Poll for karma to appear (confirms the TX was mined).
          // Each attempt waits up to 4 block intervals (~8s at 2s blocks).
          for (let poll = 0; poll < 20; poll++) {
            try {
              const k = await client.getKarma(id.userId);
              if (k.total > 0) {
                id.funded = true;
                console.log(`  Faucet: ${id.role} (${id.userId.slice(0, 12)}...) — ${k.total} karma (confirmed in ${poll * 500}ms)`);
                confirmed = true;
                break;
              }
            } catch {
              // getKarma throws 404 if no karma box exists yet — expected during polling
            }
            await new Promise(r => setTimeout(r, 500));
          }
          if (confirmed) break;
          console.warn(`  Faucet: ${id.role} — retry attempt ${attempt + 1}/5`);
          // Wait a block before retrying to let the system box replenish
          await client.waitForBlocks(1);
        }

        if (!confirmed) {
          console.warn(`  Faucet: ${id.role} — FAILED after 5 attempts`);
        }
      }

      // Extra wait for any trailing TXs to settle
      if (waitBlocks > 0) {
        await client.waitForBlocks(waitBlocks);
      }

      // Log final state
      const funded = [...identities.values()].filter(i => i.funded).length;
      console.log(`  Funded: ${funded}/${identities.size} identities`);
    },
  };
}

export function allUserIds(pool: IdentityPool): string[] {
  return pool.all().map(id => id.userId);
}

export function fundedIds(pool: IdentityPool): PoolIdentity[] {
  return pool.all().filter(id => id.funded);
}
