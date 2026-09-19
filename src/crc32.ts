/**
 * CRC-32/ISO-HDLC (a.k.a. CRC-32 zlib/PNG polynomial 0xEDB88320, reflected,
 * init/xorout = 0xFFFFFFFF). CRC is computed over frame payload bytes only.
 */

const TABLE: Uint32Array = (() => {
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

/** CRC-32 of one contiguous byte range. */
export function crc32(data: Uint8Array, start = 0, end: number = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    const byte = data[i] as number;
    crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Streaming CRC-32 accumulator; safe to feed payloads byte by byte. */
export class Crc32 {
  private crc = 0xffffffff;

  update(data: Uint8Array, start = 0, end: number = data.length): this {
    let crc = this.crc;
    for (let i = start; i < end; i++) {
      const byte = data[i] as number;
      crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    }
    this.crc = crc;
    return this;
  }

  finish(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}
