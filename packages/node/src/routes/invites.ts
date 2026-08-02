import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';

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
      respondError(res, err, 'POST /invites (tx decode)', 'message');
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
      respondError(res, err, 'POST /invites', 'message');
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
      respondError(res, err, 'POST /invites/commit (tx decode)', 'message');
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
      // 409 for an already-committed BondBox now rides on the typed error's
      // statusCode — no message sniffing (audit L-12).
      respondError(res, err, 'POST /invites/commit', 'message');
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
      respondError(res, err, 'POST /invites/claim (tx decode)', 'message');
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
      respondError(res, err, 'POST /invites/claim', 'message');
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
      respondError(res, err, 'POST /invites/cancel (tx decode)', 'message');
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
      // 403 for an inviter mismatch now rides on the typed error's statusCode;
      // the 'already claimed' / 'already spent' branches were both 400, the
      // same as the fallback (audit L-12).
      respondError(res, err, 'POST /invites/cancel', 'message');
    }
  });

  return router;
}
