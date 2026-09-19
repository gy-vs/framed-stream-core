/**
 * Error codes emitted by the incremental decoder.
 *
 * - ERR_LENGTH_EXCEEDED: a parsed payload length is larger than
 *   `maxPayloadLength`.
 * - ERR_VARINT_OVERFLOW: the length varint exceeds 10 bytes or encodes a
 *   value beyond Number.MAX_SAFE_INTEGER.
 * - ERR_CRC_MISMATCH: a complete frame arrived whose checksum does not match
 *   its payload.
 * - ERR_PARTIAL_FRAME: at end-of-input, bytes beginning with a valid magic
 *   remain but do not form a complete frame.
 * - ERR_TRAILING_BYTES: at end-of-input, non-magic bytes remain.
 */
export type FrameErrorCode =
  | 'ERR_LENGTH_EXCEEDED'
  | 'ERR_VARINT_OVERFLOW'
  | 'ERR_CRC_MISMATCH'
  | 'ERR_PARTIAL_FRAME'
  | 'ERR_TRAILING_BYTES';

export class FrameError extends Error {
  readonly code: FrameErrorCode;
  /** Declared payload length, attached for ERR_LENGTH_EXCEEDED. */
  readonly length?: number;
  /** Declared/expected limit, attached for ERR_LENGTH_EXCEEDED. */
  readonly limit?: number;
  /** Expected CRC, attached for ERR_CRC_MISMATCH. */
  readonly expected?: number;
  /** Computed CRC, attached for ERR_CRC_MISMATCH. */
  readonly actual?: number;
  /** Number of unconsumed bytes involved, attached for end-of-input errors. */
  readonly remaining?: number;

  constructor(
    code: FrameErrorCode,
    message: string,
    details?: {
      length?: number;
      limit?: number;
      expected?: number;
      actual?: number;
      remaining?: number;
    },
  ) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
    if (details) {
      Object.assign(this, details);
    }
  }
}
