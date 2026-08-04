import type { Express, Request, Response } from 'express';
import type { AnyBox } from '@dagsocial/types';
import type { AvlProverHandle } from './avl-prover.js';
import { deserializeBoxWithId } from './serialize-box.js';

/**
 * JSON-safe view of a box: bigint amount fields (`value`, `originalValue`)
 * become decimal strings — JSON.stringify throws on bigint.
 */
function jsonSafeBox(box: AnyBox): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(box)) {
    out[key] = typeof val === 'bigint' ? val.toString() : val;
  }
  return out;
}

export function registerProofEndpoint(app: Express, handle: AvlProverHandle): void {
  app.get('/api/v1/proof/:boxId', (req: Request, res: Response) => {
    const { boxId } = req.params;
    const atHeight = req.query['atHeight']
      ? parseInt(req.query['atHeight'] as string, 10)
      : null;

    // Validate atHeight if provided
    if (atHeight !== null && (!Number.isInteger(atHeight) || atHeight < 0)) {
      res.status(400).json({ error: 'atHeight must be a non-negative integer' });
      return;
    }

    // Validate boxId: must be 64 hex chars (32 bytes)
    if (!boxId || boxId.length !== 64 || !/^[0-9a-fA-F]+$/.test(boxId)) {
      res.status(400).json({ error: 'boxId must be 64 hex characters' });
      return;
    }

    const boxKey = Buffer.from(boxId, 'hex');

    try {
      // Determine which version to query
      let version: Uint8Array;
      if (atHeight !== null) {
        const v = handle.storage.versionAtOrBeforeHeight(atHeight);
        // Strict height matching: only accept if a checkpoint exists at
        // exactly the requested height.
        if (!v || handle.storage.versionHeight(v) !== atHeight) {
          res.status(404).json({ error: 'height not available' });
          return;
        }
        version = v;
      } else {
        const v = handle.storage.version();
        if (!v) {
          res.status(404).json({ error: 'no state available' });
          return;
        }
        version = v;
      }

      // Get the block height for this version
      const blockHeight = handle.storage.versionHeight(version);
      if (blockHeight === null) {
        res.status(500).json({ error: 'version height lookup failed' });
        return;
      }

      // Save current version so we can restore after
      const currentVersion = handle.prover.digest();
      if (!currentVersion) {
        res.status(500).json({ error: 'prover has no current digest' });
        return;
      }

      // Only rollback if the target version differs from current
      if (Buffer.from(currentVersion).equals(Buffer.from(version))) {
        // Already at the right version — perform lookup and generate proof inline
        const lookupResult = handle.prover.performOneOperation({
          tag: 'Lookup',
          key: boxKey,
        });
        const proof = handle.prover.prover.generateProof();

        let boxData = null;
        if (lookupResult.success && lookupResult.value) {
          boxData = deserializeBoxWithId(boxId, lookupResult.value);
        }

        res.json({
          boxId,
          atHeight: blockHeight,
          stateRoot: Buffer.from(version).toString('hex'),
          proof: Buffer.from(proof).toString('base64'),
          value: boxData ? jsonSafeBox(boxData) : null,
        });
        return;
      }

      // Rollback to historical version
      handle.prover.rollback(version);

      // Perform authenticated lookup (records directions for proof)
      const lookupResult = handle.prover.performOneOperation({
        tag: 'Lookup',
        key: boxKey,
      });

      // Generate proof from inner prover
      const proof = handle.prover.prover.generateProof();

      // Restore current version
      handle.prover.rollback(currentVersion);

      // Deserialize box value if found
      let boxData = null;
      if (lookupResult.success && lookupResult.value) {
        boxData = deserializeBoxWithId(boxId, lookupResult.value);
      }

      res.json({
        boxId,
        atHeight: blockHeight,
        stateRoot: Buffer.from(version).toString('hex'),
        proof: Buffer.from(proof).toString('base64'),
        value: boxData ? jsonSafeBox(boxData) : null,
      });
    } catch (err) {
      console.error('Proof endpoint error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });
}
