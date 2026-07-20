import { Router } from 'express';
import type { KarmaBox, CreditBox, InviteBox, BondBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface UtxoDeps {
  getIdentity(
    userId: string,
  ): { userId: string; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  getCreditBox(owner: Uint8Array): CreditBox | null;
  getPendingInvites(inviterId: string): InviteBox[];
  getBondBoxes(inviterId: string): BondBox[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: UtxoDeps): Router {
  const router = Router();

  // GET /karma/:userId — get karma balance for a user
  router.get('/karma/:userId', (req, res) => {
    const identity = deps.getIdentity(req.params['userId']!);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const karmaBox = deps.getKarmaBox(identity.publicKey);
    if (!karmaBox) {
      res.status(404).json({ error: 'No karma box found' });
      return;
    }

    res.json({
      userId: req.params['userId'],
      balance: karmaBox.value,
      boxId: karmaBox.id,
      createdAtBlock: karmaBox.createdAtBlock,
    });
  });

  // GET /credits/:userId — get credit balance for a user
  router.get('/credits/:userId', (req, res) => {
    const identity = deps.getIdentity(req.params['userId']!);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const creditBox = deps.getCreditBox(identity.publicKey);
    if (!creditBox) {
      res.status(404).json({ error: 'No credit box found' });
      return;
    }

    res.json({
      userId: req.params['userId'],
      balance: creditBox.value,
      boxId: creditBox.id,
    });
  });

  // GET /invites/:userId — get pending invites and bonds for a user
  router.get('/invites/:userId', (req, res) => {
    const userId = req.params['userId']!;
    // invites are looked up by inviterId (userId), identity check is optional
    const pending = deps.getPendingInvites(userId);
    const bonds = deps.getBondBoxes(userId);

    res.json({
      pending: pending.map((inv) => ({
        id: inv.id,
        value: inv.value,
        createdAtBlock: inv.createdAtBlock,
        secretHash: Buffer.from(inv.secretHash).toString('hex'),
        inviterId: inv.inviterId,
        guard: inv.guard,
      })),
      bonds: bonds.map((b) => ({
        id: b.id,
        value: b.value,
        createdAtBlock: b.createdAtBlock,
        inviterId: b.inviterId,
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
