/**
 * What kind of wrong the bytes were. Callers switch on this; the message is
 * diagnostic text only and may be reworded at any time (WIRE_INTERFACE.md,
 * "ReaderError codes", audit L-15).
 */
export type ReaderErrorCode =
  | 'truncated'                // The bytes ran out — EOF or fewer than n remaining
  | 'invalid-tag'              // A discriminant byte outside its allowed set
  | 'wrong-magic'              // Frame magic did not match the expected network
  | 'unsupported-version'      // Frame version exceeds FRAME_VERSION
  | 'checksum-mismatch'        // Frame body corrupted in transit or forged
  | 'vlq-overflow'             // VLQ exceeded 10 bytes or the safe-integer range
  | 'array-too-large'          // Array length > MAX_ARRAY_LENGTH
  | 'position-limit-exceeded'; // Read passed a caller-imposed position limit

export class ReaderError extends Error {
  constructor(
    message: string,
    public readonly code: ReaderErrorCode,
  ) {
    super(message);
    this.name = 'ReaderError';
  }
}
