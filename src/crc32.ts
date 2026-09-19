/**
 * CRC-32 (IEEE 802.3), as used by zlib/PNG/gzip:
 * polynomial 0xEDB88320 (reflected), init 0xFFFFFFFF, final XOR 0xFFFFFFFF.
 *
 * Implemented from scratch with a lazily-built 256-entry lookup table.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  private state = 0xffffffff;

  update(bytes: Uint8Array, offset = 0, length = bytes.length - offset): this {
    let crc = this.state;
    const end = offset + length;
    for (let i = offset; i < end; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    this.state = crc;
    return this;
  }

  /** Returns the digest so far without mutating the running state. */
  digest(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

/** One-shot convenience: CRC-32 of a byte range. */
export function crc32(bytes: Uint8Array, offset = 0, length = bytes.length - offset): number {
  return new Crc32().update(bytes, offset, length).digest();
}
