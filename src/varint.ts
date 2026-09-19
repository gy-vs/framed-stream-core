/**
 * LEB128-style unsigned varint.
 *
 * Accepted values are non-negative JS safe integers (2^53 - 1). The structural
 * 64-bit limit (10 bytes, last digit <= 1) is also enforced; anything larger
 * is reported as overflow/unterminated. For every accepted byte sequence the
 * accumulated value stays an exact integer, because over-range digits are
 * rejected *before* they are added, so no precision loss can mask an overflow.
 */

export const MAX_VARINT_BYTES = 10;

export type VarintError = 'overflow' | 'unterminated';

export interface VarintResult {
  /** Decoded value, valid only when `complete` is true and `error` is undefined. */
  value: number;
  /** Number of bytes consumed so far. */
  bytes: number;
  /** True once a terminating byte (high bit clear) has been read. */
  complete: boolean;
  /** "overflow": value out of range; "unterminated": more than 10 bytes. */
  error?: VarintError;
}

/** Incremental unsigned varint reader; feed bytes one at a time via `push`. */
export class VarintReader {
  private value = 0;
  private shift = 0;
  private bytes = 0;
  private error: VarintError | undefined;
  private complete = false;

  push(byte: number): void {
    if (this.complete || this.error) return;
    this.bytes++;
    const digit = byte & 0x7f;

    // The 10th byte sits at shift 63; it must terminate and its digit must be
    // zero for the value to remain within the safe-integer range (64-bit would
    // allow 0..1 here, but such lengths cannot be buffered anyway).
    if (this.bytes === MAX_VARINT_BYTES) {
      if ((byte & 0x80) !== 0) {
        this.error = 'unterminated';
        return;
      }
      if (digit !== 0) {
        this.error = 'overflow';
        return;
      }
      this.complete = true;
      return;
    }

    // 9th byte sits at shift 56; only zero is representable as a safe integer.
    if (this.shift === 56) {
      if (digit !== 0) {
        this.error = 'overflow';
        return;
      }
    } else if (this.shift === 49) {
      // 8th byte covers bits 49..55; only bits 49..52 may be set.
      if (digit > 0x0f) {
        this.error = 'overflow';
        return;
      }
      this.value += digit * 2 ** 49;
    } else {
      this.value += digit * 2 ** this.shift;
    }

    this.shift += 7;
    if ((byte & 0x80) === 0) {
      this.complete = true;
    }
  }

  get state(): VarintResult {
    return {
      value: this.value,
      bytes: this.bytes,
      complete: this.complete,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

/** Encode an unsigned safe integer; returns the minimal varint byte sequence. */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`varint value must be a non-negative safe integer, got ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return Uint8Array.from(out);
}
