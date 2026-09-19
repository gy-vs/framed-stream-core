import { crc32 } from './crc32.js';
import { varintLength, writeVarint, VarintError } from './varint.js';

/**
 * On-disk frame layout:
 *
 *   magic      (magic.length bytes, fixed, default 4: 9D 6D 33 C1)
 *   length     (unsigned LEB128 varint, payload byte count)
 *   payload    (`length` bytes, may be empty)
 *   checksum   (uint32 CRC-32 of the payload only, big-endian)
 *
 * The checksum intentionally covers only the payload: the magic and length
 * are already anchored by the decoder's resync logic, and keeping the CRC
 * payload-scoped makes it usable independently of the framing layer.
 */
export const DEFAULT_MAGIC = new Uint8Array([0x9d, 0x6d, 0x33, 0xc1]);

/** Default maximum accepted payload length: 16 MiB. */
export const DEFAULT_MAX_PAYLOAD_LENGTH = 16 * 1024 * 1024;

export interface EncodeOptions {
  /** Custom sync marker. Must contain at least one byte. Defaults to DEFAULT_MAGIC. */
  magic?: Uint8Array;
}

/**
 * Encodes one frame. The returned Uint8Array is exactly sized and independent
 * of the input payload (safe to reuse either buffer afterwards).
 */
export function encodeFrame(payload: Uint8Array, options: EncodeOptions = {}): Uint8Array {
  const magic = options.magic ?? DEFAULT_MAGIC;
  if (!(magic instanceof Uint8Array) || magic.length === 0) {
    throw new TypeError('magic must be a non-empty Uint8Array');
  }
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('payload must be a Uint8Array');
  }

  const lengthBytes = varintLength(payload.length);
  const frame = new Uint8Array(magic.length + lengthBytes + payload.length + 4);

  frame.set(magic, 0);
  writeVarint(frame, magic.length, payload.length);
  frame.set(payload, magic.length + lengthBytes);

  const checksum = crc32(payload);
  const crcOffset = magic.length + lengthBytes + payload.length;
  frame[crcOffset] = (checksum >>> 24) & 0xff;
  frame[crcOffset + 1] = (checksum >>> 16) & 0xff;
  frame[crcOffset + 2] = (checksum >>> 8) & 0xff;
  frame[crcOffset + 3] = checksum & 0xff;

  return frame;
}

export { VarintError };
