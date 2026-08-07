export { initDb, getDb, closeDb } from './db.js';
export {
  createChallenge,
  getActiveChallenge,
  consumeChallenge,
} from './challenges.js';
export {
  insertPost,
  getPost,
  getPostRaw,
  queryPosts,
  getPendingPosts,
  confirmPost,
  unconfirmPost,
  getParentRefs,
  getAncestors,
  getSubtree,
  pruneSubtree,
  insertPostPlaceholder,
} from './posts.js';

export {
  getBox,
  getBoxByProvenance,
  getKarmaBox,
  getKarmaBoxes,
  getKarmaValue,
  getCreditBox,
  getCreditBoxes,
  getUnlockedCreditBoxes,
  getPendingInvites,
  getPendingInviteCount,
  getBondBoxes,
  getLockedLikeBoxes,
  getUnprocessedLockedLikeBoxes,
  getUnspentPostLockBoxes,
  getPostLockBox,
  getPostTotalLikes,
  getUnspentLikeBoxes,
  getLikersForPost,
  getUnspentBoxes,
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
  getUnprocessedFreeLikes,
  markFreeLikesProcessed,
  markFreeLikesUnprocessed,
  insertLikeRecord,
  hasLikeRecord,
  getLikeRecordCount,
  deleteLikeRecordsForPosts,
  deleteLikeRecord,
  restoreLikeRecord,
} from './likes.js';

export {
  createOrderingBlock,
  getOrderingBlock,
  getCurrentHeight,
  deleteOrderingBlock,
} from './ordering.js';

export {
  beginBlockJournal,
  finishBlockJournal,
  abortBlockJournal,
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
  insertBlockTopology,
  getSubtreeTopology,
  getTopologyAuthor,
  rollbackBlockTopology,
} from './topology.js';

export {
  insertSubBlock as insertMempoolSubBlock,
  insertUtxoTx,
  insertMempoolPrune,
  getPendingEntries,
  purgeExpired,
  removeEntry,
  removeSubBlockEntries,
  drainMempoolPrunes,
  removeMempoolPrunes,
  hasPendingLike,
  countPendingInvites,
  hasPendingVouch,
  MempoolFullError,
} from './mempool.js';
export type { PoolEntry } from './mempool.js';

export {
  getSystemKeypair,
  initSystemKeypair,
  ensureSystemKarmaBox,
  ensureFaucetCreditBox,
  signWithSystemKey,
} from './system.js';
export type { SystemKeypair } from './system.js';

export type { PostStore, StoreEntry } from './post-store.js';
export { SqlitePostStore } from './sqlite-store.js';

export { loadAllPeers, putPeer, deletePeer, peerStorage } from './peers.js';

export { metaGet, metaPut, metaDelete, metaHas } from './meta.js';

export {
  insertVouchCooldown,
  getVouchCooldowns,
  getMaturedVouchCooldowns,
  deleteVouchCooldown,
  hasActiveVouchCooldown,
} from './vouch-cooldowns.js';

export {
  getVouchBox,
  getVouchesForTarget,
  getVouchesByVoucher,
  hasAnyActiveVouch,
} from './vouch-queries.js';

export {
  getIdentityRecord,
  putIdentityRecord,
  deleteIdentityRecord,
} from './identity-records.js';
export type { IdentityRecord } from './identity-records.js';
