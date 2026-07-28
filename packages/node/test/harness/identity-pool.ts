// packages/node/test/harness/identity-pool.ts
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
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
      // Faucet all unfunded identities
      for (const id of identities.values()) {
        if (id.funded) continue;
        await client.faucet(id.userId);
        console.log(`  Faucet: ${id.role} (${id.userId.slice(0, 12)}...)`);
      }
      // Wait for confirmation
      if (waitBlocks > 0) {
        await client.waitForBlocks(waitBlocks);
      }
      // Verify all funded
      for (const id of identities.values()) {
        if (id.funded) continue;
        const k = await client.getKarma(id.userId);
        if (k.total > 0) {
          id.funded = true;
          console.log(`  ${id.role}: ${k.total} karma`);
        } else {
          console.warn(`  ${id.role}: karma still 0 after faucet + ${waitBlocks} blocks`);
        }
      }
    },
  };
}

export function allUserIds(pool: IdentityPool): string[] {
  return pool.all().map(id => id.userId);
}

export function fundedIds(pool: IdentityPool): PoolIdentity[] {
  return pool.all().filter(id => id.funded);
}
