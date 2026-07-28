// packages/node/test/harness/api-client.ts
import { sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  computePostId,
  PROTOCOL_VERSION,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
import {
  hex, unhex, blake32, powInput, solve, signPost,
  signTx, txToApi, postLockTx, likeTx,
} from './crypto-helpers.js';

export interface IdentityKey {
  keyObject: KeyObject;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

export interface KarmaResponse {
  total: number;
  boxes: { boxId: string; value: number }[];
}

export interface StatusResponse {
  currentHeight?: number;
  blockHeight?: number;
  totalKarma?: number;
}

export interface PostResponse {
  status: string;
  postId: string;
}

export interface LikeResponse {
  status: string;
  txId: string;
}

export interface DeleteResponse {
  status: string;
  stumpId: string;
  postId?: string;
  replyCount: number;
}

export interface ChallengeResponse {
  challenge: string;
  targetBits: number;
}

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 3;

export class ApiClient {
  constructor(private baseUrl: string) {}

  private async fetch(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const r = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        return r;
      } catch (e) {
        lastError = e as Error;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
    throw lastError ?? new Error(`fetch ${method} ${path} failed`);
  }

  async get<T = unknown>(path: string): Promise<T> {
    const r = await this.fetch('GET', path);
    const t = await r.text();
    if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${t}`);
    return t ? JSON.parse(t) : {} as T;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const r = await this.fetch('POST', path, body);
    const t = await r.text();
    if (!r.ok) throw new Error(`POST ${path} ${r.status}: ${t}`);
    return t ? JSON.parse(t) : {} as T;
  }

  async del<T = unknown>(path: string, body?: unknown): Promise<T> {
    const r = await this.fetch('DELETE', path, body);
    const t = await r.text();
    if (!r.ok) throw new Error(`DELETE ${path} ${r.status}: ${t}`);
    return t ? JSON.parse(t) : {} as T;
  }

  // -- Simple endpoints --

  async getStatus(): Promise<StatusResponse> {
    return this.get<StatusResponse>('/status');
  }

  async getHeight(): Promise<number> {
    const s = await this.getStatus();
    return s.currentHeight ?? s.blockHeight ?? 0;
  }

  async getKarma(userId: string): Promise<KarmaResponse> {
    return this.get<KarmaResponse>(`/karma/${userId}`);
  }

  async getPost(postId: string): Promise<unknown> {
    return this.get(`/posts/${postId}`);
  }

  async queryPosts(opts?: { limit?: number; offset?: number; author?: string }): Promise<{ posts: unknown[] }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    if (opts?.author) params.set('author', opts.author);
    const qs = params.toString();
    return this.get(`/posts${qs ? '?' + qs : ''}`);
  }

  async getBlock(height: number): Promise<unknown> {
    return this.get(`/blocks/${height}`);
  }

  async requestChallenge(userId: string): Promise<ChallengeResponse> {
    return this.post<ChallengeResponse>('/challenge', { userId });
  }

  // -- Composed multi-step flows --

  async faucet(userId: string): Promise<{ status: string; txId: string }> {
    return this.post('/faucet', { userId });
  }

  async createPost(
    content: string,
    author: IdentityKey,
    parentRefs: string[] = [],
  ): Promise<PostResponse> {
    // 1. Request challenge
    const chal = await this.requestChallenge(author.publicKeyHex);
    const chalBytes = unhex(chal.challenge);
    const ts = Date.now();

    // 2. PoW
    const pi = powInput(content, author.publicKey, parentRefs, chalBytes, ts);
    const nonce = solve(pi, chal.targetBits);

    // 3. Sign post
    const sig = signPost(content, author.publicKey, parentRefs, chalBytes, ts, author.keyObject);

    // 4. Build karma lock tx
    const lockAmount = parentRefs.length > 0 ? POST_LOCK_REPLY_COST : POST_LOCK_THREAD_COST;
    const k = await this.getKarma(author.publicKeyHex);
    // Filter to only spendable karma boxes — post_lock boxes have
    // guard=epoch_tally and can't be spent with owner_signature.
    const spendableBoxes = k.boxes.filter(b => (b as any).boxType === 'karma' || !(b as any).boxType);
    if (spendableBoxes.length === 0) {
      throw new Error(`No spendable karma boxes for ${author.publicKeyHex.slice(0, 12)}...`);
    }
    const lockTx = postLockTx(spendableBoxes, lockAmount, 'pre-compute', author.publicKey);
    // Pre-compute post ID so lockTx can reference it
    const preId = computePostId({
      content,
      author: author.publicKey,
      parentRefs,
      challenge: chalBytes,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: ts,
      powNonce: nonce,
      signature: unhex(sig),
    } as any);
    // Rebuild with correct targetPostId
    const finalLockTx = postLockTx(spendableBoxes, lockAmount, preId, author.publicKey);
    signTx(finalLockTx, author.keyObject, author.publicKeyHex);

    // 5. Submit
    return this.post<PostResponse>('/posts', {
      content,
      author: author.publicKeyHex,
      parentRefs,
      challenge: chal.challenge,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: ts,
      powNonce: nonce,
      signature: sig,
      karmaLockTx: txToApi(finalLockTx),
    });
  }

  async castLike(
    liker: IdentityKey,
    targetPostId: string,
  ): Promise<LikeResponse> {
    const k = await this.getKarma(liker.publicKeyHex);
    // Filter to only spendable karma boxes — post_lock boxes have
    // guard=epoch_tally and can't be spent with owner_signature.
    const karmaBoxes = k.boxes.filter(b => (b as any).boxType === 'karma' || !(b as any).boxType);
    if (karmaBoxes.length === 0) {
      throw new Error(`No spendable karma boxes for ${liker.publicKeyHex.slice(0, 12)}...`);
    }
    const tx = likeTx(karmaBoxes, targetPostId, liker.publicKey);
    signTx(tx, liker.keyObject, liker.publicKeyHex);
    return this.post<LikeResponse>('/likes', { tx: txToApi(tx) });
  }

  async deletePost(
    postId: string,
    author: IdentityKey,
  ): Promise<DeleteResponse> {
    // 1. Request challenge
    const chal = await this.requestChallenge(author.publicKeyHex);
    const chalHash = blake32(unhex(chal.challenge));
    const sig = hex(new Uint8Array(cryptoSign(null, chalHash, author.keyObject)));

    // 2. Delete
    return this.del<DeleteResponse>(`/posts/${postId}`, {
      authorId: author.publicKeyHex,
      challenge: chal.challenge,
      signature: sig,
    });
  }

  async waitForBlocks(count: number, pollMs: number = 2000): Promise<number> {
    const start = await this.getHeight();
    const target = start + count;
    for (let i = 0; i < (count * pollMs / 500) + 10; i++) {
      const h = await this.getHeight();
      if (h >= target) return h;
      await new Promise(r => setTimeout(r, 500));
    }
    const final = await this.getHeight();
    console.warn(`waitForBlocks(${count}) — target ${target} not reached, at ${final}`);
    return final;
  }
}
