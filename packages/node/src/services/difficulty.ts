import { config } from '../config.js';

/**
 * The ordering-block PoW target for a given height.
 *
 * On-chain time is block height, so the difficulty schedule is a pure function
 * of height: two honest nodes compute the same target for the same block, for
 * all time, with no reference to a wall clock. Phase 1 is a fixed target — a
 * hashrate-tracking retarget needs a deterministic on-chain time source (e.g.
 * median-of-header-timestamps with future bounds) and is deferred.
 *
 * The value comes from the shared config singleton rather than a caller-supplied
 * config so the block producer and `applyOrderingBlock` cannot disagree: this is
 * a network-wide consensus parameter, and a block mined against one value is
 * rejected by any node holding another.
 */
export function expectedTarget(_height: number): number {
  return config.orderingBlockPowTargetBits;
}
