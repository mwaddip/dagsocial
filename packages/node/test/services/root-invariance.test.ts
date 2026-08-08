import { describe, it, expect } from 'vitest';
import type { SubBlockTree, UtxoTxTree } from '@dagsocial/types';
import {
  computeSubBlockRoot,
  computeUtxoTxRoot,
} from '../../src/services/block-creator.js';

// ---------------------------------------------------------------------------
// P2-D N3a root invariance — the empty-list proof.
//
// N3a deletes the `leafHash('likebox', …)` and `leafHash('epoch', …)` arms
// from computeUtxoTxRoot along with the epoch machinery. Post-N1 every
// produced block carries `likeBoxIds: []` and no `epochTallyResults`, so
// neither arm ever contributed a leaf — deleting them must not move a single
// root byte, or every existing chain forks at resync.
//
// The constants below were captured from the PRE-deletion
// computeUtxoTxRoot/computeSubBlockRoot (commit 8e75122, before the arm
// deletions) and this test ran green against that code first. It running
// green after the deletions is the two-sided pin: same fixture, same bytes,
// before and after.
//
// Fixtures are fully deterministic — fixed hex ids, fixed owner bytes, a
// bigint value serialized canonically — so the pinned hex is stable across
// runs and machines.
// ---------------------------------------------------------------------------

const FIXED_OWNER = new Uint8Array(32).fill(7);

const utxoFixture: UtxoTxTree = {
  utxoTxIds: ['ab'.repeat(32), 'cd'.repeat(32)],
  utxoTxs: [], // carried CBOR is not part of the root
  likeBoxIds: [], // the post-N1 constant — required by the type until T2
  coinbaseOutputs: [
    {
      owner: FIXED_OWNER,
      value: 42n,
      lockedUntilBlock: 721,
      isTreasury: false,
    },
  ],
  // no epochTallyResults — the post-N1 constant
};

const subBlockFixture: SubBlockTree = {
  subBlockRefs: ['aa'.repeat(32)],
  subBlockEntries: [
    {
      postId: 'aa'.repeat(32),
      parentRefs: ['bb'.repeat(32)],
      author: 'cc'.repeat(32),
    },
  ],
  pruneEntries: [],
};

const PINNED_UTXO_TX_ROOT =
  '8ecb0e6de230bb762f65c5029572533fe55327fbf499038f9b5c98860cdce520';
const PINNED_SUB_BLOCK_ROOT =
  '49d3958c701a62cb6eb42293ae9852b4d21a578e92f4738bbf8dafd13d5cfe3c';

describe('N3a root invariance (pre/post epoch-arm deletion)', () => {
  it('utxoTxRoot over a likeBoxIds:[] / no-tally tree is byte-identical to the pre-deletion root', () => {
    expect(computeUtxoTxRoot(utxoFixture)).toBe(PINNED_UTXO_TX_ROOT);
  });

  it('subBlockRoot is byte-identical to the pre-deletion root', () => {
    expect(computeSubBlockRoot(subBlockFixture)).toBe(PINNED_SUB_BLOCK_ROOT);
  });
});
