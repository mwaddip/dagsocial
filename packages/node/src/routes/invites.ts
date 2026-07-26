import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface InvitesDeps extends UtxoEngineDeps {
  createInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    inviteBox: { id?: string; secretHash: Uint8Array };
    bondBox: { id?: string };
    tx: UtxoTransaction;
  };
  claimInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    userId: Uint8Array;
    karmaBoxId: string;
    tx: UtxoTransaction;
  };
  cancelInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    tx: UtxoTransaction;
  };
  commitInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    bondBoxId: string;
    tx: UtxoTransaction;
  };
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: InvitesDeps): Router {
  const router = Router();

  // POST /invites — create a new invite
  router.post('/', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.createInvite(deps, tx, currentHeight);

      // Broadcast invite create tx to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast invite create tx: ${err.message}`);
        });
      }

      res.status(201).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
        inviteBoxId: result.inviteBox.id,
        bondBoxId: result.bondBox.id,
        secretHash: Buffer.from(result.inviteBox.secretHash).toString('hex'),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /invites/commit — commit to an invite (bind invitee identity to BondBox)
  router.post('/commit', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.commitInvite(deps, tx, currentHeight);

      // Broadcast commit tx to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast commit tx: ${err.message}`);
        });
      }

      res.status(201).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
        bondBoxId: result.bondBoxId,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('already committed')) {
        res.status(409).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // POST /invites/claim — claim an invite with the preimage secret
  router.post('/claim', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.claimInvite(deps, tx, currentHeight);

      // Broadcast invite claim tx to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast invite claim tx: ${err.message}`);
        });
      }

      res.status(201).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
        userId: Buffer.from(result.userId).toString('hex'),
        karmaBoxId: result.karmaBoxId,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /invites/cancel — cancel an unclaimed invite
  router.post('/cancel', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.cancelInvite(deps, tx, currentHeight);

      // Broadcast invite cancel tx to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast invite cancel tx: ${err.message}`);
        });
      }

      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Inviter mismatch')) {
        res.status(403).json({ error: msg });
      } else if (
        msg.includes('already claimed') ||
        msg.includes('already spent')
      ) {
        res.status(400).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  return router;
}
