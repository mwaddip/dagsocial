import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPrivateKey } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  generateKeyPair,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { BondBox, InviteBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertBox, getBox } from '../../src/store/utxo.js';
import { createInvite } from '../../src/services/invites.js';
import { validateTx, materializeOutput } from '../../src/services/utxo-engine.js';
import { signTransaction } from '../helpers.js';

/**
 * Spec G phase C4 — the invite flow's *predicted* box ids.
 *
 * This is the flow that parked `p3a-box-id-parked` (Spec G §1 defect 3): the
 * client is handed an InviteBox id before the box exists, bakes it into
 * `bond.inviteBoxId`, and `utxo-engine.ts` dereferences it on-chain at bond
 * commit. If the service predicts a different id than block application
 * materializes, the bond dangles — and it fails as a missing box at commit
 * time, not as a visible error at prediction time.
 *
 * The invite output sits at index **1** of `tx.outputs` (karma, invite, bond),
 * so this also pins that positions come from the output's real position rather
 * than from a per-box counter or a hardcoded 0.
 */

describe('invite id prediction carries transaction provenance', () => {
  let inviter: ReturnType<typeof generateKeyPair>;
  let inviterId: Uint8Array;
  let inviterPrivKeyObj: ReturnType<typeof createPrivateKey>;
  const HEIGHT = 50;

  beforeEach(() => {
    initDb(':memory:');
    inviter = generateKeyPair();
    inviterId = inviter.publicKey;
    inviterPrivKeyObj = createPrivateKey({
      key: Buffer.from(inviter.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
  });

  afterEach(() => {
    closeDb();
  });

  /** A valid invite tx: consumes one KarmaBox, produces karma + invite + bond. */
  function buildInviteTx(): UtxoTransaction {
    const karma: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 1,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'seed',
      lastTouchBlock: 1,
    };
    karma.id = computeBoxId(karma);
    insertBox(karma);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA,
      createdAtBlock: 1,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'create-invite',
      lastTouchBlock: 1,
    };
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 1,
      secretHash: new Uint8Array(32).fill(0x99),
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteBoxId: computeBoxId(inviteBox),
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...inviteBox, id: computeBoxId(inviteBox) },
        { ...bondBox, id: computeBoxId(bondBox) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKeyObj, Buffer.from(inviterId).toString('hex'));
    return tx;
  }

  const deps = () => ({
    getBox,
    insertBox,
    consumeBox: () => {},
    getKarmaBox: () => null,
    runInTransaction: (fn: () => void) => fn(),
  });

  it('predicts ids at the outputs real positions, not from a counter', () => {
    const tx = buildInviteTx();
    const result = createInvite(deps() as never, tx, HEIGHT);

    expect(result.inviteBox.txId).toBe(result.txId);
    expect(result.bondBox.txId).toBe(result.txId);
    // karma=0, invite=1, bond=2 — a hardcoded 0 or a per-box counter would
    // disagree with the position block application uses.
    expect(result.inviteBox.index).toBe(1);
    expect(result.bondBox.index).toBe(2);
  });

  it('predicts exactly what the apply path materializes for the same tx', () => {
    const tx = buildInviteTx();
    const result = createInvite(deps() as never, tx, HEIGHT);

    // The engine's own materialization of the same transaction — the path block
    // application takes. One shared rule, so these cannot drift.
    const applied = validateTx(deps() as never, tx, HEIGHT);
    expect(applied.valid).toBe(true);

    expect(applied.txId).toBe(result.txId);

    // Compare the whole provenance, not just the id. During the migration
    // window `computeBoxId` still strips `txId`/`index`, so an id-only
    // comparison passes for ANY index and would be vacuous here — it only
    // starts biting at phase G, which is too late to learn that the prediction
    // and the apply path disagree.
    for (const [predicted, materialized] of [
      [result.inviteBox, applied.computedOutputs![1]!],
      [result.bondBox, applied.computedOutputs![2]!],
    ] as const) {
      expect(predicted.txId).toBe(materialized.txId);
      expect(predicted.index).toBe(materialized.index);
      expect(predicted.id).toBe(materialized.id);
    }
  });

  it('the txId is derived from candidates, so provenance cannot feed into it', () => {
    const tx = buildInviteTx();
    const result = createInvite(deps() as never, tx, HEIGHT);

    // `computeTxId` over the bare transaction equals the id stamped onto the
    // outputs. If a builder attached provenance before computing the txId, the
    // two would still agree — `canonicalBoxBytes` strips it — which is exactly
    // why the ordering has to be pinned rather than trusted to fail loudly.
    expect(computeTxId(tx)).toBe(result.txId);
    const rematerialized = materializeOutput(tx.outputs[1]!, result.txId, 1);
    expect(rematerialized.id).toBe(result.inviteBox.id);
  });
});
