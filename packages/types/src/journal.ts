import type { UserId } from './identity.js';

export interface KarmaMint {
  userId: UserId;
  amount: bigint;
  boxId?: string;
}

export interface AppliedUtxoTx {
  txId: string;
  txCbor: Uint8Array;
  inputBoxIds: string[];
  outputBoxIds: string[];
}

export interface DecayJournalEntry {
  owner: Uint8Array;
  consumedBoxIds: string[];
  newBoxId: string;
  burnAmount: bigint;
}

export interface BlockJournal {
  blockHeight: number;
  creditBoxIds: string[];
  confirmedSubBlockIds: string[];
  talliedLikeBoxIds: string[];
  karmaMints: KarmaMint[];
  appliedUtxoTxs: AppliedUtxoTx[];
  decayBurns: DecayJournalEntry[];
  // AVL state root tracking — all box IDs consumed and created during block apply
  consumedBoxIds: string[];
  createdBoxIds: string[];
  // Vouch cooldown rows inserted during this block (for fork rollback)
  vouchCooldownInsertions?: Array<{ voucherId: Uint8Array; targetId: Uint8Array }>;
}
