import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import {
  getVouchesForTarget,
  getVouchesByVoucher,
  getVouchCooldowns,
} from '../store/index.js';

export interface VouchesDeps extends UtxoEngineDeps {
  castVouch(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction };
  initiateUnvouch(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    karmaReturnsAtBlock: number;
    tx: UtxoTransaction;
  };
  getCurrentHeight(): number;
}

export function createRouter(deps: VouchesDeps): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };
    if (!body.tx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }
    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      respondError(res, err, 'POST /vouches (tx decode)');
      return;
    }
    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.castVouch(deps, tx, currentHeight);
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast vouch tx: ${err.message}`);
        });
      }
      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err) {
      respondError(res, err, 'POST /vouches');
    }
  });

  router.delete('/:targetId', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };
    if (!body.tx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }
    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      respondError(res, err, 'DELETE /vouches/:targetId (tx decode)');
      return;
    }
    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.initiateUnvouch(deps, tx, currentHeight);
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast unvouch tx: ${err.message}`);
        });
      }
      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
        karmaReturnsAtBlock: result.karmaReturnsAtBlock,
      });
    } catch (err) {
      respondError(res, err, 'DELETE /vouches/:targetId');
    }
  });

  router.get('/', (req, res) => {
    const target = req.query.target as string | undefined;
    const voucher = req.query.voucher as string | undefined;
    const cooldownsParam = req.query.cooldowns as string | undefined;

    if (cooldownsParam !== undefined && voucher) {
      const voucherBytes = new Uint8Array(Buffer.from(voucher, 'hex'));
      const cooldowns = getVouchCooldowns(voucherBytes);
      res.status(200).json({
        cooldowns: cooldowns.map((c) => ({
          targetId: Buffer.from(c.targetId).toString('hex'),
          releaseAtBlock: c.releaseAtBlock,
        })),
      });
      return;
    }

    if (target) {
      const targetBytes = new Uint8Array(Buffer.from(target, 'hex'));
      const vouches = getVouchesForTarget(targetBytes);
      res.status(200).json({
        vouches: vouches.map((v) => ({
          voucherId: Buffer.from(v.voucherId).toString('hex'),
          targetId: Buffer.from(v.targetId).toString('hex'),
        })),
        count: vouches.length,
      });
      return;
    }

    if (voucher) {
      const voucherBytes = new Uint8Array(Buffer.from(voucher, 'hex'));
      const vouches = getVouchesByVoucher(voucherBytes);
      res.status(200).json({
        vouches: vouches.map((v) => ({
          // The VouchBox's id. An unvouch spends a NAMED box, and no read
          // surface exposed one — so a client could hold an active vouch and
          // still be unable to build the transaction that ends it. Available
          // without a join: `getVouchesByVoucher` already resolves each row
          // through `getBox`, and `rowToBox` sets `id` on every box it builds
          // (the "every stored box has an id" invariant), so the assertion is
          // on the store's guarantee, not on hope.
          boxId: v.id!,
          voucherId: Buffer.from(v.voucherId).toString('hex'),
          targetId: Buffer.from(v.targetId).toString('hex'),
        })),
        count: vouches.length,
      });
      return;
    }

    res.status(400).json({
      error: 400,
      reason: 'Provide ?target=<hex> or ?voucher=<hex> or ?voucher=<hex>&cooldowns=1',
    });
  });

  return router;
}
