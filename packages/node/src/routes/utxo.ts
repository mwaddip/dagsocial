import { Router, Response } from 'express';
import type { KarmaBox, CreditBox, InviteBox, BondBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface UtxoDeps {
  getIdentity(
    userId: Uint8Array,
  ): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  getCreditBox(owner: Uint8Array): CreditBox | null;
  getPendingInvites(inviterId: Uint8Array): InviteBox[];
  getBondBoxes(inviterId: Uint8Array): BondBox[];
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
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const identity = deps.getIdentity(userIdBytes);
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
