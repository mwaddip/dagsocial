import { getDb } from './db.js';
import { encode, decode } from 'cbor-x';
import type { BlockJournal } from '@dagsocial/types';

function toBuffer(data: unknown): Buffer {
  return Buffer.from(encode(data) as unknown as Uint8Array);
}

export function insertBlockJournal(journal: BlockJournal): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO block_journal (block_height, journal_cbor) VALUES (?, ?)`,
  ).run(journal.blockHeight, toBuffer(journal));
}

export function getBlockJournal(height: number): BlockJournal | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT journal_cbor FROM block_journal WHERE block_height = ?',
  ).get(height) as { journal_cbor: Buffer } | undefined;
  if (!row) return null;
  return decode(row.journal_cbor) as BlockJournal;
}

export function deleteBlockJournal(height: number): void {
  getDb().prepare('DELETE FROM block_journal WHERE block_height = ?').run(height);
}

export function purgeOldJournals(belowHeight: number): void {
  getDb().prepare('DELETE FROM block_journal WHERE block_height < ?').run(belowHeight);
}
