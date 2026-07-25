export { initDb, getDb, closeDb } from './db.js';
export { insertIdentity, getIdentity } from './identities.js';
export {
  createChallenge,
  getActiveChallenge,
  consumeChallenge,
} from './challenges.js';
export {
  insertPost,
  getPost,
  queryPosts,
  getPendingPosts,
  confirmPost,
  unconfirmPost,
  getParentRefs,
  getSubtree,
  pruneSubtree,
} from './posts.js';

export {
  getBox,
  getUnspentBoxes,
  getKarmaBox,
  getCreditBox,
  getPendingInvites,
  getPendingInviteCount,
  getBondBoxes,
  getUnspentLikeForLiker,
  getLockedLikeBoxes,
  getUnprocessedLockedLikeBoxes,
  getUnspentPostLockBoxes,
  getPostTotalLikes,
  insertBox,
  consumeBox,
  unconsumeBox,
  deleteBox,
  markLikeBoxesTallied,
} from './utxo.js';

export {
  insertLike,
  hasLiked,
  getLikeCount,
  getFreeLike,
  deleteFreeLike,
  getUnprocessedFreeLikes,
  markFreeLikesProcessed,
} from './likes.js';

export {
  createOrderingBlock,
  getOrderingBlock,
  getCurrentHeight,
  deleteOrderingBlock,
} from './ordering.js';

export {
  insertBlockJournal,
  getBlockJournal,
  deleteBlockJournal,
  purgeOldJournals,
} from './journal.js';

export {
  insertStump,
  getStump,
} from './stumps.js';

export {
  insertSubBlock as insertMempoolSubBlock,
  insertUtxoTx,
  getPendingEntries,
  purgeExpired,
  removeEntry,
  removeBatch,
} from './mempool.js';
export type { PoolEntry } from './mempool.js';

export {
  getSystemKeypair,
  initSystemKeypair,
  ensureSystemKarmaBox,
  signWithSystemKey,
} from './system.js';
export type { SystemKeypair } from './system.js';
