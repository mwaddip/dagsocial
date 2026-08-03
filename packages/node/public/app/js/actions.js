/**
 * actions.js — every write this UI makes to the chain.
 *
 * Each function performs the same sequence the demo UI does: build the
 * transaction locally, sign it with the active identity's key, and submit it.
 * Nothing is faked or optimistically invented — a like that the node rejects
 * stays un-liked, and the caller gets the node's own reason.
 *
 * Views never touch `chain.js` or `api.js` directly; they call these.
 */
import * as api from './api.js';
import * as chain from './chain.js';
import * as identity from './identity.js';
import * as store from './store.js';

/** Thrown for user-correctable problems (no karma, post too long, …). */
export class ActionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionError';
  }
}

function requireIdentity() {
  const userId = identity.userId();
  const privKey = identity.privateKey();
  const pubKeyBytes = identity.pubKeyBytes();
  if (!userId || !privKey) throw new ActionError('No active account.');
  return { userId, privKey, pubKeyBytes };
}

/**
 * Sign a tx with the active identity and attach the signature under its public
 * key, which is the shape every tx endpoint expects.
 */
async function sign(tx, userId, privKey) {
  const { txId, signature } = await chain.signTxId(tx, privKey);
  tx.signatures[userId] = signature;
  return txId;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Publish a post: request a challenge, mine the PoW, sign, lock karma, submit.
 *
 * @param {string} content        1–300 UTF-8 bytes
 * @param {string[]} parentRefs   0–8 parent post ids (a reply or a quote)
 * @param {(stage: string) => void} [onProgress]
 * @returns {Promise<{ postId: string, status: string, txId: string }>}
 */
export async function publishPost(content, parentRefs = [], onProgress = () => {}) {
  const { userId, privKey, pubKeyBytes } = requireIdentity();

  const trimmed = content.trim();
  const bytes = chain.utf8Length(trimmed);
  if (bytes === 0) throw new ActionError('Post something first.');
  if (bytes > chain.MAX_CONTENT_BYTES) {
    throw new ActionError(`Too long — ${bytes} of ${chain.MAX_CONTENT_BYTES} bytes.`);
  }
  if (parentRefs.length > chain.MAX_PARENT_REFS) {
    throw new ActionError(`A post can reference at most ${chain.MAX_PARENT_REFS} parents.`);
  }

  // Karma pays for the post: it is locked, not spent, and returns at epoch tally.
  const lockAmount = parentRefs.length === 0 ? chain.POST_LOCK_THREAD_COST : chain.POST_LOCK_REPLY_COST;

  onProgress('Checking karma');
  const karma = await api.getKarma(userId);
  if (karma.total < lockAmount) {
    throw new ActionError(
      `Not enough karma: this post locks ${lockAmount}, you have ${karma.total}.`,
    );
  }

  onProgress('Requesting challenge');
  const { challenge: challengeHex, targetBits } = await api.requestChallenge(userId);
  const challengeBytes = chain.hex2buf(challengeHex);

  onProgress(`Mining proof of work (${targetBits} bits)`);
  const timestamp = Date.now();
  const powInput = chain.buildPowInput(
    trimmed, pubKeyBytes, parentRefs, challengeBytes, chain.PROTOCOL_VERSION, timestamp,
  );
  const powNonce = await chain.solvePoW(powInput, targetBits, (progress) =>
    onProgress(`Mining proof of work — ${progress}`),
  );

  onProgress('Signing');
  const signature = await chain.signPost(
    trimmed, pubKeyBytes, parentRefs, challengeBytes, chain.PROTOCOL_VERSION, timestamp, privKey,
  );

  // The karma lock names the post it pays for, so the postId must be computed
  // before the tx is built — hence signing before mining is not an option.
  const postId = chain.computePostId({
    content: trimmed,
    author: userId,
    parentRefs,
    challenge: challengeHex,
    powNonce,
    protocolVersion: chain.PROTOCOL_VERSION,
    timestamp,
  });

  onProgress('Locking karma');
  const karmaLockTx = chain.buildKarmaLockTx(karma, lockAmount, postId, userId, store.height());
  const txId = await sign(karmaLockTx, userId, privKey);

  onProgress('Publishing');
  const result = await api.submitPost({
    content: trimmed,
    author: userId,
    parentRefs,
    challenge: challengeHex,
    powNonce,
    protocolVersion: chain.PROTOCOL_VERSION,
    timestamp,
    signature,
    karmaLockTx,
  });

  await store.refreshBalances();
  store.emit();
  return { txId, ...result };
}

/**
 * Delete a post and its replies. Authenticated by signing a fresh challenge —
 * the node checks the signature against the post's author.
 */
export async function deletePost(postId) {
  const { userId, privKey } = requireIdentity();
  const { challenge } = await api.requestChallenge(userId);
  const signature = await chain.signChallenge(challenge, privKey);
  const result = await api.deletePost(postId, { authorId: userId, challenge, signature });
  store.state.postsById.delete(postId);
  store.state.posts = store.state.posts.filter((p) => p.id !== postId);
  await store.refreshBalances();
  store.emit();
  return result;
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

/**
 * Like a post by locking `LIKE_COST` karma into a LikeBox.
 *
 * The node may accept the like as `free` (no LikeBox minted) or `pending`. We
 * record which, plus the LikeBox id, because unliking has to consume that exact
 * box and the node does not offer a lookup from (liker, post) back to it.
 */
export async function likePost(postId) {
  const { userId, privKey } = requireIdentity();

  const karma = await api.getKarma(userId);
  if (karma.total < chain.LIKE_COST) {
    throw new ActionError(`Liking locks ${chain.LIKE_COST} karma — you have ${karma.total}.`);
  }

  const tx = chain.buildLikeTx(karma, postId, userId, store.height());
  await sign(tx, userId, privKey);
  const result = await api.submitLike(tx);

  if (result.status === 'free') {
    store.recordLike(postId, true, { isFree: true, likeId: result.likeId ?? null });
  } else {
    // outputs[1] is the LikeBox; its id is deterministic from its contents.
    store.recordLike(postId, true, { isFree: false, likeBoxId: chain.computeBoxId(tx.outputs[1]) });
  }

  await store.refreshBalances();
  return result;
}

/** Undo a like, returning the locked karma in full. */
export async function unlikePost(postId) {
  const { userId, privKey } = requireIdentity();
  const receipt = store.getLikeReceipt(postId);
  if (!receipt) {
    throw new ActionError(
      'This like was cast from another browser — its receipt is not stored here, so it cannot be undone from this device.',
    );
  }

  let tx;
  if (receipt.isFree) {
    // A free like minted no LikeBox, so there is nothing to consume. Re-anchor
    // one karma box at its own value purely to carry the removal.
    const karma = await api.getKarma(userId);
    const sourceBox = karma.boxes?.[0];
    if (!sourceBox) throw new ActionError('No karma box available to anchor the removal.');
    tx = chain.buildFreeUnlikeTx(sourceBox, userId, store.height());
  } else {
    if (!receipt.likeBoxId) throw new ActionError('Like receipt is incomplete — cannot undo.');
    tx = chain.buildUnlikeTx(receipt.likeBoxId, userId, store.height());
  }

  await sign(tx, userId, privKey);

  let result;
  try {
    result = await api.submitUnlike(tx);
  } catch (error) {
    // A post lists its likers as soon as the like is accepted, but the LikeBox
    // it mints only enters the UTXO set when that tx lands in a block. Undoing
    // in between spends a box the node has never seen, and it says so in terms
    // no reader can act on. Translate it.
    if (error.status === 400 && /LikeBox/i.test(error.message)) {
      throw new ActionError(
        'This like has not been included in a block yet. Try undoing it again in a moment.',
      );
    }
    throw error;
  }

  store.recordLike(postId, false);
  await store.refreshBalances();
  return result;
}

// ---------------------------------------------------------------------------
// Follow (vouch)
// ---------------------------------------------------------------------------

/**
 * Follow an account.
 *
 * "Follow" is this UI's name for a vouch: the closest primitive the protocol
 * has, and a real one — it stakes the voucher's own standing on the target.
 */
export async function follow(targetId) {
  const { userId } = requireIdentity();
  if (targetId === userId) throw new ActionError('You cannot vouch for yourself.');
  const result = await api.castVouch(userId, targetId);
  store.state.following.add(targetId);
  store.emit();
  return result;
}

export async function unfollow(targetId) {
  const { userId } = requireIdentity();
  const result = await api.removeVouch(userId, targetId);
  store.state.following.delete(targetId);
  store.emit();
  return result;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export async function requestKarmaFaucet(amount = 100) {
  const { userId } = requireIdentity();
  const result = await api.grantKarmaFaucet(userId, amount);
  await store.refreshBalances();
  await store.refreshStatus();
  store.emit();
  return result;
}

export async function requestCreditFaucet() {
  const { userId } = requireIdentity();
  const result = await api.grantCreditFaucet(userId);
  await store.refreshBalances();
  await store.refreshStatus();
  store.emit();
  return result;
}

/**
 * Send credits to another account.
 *
 * The transfer endpoint takes a base64 signature over the txId rather than the
 * hex map the box endpoints use, so the tx is built and signed locally and then
 * re-encoded for the wire.
 */
export async function sendCredits(recipientHex, amount) {
  const { userId, privKey } = requireIdentity();
  if (!/^[0-9a-f]{64}$/i.test(recipientHex)) {
    throw new ActionError('Recipient must be a 64-character hex account id.');
  }
  if (!Number.isInteger(amount) || amount < 1) {
    throw new ActionError('Amount must be a whole number of at least 1.');
  }

  const credits = await api.getCredits(userId);
  if (credits.total < amount) {
    throw new ActionError(`Not enough credits: you have ${credits.total}.`);
  }

  const height = store.height();
  const tx = chain.buildCreditTransferTx(credits, recipientHex, amount, userId, height);
  const { signature } = await chain.signTxId(tx, privKey);
  const sigBase64 = btoa(String.fromCharCode(...chain.hex2buf(signature)));

  const result = await api.transferCredits({
    from: userId,
    to: recipientHex,
    amount,
    signature: sigBase64,
    expectedHeight: height,
  });

  await store.refreshBalances();
  store.emit();
  return result;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/**
 * Mint an invite. Returns the secret to hand to the invitee — it is generated
 * here, committed to on-chain only as a hash, and never sent to the node.
 */
export async function createInvite() {
  const { userId, privKey } = requireIdentity();
  const needed = chain.INVITE_KARMA_AMOUNT + chain.INVITE_BOND_KARMA;

  const karma = await api.getKarma(userId);
  if (karma.total < needed) {
    throw new ActionError(`An invite costs ${needed} karma (gift + bond) — you have ${karma.total}.`);
  }

  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secretHex = chain.buf2hex(secretBytes);
  const secretHashHex = chain.hashInviteSecret(secretBytes);

  const tx = chain.buildCreateInviteTx(karma, userId, secretHashHex, store.height());
  await sign(tx, userId, privKey);
  const result = await api.createInvite(tx);

  await store.refreshBalances();
  store.emit();
  return { ...result, secretHex, secretHashHex, inviterId: userId };
}

/**
 * Redeem an invite. Two on-chain steps by design: `commit` proves knowledge of
 * the secret without publishing it, then `claim` reveals it once the commit has
 * been included in a block — which is what stops a watching node from front-
 * running the reveal.
 *
 * @param {(stage: string) => void} [onProgress]
 */
export async function redeemInvite({ inviteBoxId, bondBoxId, inviterId, secretHex }, onProgress = () => {}) {
  const { userId, privKey } = requireIdentity();
  if (!inviteBoxId || !bondBoxId || !inviterId || !secretHex) {
    throw new ActionError('Invite id, bond id, inviter id and secret are all required.');
  }

  const startHeight = store.height();
  const bondBox = { id: bondBoxId, value: chain.INVITE_BOND_KARMA, inviterId, inviteBoxId };

  onProgress('Committing');
  const commitTx = chain.buildCommitTx(bondBox, userId, secretHex, startHeight);
  await sign(commitTx, userId, privKey);
  await api.commitInvite(commitTx);

  // The commit set the probation window; the reveal must carry the same values.
  bondBox.probationStartBlock = startHeight;
  bondBox.probationEndBlock = startHeight + chain.INVITE_PROBATION_BLOCKS;

  onProgress('Waiting for the commit to be included in a block');
  await waitForNextBlock(startHeight);

  onProgress('Revealing');
  const inviteBox = { id: inviteBoxId, value: chain.INVITE_KARMA_AMOUNT, inviterId };
  const claimTx = chain.buildClaimInviteTx(inviteBox, bondBox, userId, secretHex, store.height());
  await sign(claimTx, userId, privKey);
  const result = await api.claimInvite(claimTx);

  await store.refreshBalances();
  store.emit();
  return result;
}

/** Poll `/status` until the chain advances past `fromHeight`. */
function waitForNextBlock(fromHeight, { intervalMs = 3000, timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      await store.refreshStatus();
      if (store.height() > fromHeight) return resolve(store.height());
      if (Date.now() > deadline) {
        return reject(new ActionError('Timed out waiting for the next block. Is the node mining?'));
      }
      setTimeout(tick, intervalMs);
    };
    setTimeout(tick, intervalMs);
  });
}

/** Cancel an unclaimed invite and refund the gift and the bond. */
export async function cancelInvite(inviteBoxId) {
  const { userId, privKey } = requireIdentity();

  const [karma, invites] = await Promise.all([api.getKarma(userId), api.getInviteState(userId)]);
  const inviteBox = invites.pending?.find((b) => b.id === inviteBoxId);
  if (!inviteBox) throw new ActionError('That invite is not among your pending invites.');

  const bondBox = invites.bonds?.find(
    (b) => b.inviterId === inviteBox.inviterId &&
      (!b.inviteePublicKey || b.inviteePublicKey === chain.ZERO_32_HEX),
  );

  const tx = chain.buildCancelInviteTx(
    karma,
    { id: inviteBox.id, value: inviteBox.value },
    { id: bondBox?.id ?? chain.ZERO_32_HEX, value: bondBox?.value ?? 0 },
    userId,
    store.height(),
  );
  await sign(tx, userId, privKey);
  const result = await api.cancelInvite(tx);

  await store.refreshBalances();
  store.emit();
  return result;
}
