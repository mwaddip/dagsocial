export class ReaderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'truncated'
      | 'vlq-overflow'
      | 'array-too-large'
      | 'position-limit-exceeded'
      | 'slice-out-of-bounds',
  ) {
    super(message);
    this.name = 'ReaderError';
  }
}
