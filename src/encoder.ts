import { Crc32, crc32 } from './crc32.js';
import { encodeVarint } from './varint.js';

/** Default frame magic: 9D 4A 3F 21 ("frame" marker). */
export const DEFAULT_MAGIC = Uint8Array.of(0x9d, 0x4a, 0x3f, 0x21);
/** CRC checksum trailing the payload, big-endian uint32. */
export const CRC_SIZE = 4;
/** Default upper bound for declared payload lengths (16 MiB). */
export const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;

/** Wire layout: magic | varint(length) | payload[length] | crc32(payload) BE. */
export interface EncodeOptions {
  magic?: Uint8Array;
}

function copyInto(dst: Uint8Array, src: Uint8Array, offset: number): number {
  dst.set(src, offset);
  return offset + src.length;
}

/** Encode one frame. The returned Uint8Array is freshly allocated. */
export function encodeFrame(
  payload: Uint8Array,
  options: EncodeOptions = {},
): Uint8Array {
  const magic = options.magic ?? DEFAULT_MAGIC;
  const lengthBytes = encodeVarint(payload.length);
  const frame = new Uint8Array(magic.length + lengthBytes.length + payload.length + CRC_SIZE);

  let offset = copyInto(frame, magic, 0);
  offset = copyInto(frame, lengthBytes, offset);
  offset = copyInto(frame, payload, offset);

  const checksum = crc32(payload);
  frame[offset] = (checksum >>> 24) & 0xff;
  frame[offset + 1] = (checksum >>> 16) & 0xff;
  frame[offset + 2] = (checksum >>> 8) & 0xff;
  frame[offset + 3] = checksum & 0xff;
  return frame;
}

/** Thin stateful wrapper around {@link encodeFrame} holding a fixed magic. */
export class FrameEncoder {
  private readonly magic: Uint8Array;

  constructor(options: EncodeOptions = {}) {
    const magic = options.magic ?? DEFAULT_MAGIC;
    if (magic.length === 0) {
      throw new RangeError('magic must contain at least one byte');
    }
    this.magic = Uint8Array.from(magic);
  }

  encode(payload: Uint8Array): Uint8Array {
    return encodeFrame(payload, { magic: this.magic });
  }
}

export { Crc32 };
