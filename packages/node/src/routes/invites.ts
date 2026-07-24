import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import { getNet } from '../services/net-instance.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface InvitesDeps {
  createInvite(
    inviterId: Uint8Array,
    karmaAmount: number,
    bondAmount: number,
    inviterPubKey: Uint8Array,
    signature: Uint8Array,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    inviteBox: { id?: string };
    bondBox: { id?: string };
    secret: Uint8Array;
    secretHash: Uint8Array;
    tx: UtxoTransaction;
  };
  claimInvite(
    inviteBoxId: string,
    secret: Uint8Array,
    publicKey: Uint8Array,
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
    inviteBoxId: string,
    inviterId: Uint8Array,
    signature: Uint8Array,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    tx: UtxoTransaction;
  };
  getIdentity(
    userId: Uint8Array,
  ): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: InvitesDeps): Router {
  const router = Router();

  // POST /invites — create a new invite
  router.post('/', (req, res) => {
    const body = req.body as {
      inviterId?: string;
      karmaAmount?: number;
      bondAmount?: number;
      signature?: string;
    };

    if (
      !body.inviterId ||
      body.karmaAmount === undefined ||
      body.bondAmount === undefined ||
      !body.signature
    ) {
      res
        .status(400)
        .json({ error: 'inviterId, karmaAmount, bondAmount, and signature required' });
      return;
    }

    // Decode inviterId from hex
    let inviterIdBytes: Uint8Array;
    try {
      inviterIdBytes = new Uint8Array(Buffer.from(body.inviterId, 'hex'));
    } catch {
      res.status(400).json({ error: 'inviterId must be a hex string' });
      return;
    }
    if (inviterIdBytes.length !== 32) {
      res.status(400).json({ error: 'inviterId must be 32 bytes (64 hex chars)' });
      return;
    }

    // Look up inviter's public key from identity
    const identity = deps.getIdentity(inviterIdBytes);
    if (!identity) {
      res.status(400).json({ error: 'Inviter identity not found' });
      return;
    }

    // Decode signature
    let signature: Uint8Array;
    try {
      signature = new Uint8Array(Buffer.from(body.signature, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex signature' });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.createInvite(
        inviterIdBytes,
        body.karmaAmount,
        body.bondAmount,
        identity.publicKey,
        signature,
        currentHeight,
      );

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
        secret: Buffer.from(result.secret).toString('hex'),
        secretHash: Buffer.from(result.secretHash).toString('hex'),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /invites/claim — claim an invite with the preimage secret
  router.post('/claim', (req, res) => {
    const body = req.body as {
      inviteBoxId?: string;
      secret?: string;
      publicKey?: string;
    };

    if (!body.inviteBoxId || !body.secret || !body.publicKey) {
      res
        .status(400)
        .json({ error: 'inviteBoxId, secret, and publicKey required' });
      return;
    }

    let secret: Uint8Array;
    let publicKey: Uint8Array;
    try {
      secret = new Uint8Array(Buffer.from(body.secret, 'hex'));
      publicKey = new Uint8Array(Buffer.from(body.publicKey, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex encoding' });
      return;
    }

    if (publicKey.length !== 32) {
      res.status(400).json({ error: 'publicKey must be 32 bytes' });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.claimInvite(
        body.inviteBoxId,
        secret,
        publicKey,
        currentHeight,
      );

      // Broadcast invite claim tx to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast invite claim tx: ${err.message}`);
        });
      }

      const { tx: _tx, status: _status, ...rest } = result;
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
    const body = req.body as {
      inviteBoxId?: string;
      inviterId?: string;
      signature?: string;
    };

    if (!body.inviteBoxId || !body.inviterId || !body.signature) {
      res
        .status(400)
        .json({ error: 'inviteBoxId, inviterId, and signature required' });
      return;
    }

    // Decode inviterId from hex
    let inviterIdBytes: Uint8Array;
    try {
      inviterIdBytes = new Uint8Array(Buffer.from(body.inviterId, 'hex'));
    } catch {
      res.status(400).json({ error: 'inviterId must be a hex string' });
      return;
    }

    let signature: Uint8Array;
    try {
      signature = new Uint8Array(Buffer.from(body.signature, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex signature' });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.cancelInvite(
        body.inviteBoxId,
        inviterIdBytes,
        signature,
        currentHeight,
      );

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
