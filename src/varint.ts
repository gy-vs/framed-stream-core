/**
 * Base-128 LEB128 unsigned varints (the same wire encoding as protocol
 * buffers' `uint64`). Every byte carries 7 payload bits in its low bits;
 * bit 7 set means another byte follows.
 *
 * JS cannot represent the full uint64 range, so accepted values are bounded
 * by Number.MAX_SAFE_INTEGER. Encodings longer than 10 bytes, a 10th byte
 * whose continuation/high bits are set, or values that exceed the safe
 * integer range are reported as overflow.
 */

export const MAX_VARINT_BYTES = 10;

export class VarintError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'VarintError';
  }
}

function assertSafeUint(value: number): void {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new VarintError(
      `varint value must be a non-negative safe integer, got: ${String(value)}`,
    );
  }
}

/** Encodes a non-negative safe integer into freshly allocated bytes. */
export function encodeVarint(value: number): Uint8Array {
  assertSafeUint(value);
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return Uint8Array.from(out);
}

/** Number of bytes the value needs (1..10). */
export function varintLength(value: number): number {
  assertSafeUint(value);
  let len = 1;
  let v = value;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    len++;
  }
  return len;
}

/** Writes a varint at `offset`, returning the number of bytes written. */
export function writeVarint(bytes: Uint8Array, offset: number, value: number): number {
  assertSafeUint(value);
  let v = value;
  let i = offset;
  while (v >= 0x80) {
    bytes[i++] = (v & 0x7f) | 0x80;
    v = Math.floor(v / 128);
  }
  bytes[i++] = v & 0x7f;
  return i - offset;
}

export type VarintReadResult =
  | { ok: true; value: number; length: number }
  | { ok: false; reason: 'need-more' | 'overflow' };

/**
 * Attempts to decode a varint from `bytes` starting at `offset`, with at most
 * `limit - offset` bytes available.
 *
 * - 'need-more': the bytes seen so far all request continuation, so adding
 *   more data may still yield a value.
 * - 'overflow': the encoding exceeds 10 bytes, or the value leaves the
 *   safe-integer range (which covers every illegal 10th byte as well, since
 *   any payload bit at shift 63 exceeds MAX_SAFE_INTEGER).
 */
export function readVarint(bytes: Uint8Array, offset: number, limit: number): VarintReadResult {
  let value = 0;

  for (let i = offset; ; i++) {
    if (i >= limit) {
      return { ok: false, reason: 'need-more' };
    }
    const position = i - offset;
    if (position >= MAX_VARINT_BYTES) {
      return { ok: false, reason: 'overflow' };
    }

    const byte = bytes[i];

    // A 10th byte may carry only bits at shift 63; a continuation bit there
    // implies an 11th byte, which no uint64 varint can use.
    if (position === MAX_VARINT_BYTES - 1 && (byte & 0x80)) {
      return { ok: false, reason: 'overflow' };
    }

    // `part * 128^p` is exact (small int times a power of two); once the
    // running sum crosses MAX_SAFE_INTEGER the comparison rejects it.
    value += (byte & 0x7f) * 2 ** (position * 7);
    if (value > Number.MAX_SAFE_INTEGER) {
      return { ok: false, reason: 'overflow' };
    }

    if (!(byte & 0x80)) {
      return { ok: true, value, length: position + 1 };
    }
  }
}
