import type { Express, Request, Response } from 'express';
import type { AvlProverHandle } from './avl-prover.js';
import { deserializeAvlValue } from './serialize-box.js';

/**
 * JSON-safe view of an entity's fields: bigint fields (box `value` /
 * `originalValue`, record `likeCarry`) become decimal strings —
 * JSON.stringify throws on bigint.
 */
function jsonSafeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    out[key] = typeof val === 'bigint' ? val.toString() : val;
  }
  return out;
}

/** What a key resolved to, in a form the JSON response can carry. */
interface DecodedValue {
  kind: 'box' | 'record' | null;
  value: Record<string, unknown> | null;
}

/**
 * Decode whatever the key resolved to (Spec G phase D).
 *
 * The tree holds **two** entity kinds and their keys are indistinguishable from
 * outside — a box id and an identity-record key are both 32 bytes of hash
 * output — so a client can, and eventually will, ask for a record key. Until
 * phase D nothing populated records, so the tree provably contained none and
 * decoding every value as a box could not fail; records exist now, and
 * `deserializeBox` throws on the record tag by design. Dispatching on the tag
 * is what turns "ask for the wrong kind of key" from a 500 into an answer.
 *
 * `kind` is reported alongside the value because the caller cannot infer it:
 * they asked with an opaque 32-byte key and the proof verifies the *bytes*
 * either way. An absent key is `kind: null` with a valid exclusion proof, which
 * is a different statement from "present, and not a box".
 */
function decodeValue(id: string, bytes: Uint8Array): DecodedValue {
  const decoded = deserializeAvlValue(bytes);
  if (decoded.kind === 'record') {
    return { kind: 'record', value: jsonSafeFields({ ...decoded.record }) };
  }
  return { kind: 'box', value: jsonSafeFields({ id, ...decoded.box }) };
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

        const decoded: DecodedValue =
          lookupResult.success && lookupResult.value
            ? decodeValue(boxId, lookupResult.value)
            : { kind: null, value: null };

        res.json({
          boxId,
          atHeight: blockHeight,
          stateRoot: Buffer.from(version).toString('hex'),
          proof: Buffer.from(proof).toString('base64'),
          kind: decoded.kind,
          value: decoded.value,
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

      // Decode whatever the key resolved to — box or identity record
      const decoded: DecodedValue =
        lookupResult.success && lookupResult.value
          ? decodeValue(boxId, lookupResult.value)
          : { kind: null, value: null };

      res.json({
        boxId,
        atHeight: blockHeight,
        stateRoot: Buffer.from(version).toString('hex'),
        proof: Buffer.from(proof).toString('base64'),
        kind: decoded.kind,
        value: decoded.value,
      });
    } catch (err) {
      console.error('Proof endpoint error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });
}
