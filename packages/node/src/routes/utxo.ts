import { Router, Response } from 'express';
import {
  selectBoxes,
  computeBoxId,
  computeTxId,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { KarmaBox, CreditBox, InviteBox, BondBox, UtxoTransaction } from '@dagsocial/types';
import { sendCredits } from '../services/credits.js';
import { validateTx } from '../services/utxo-engine.js';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { insertUtxoTx } from '../store/mempool.js';
import { getUnlockedCreditBoxes } from '../store/utxo.js';
import {
  getSystemKeypair,
  signWithSystemKey,
  ensureFaucetCreditBox,
} from '../store/system.js';
import { getNet } from '../services/net-instance.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface UtxoDeps {
  getIdentity(
    userId: Uint8Array,
  ): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  getKarmaBoxes(owner: Uint8Array): KarmaBox[];
  getCreditBox(owner: Uint8Array): CreditBox | null;
  getCreditBoxes(owner: Uint8Array): CreditBox[];
  getPendingInvites(inviterId: Uint8Array): InviteBox[];
  getBondBoxes(inviterId: Uint8Array): BondBox[];
  getCurrentHeight(): number;
  getUtxoEngineDeps(): UtxoEngineDeps;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: UtxoDeps): Router {
  const router = Router();

  // Helper: parse hex userId from URL param, return Uint8Array
  function parseUserId(param: string, res: Response): Uint8Array | null {
    if (!param || typeof param !== 'string' || param.length !== 64) {
      res.status(400).json({ error: 'userId must be a 64-character hex string' });
      return null;
    }
    try {
      return new Uint8Array(Buffer.from(param, 'hex'));
    } catch {
      res.status(400).json({ error: 'userId must be a hex string' });
      return null;
    }
  }

  // GET /karma/:userId — get karma balance for a user
  router.get('/karma/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const identity = deps.getIdentity(userIdBytes);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const karmaBoxes = deps.getKarmaBoxes(identity.publicKey);
    if (karmaBoxes.length === 0) {
      res.status(404).json({ error: 'No karma box found' });
      return;
    }

    const total = karmaBoxes.reduce((sum, b) => sum + b.value, 0);
    const boxes = karmaBoxes.map(b => ({
      boxId: b.id!,
      value: b.value,
    }));

    res.json({
      userId: req.params['userId'],
      total,
      boxes,
    });
  });

  // GET /credits/:userId — get credit balance for a user (multi-box)
  router.get('/credits/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const identity = deps.getIdentity(userIdBytes);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const creditBoxes = deps.getCreditBoxes(identity.publicKey);
    if (creditBoxes.length === 0) {
      res.status(404).json({ error: 'No credit box found' });
      return;
    }

    const total = creditBoxes.reduce((sum, b) => sum + b.value, 0);
    const boxes = creditBoxes.map(b => ({
      boxId: b.id!,
      value: b.value,
      ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
    }));

    res.json({
      userId: req.params['userId'],
      total,
      boxes,
    });
  });

  // POST /credits/transfer — transfer credits to another identity
  router.post('/credits/transfer', (req, res) => {
    const body = req.body as {
      from?: string;
      to?: string;
      amount?: number;
      signature?: string;
    };

    if (!body.from || typeof body.from !== 'string' || body.from.length !== 64) {
      res.status(400).json({ error: 'from must be a 64-character hex string' });
      return;
    }
    if (!body.to || typeof body.to !== 'string' || body.to.length !== 64) {
      res.status(400).json({ error: 'to must be a 64-character hex string' });
      return;
    }
    if (!body.amount || typeof body.amount !== 'number' || body.amount < 1) {
      res.status(400).json({ error: 'amount must be a positive integer' });
      return;
    }
    if (!body.signature || typeof body.signature !== 'string') {
      res.status(400).json({ error: 'signature required (base64)' });
      return;
    }

    let fromBytes: Uint8Array;
    let toBytes: Uint8Array;
    let sigBytes: Uint8Array;
    try {
      fromBytes = new Uint8Array(Buffer.from(body.from, 'hex'));
      toBytes = new Uint8Array(Buffer.from(body.to, 'hex'));
      sigBytes = new Uint8Array(Buffer.from(body.signature, 'base64'));
    } catch {
      res.status(400).json({ error: 'invalid encoding' });
      return;
    }

    if (!deps.getIdentity(fromBytes)) {
      res.status(404).json({ error: 'Sender identity not found' });
      return;
    }
    if (!deps.getIdentity(toBytes)) {
      res.status(404).json({ error: 'Recipient identity not found' });
      return;
    }

    const currentHeight = deps.getCurrentHeight();

    try {
      const result = sendCredits(fromBytes, toBytes, body.amount, sigBytes, currentHeight);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'transfer failed';
      if (msg === 'invalid signature') {
        res.status(401).json({ error: msg });
      } else if (msg.includes('Insufficient')) {
        res.status(400).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // POST /credits/faucet — testnet-only credit faucet
  router.post('/credits/faucet', (req, res) => {
    if (config.networkMode !== 'testnet') {
      res.status(403).json({ error: 'faucet disabled in production mode' });
      return;
    }

    const body = req.body as { to?: string };

    if (!body.to || typeof body.to !== 'string' || body.to.length !== 64) {
      res.status(400).json({ error: 'to must be a 64-character hex string' });
      return;
    }

    let toBytes: Uint8Array;
    try {
      toBytes = new Uint8Array(Buffer.from(body.to, 'hex'));
    } catch {
      res.status(400).json({ error: 'invalid to encoding' });
      return;
    }

    if (!deps.getIdentity(toBytes)) {
      res.status(404).json({ error: 'Recipient identity not found' });
      return;
    }

    const currentHeight = deps.getCurrentHeight();
    const sysKeypair = getSystemKeypair();
    if (!sysKeypair) {
      res.status(500).json({ error: 'Faucet keypair not initialized' });
      return;
    }

    ensureFaucetCreditBox(sysKeypair.publicKey, currentHeight);

    const FAUCET_AMOUNT = 1000;
    const unlocked = getUnlockedCreditBoxes(sysKeypair.publicKey, currentHeight);
    const selected = selectBoxes(unlocked, FAUCET_AMOUNT);
    const totalSelected = selected.reduce((s, b) => s + b.value, 0);
    const change = totalSelected - FAUCET_AMOUNT;

    const outputs: CreditBox[] = [{
      boxType: 'credit',
      value: FAUCET_AMOUNT,
      createdAtBlock: currentHeight,
      owner: toBytes,
      guard: 'owner_signature',
      proofSource: -1,
    }];
    if (change > 0) {
      outputs.push({
        boxType: 'credit',
        value: change,
        createdAtBlock: currentHeight,
        owner: sysKeypair.publicKey,
        guard: 'owner_signature',
        proofSource: -1,
      });
    }

    const tx: UtxoTransaction = {
      inputs: selected.map(b => b.id!),
      outputs: outputs.map(b => ({ ...b, id: computeBoxId(b) })),
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const txId = computeTxId(tx);
    const sysPubKeyHex = Buffer.from(sysKeypair.publicKey).toString('hex');
    const sig = signWithSystemKey(txId, sysKeypair.secretKey);
    tx.signatures[sysPubKeyHex] = sig;

    // Validate via UTXO engine
    const engineDeps = deps.getUtxoEngineDeps();
    const validation = validateTx(engineDeps, tx, currentHeight);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Insert into mempool
    const expiresAtHeight = currentHeight + 720;
    insertUtxoTx(tx, null, expiresAtHeight);

    // Broadcast (best-effort)
    try {
      const net = getNet();
      if (net) {
        net.broadcastTx(tx).catch((err: Error) => {
          console.warn(`Failed to broadcast credit faucet tx: ${err.message}`);
        });
      }
    } catch { /* net not available */ }

    res.json({ txId, amount: FAUCET_AMOUNT });
  });

  // GET /invites/:userId — get pending invites and bonds for a user
  router.get('/invites/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const pending = deps.getPendingInvites(userIdBytes);
    const bonds = deps.getBondBoxes(userIdBytes);

    res.json({
      pending: pending.map((inv) => ({
        id: inv.id,
        value: inv.value,
        createdAtBlock: inv.createdAtBlock,
        secretHash: Buffer.from(inv.secretHash).toString('hex'),
        inviterId: Buffer.from(inv.inviterId).toString('hex'),
        guard: inv.guard,
      })),
      bonds: bonds.map((b) => ({
        id: b.id,
        value: b.value,
        createdAtBlock: b.createdAtBlock,
        inviterId: Buffer.from(b.inviterId).toString('hex'),
        inviteePublicKey:
          b.inviteePublicKey.length > 0
            ? Buffer.from(b.inviteePublicKey).toString('hex')
            : null,
        probationStartBlock:
          b.probationStartBlock > 0 ? b.probationStartBlock : null,
        probationEndBlock:
          b.probationEndBlock > 0 ? b.probationEndBlock : null,
        guard: b.guard,
      })),
    });
  });

  return router;
}
