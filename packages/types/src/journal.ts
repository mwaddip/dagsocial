import type { UserId } from './identity.js';

export interface KarmaMint {
  userId: UserId;
  amount: number;
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
  burnAmount: number;
}

export interface BlockJournal {
  blockHeight: number;
  creditBoxIds: string[];
  confirmedSubBlockIds: string[];
  subBlockCbors: { subBlockId: string; cbor: Uint8Array }[];  // for mempool re-insertion
  talliedLikeBoxIds: string[];
  karmaMints: KarmaMint[];
  appliedUtxoTxs: AppliedUtxoTx[];
  decayBurns: DecayJournalEntry[];
}
