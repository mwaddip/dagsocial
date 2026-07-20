import { Router } from 'express';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface InvitesDeps {
  createInvite(
    inviterId: string,
    karmaAmount: number,
    bondAmount: number,
    inviterPubKey: Uint8Array,
    signature: Uint8Array,
    currentBlockHeight: number,
  ): {
    inviteBox: { id: string };
    bondBox: { id: string };
    secret: Uint8Array;
    secretHash: Uint8Array;
  };
  claimInvite(
    inviteBoxId: string,
    secret: Uint8Array,
    publicKey: Uint8Array,
    currentBlockHeight: number,
  ): { userId: string; karmaBoxId: string };
  cancelInvite(
    inviteBoxId: string,
    inviterId: string,
    signature: Uint8Array,
    currentBlockHeight: number,
  ): void;
  getIdentity(
    userId: string,
  ): { userId: string; publicKey: Uint8Array; createdAt: number } | null;
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

    // Look up inviter's public key from identity
    const identity = deps.getIdentity(body.inviterId);
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
        body.inviterId,
        body.karmaAmount,
        body.bondAmount,
        identity.publicKey,
        signature,
        currentHeight,
      );
      res.status(201).json({
        inviteBoxId: result.inviteBox.id,
        bondBoxId: result.bondBox.id,
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
      res.status(201).json(result);
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

    let signature: Uint8Array;
    try {
      signature = new Uint8Array(Buffer.from(body.signature, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex signature' });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      deps.cancelInvite(
        body.inviteBoxId,
        body.inviterId,
        signature,
        currentHeight,
      );
      // cancelInvite returns void; we need the new karma box ID for the response
      res.status(200).json({ success: true });
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
