import { crc32 } from './crc32.js';
import { FrameError } from './errors.js';
import { DEFAULT_MAGIC, DEFAULT_MAX_PAYLOAD_LENGTH } from './framer.js';
import { readVarint } from './varint.js';

export interface FrameDecoderHandlers {
  /** Called once per successfully verified frame, in stream order. */
  onFrame: (payload: Uint8Array) => void;
  /** Called once per rejected candidate frame; decoding resumes afterwards. */
  onError?: (error: FrameError) => void;
}

export interface FrameDecoderOptions {
  /** Sync marker; must match the encoder. Defaults to DEFAULT_MAGIC. */
  magic?: Uint8Array;
  /** Reject frames declaring a larger payload. Defaults to 16 MiB. */
  maxPayloadLength?: number;
}

export type FinishResult = { ok: true; remaining: 0 } | { ok: false; error: FrameError };

/**
 * Incremental frame decoder.
 *
 * Feed arbitrary-sized chunks with {@link push}; verified frames and errors
 * are delivered through the handlers during the call. Call {@link finish}
 * when the stream ends to distinguish a clean end from a dangling partial
 * frame.
 *
 * Memory management: all undecoded bytes live in a single growable buffer
 * bounded by `[pos, end)`. Confirmed-consumed prefixes are released: the
 * tail is moved to the front when the prefix would otherwise dominate the
 * buffer, and fully-drained large buffers shrink back to a small allocation.
 * The complete history of the stream is never held or concatenated.
 */
export class FrameDecoder {
  private readonly magic: Uint8Array;
  private readonly maxPayloadLength: number;
  private readonly handlers: FrameDecoderHandlers;

  private buffer: Uint8Array = new Uint8Array(64);
  private pos = 0;
  private end = 0;

  /** Bytes currently held waiting for more input. */
  get bufferedBytes(): number {
    return this.end - this.pos;
  }

  /** Allocated capacity (diagnostics); grows geometrically only as pending data requires. */
  get bufferCapacity(): number {
    return this.buffer.length;
  }

  constructor(handlers: FrameDecoderHandlers, options: FrameDecoderOptions = {}) {
    if (handlers === null || typeof handlers !== 'object' || typeof handlers.onFrame !== 'function') {
      throw new TypeError('FrameDecoder requires an onFrame handler');
    }
    const magic = options.magic ?? DEFAULT_MAGIC;
    if (!(magic instanceof Uint8Array) || magic.length === 0) {
      throw new TypeError('magic must be a non-empty Uint8Array');
    }
    const max = options.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;
    if (!Number.isInteger(max) || max < 0 || !Number.isSafeInteger(max)) {
      throw new TypeError('maxPayloadLength must be a non-negative safe integer');
    }
    this.handlers = handlers;
    this.magic = magic;
    this.maxPayloadLength = max;
  }

  /** Feeds one chunk; zero-length chunks are ignored. May throw if a handler throws. */
  push(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('chunk must be a Uint8Array');
    }
    if (chunk.length === 0) {
      return;
    }
    this.append(chunk);
    this.parse();
  }

  /**
   * Signals end of input. Any pending bytes are reported: a magic-prefixed
   * fragment as ERR_PARTIAL_FRAME, anything else as ERR_TRAILING_BYTES.
   * Afterwards the decoder is reset and may be reused for a new stream.
   */
  finish(): FinishResult {
    // A candidate can never become valid without more input; only check the
    // leftover prefix against the magic.
    let result: FinishResult;
    if (this.pos === this.end) {
      result = { ok: true, remaining: 0 };
    } else {
      const remaining = this.end - this.pos;
      const startsWithMagic =
        remaining >= this.magic.length && this.matchAt(this.pos, this.magic.length);
      result = startsWithMagic
        ? {
            ok: false,
            error: new FrameError(
              'ERR_PARTIAL_FRAME',
              `stream ended with ${remaining} byte(s) of an incomplete frame`,
              { remaining },
            ),
          }
        : {
            ok: false,
            error: new FrameError(
              'ERR_TRAILING_BYTES',
              `stream ended with ${remaining} trailing non-frame byte(s)`,
              { remaining },
            ),
          };
    }
    this.reset();
    return result;
  }

  /** Drops all pending bytes and returns the decoder to its initial state. */
  reset(): void {
    this.buffer = new Uint8Array(64);
    this.pos = 0;
    this.end = 0;
  }

  // -- internals -----------------------------------------------------------

  private append(chunk: Uint8Array): void {
    const pending = this.end - this.pos;
    const needed = pending + chunk.length;

    if (this.pos > 0 && needed <= this.buffer.length) {
      // Enough room after reclaiming the dead prefix in place. Move first,
      // while [pos, end) still names the tail exactly.
      this.buffer.copyWithin(0, this.pos, this.end);
      this.end = pending;
      this.pos = 0;
    } else if (needed > this.buffer.length) {
      // Grow geometrically; copy only the still-relevant tail, never history.
      let capacity = this.buffer.length;
      while (capacity < needed) {
        capacity *= 2;
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(this.pos, this.end), 0);
      this.buffer = grown;
      this.end = pending;
      this.pos = 0;
    }

    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }

  private emit(error: FrameError): void {
    this.handlers.onError?.(error);
  }

  private parse(): void {
    // Pending region: buffer [pos, end). `scanFrom` is the earliest index
    // that may still start a magic. Bytes in [pos, scanFrom) are already
    // ruled out but deliberately retained while a rescan may need to slide
    // one byte at a time across a corrupted payload; they are compacted out
    // on the next append or when the buffer is tight.
    let scanFrom = this.pos;

    while (true) {
      const magicIndex = this.findMagic(scanFrom);
      if (magicIndex < 0) {
        // No full marker present. Discard ruled-out bytes and keep the final
        // magic.length-1 pending bytes, since a marker may straddle a chunk.
        const pending = this.end - this.pos;
        const keep = Math.min(this.magic.length - 1, pending);
        this.releaseBefore(this.end - keep);
        return;
      }

      // Garbage before this magic is confirmed useless.
      if (magicIndex > this.pos) {
        this.releaseBefore(magicIndex);
      }
      scanFrom = this.pos + 1; // rescan origin if this candidate fails

      const lengthStart = this.pos + this.magic.length;
      const varint = readVarint(this.buffer, lengthStart, this.end);
      if (!varint.ok) {
        if (varint.reason === 'overflow') {
          this.emit(
            new FrameError(
              'ERR_VARINT_OVERFLOW',
              'length varint exceeds 10 bytes or the safe-integer range',
            ),
          );
          this.discardBeforeScanStart(scanFrom);
          continue; // slide one byte past the candidate magic
        }
        // Partial varint: keep the whole candidate for the next chunk.
        return;
      }

      if (varint.value > this.maxPayloadLength) {
        this.emit(
          new FrameError(
            'ERR_LENGTH_EXCEEDED',
            `declared payload length ${varint.value} exceeds limit ${this.maxPayloadLength}`,
            { length: varint.value, limit: this.maxPayloadLength },
          ),
        );
        this.discardBeforeScanStart(scanFrom);
        continue;
      }

      const payloadStart = lengthStart + varint.length;
      const frameEnd = payloadStart + varint.value + 4;
      if (frameEnd > this.end) {
        // Complete frame not yet present; the candidate stays anchored.
        return;
      }

      const expected = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + frameEnd - 4,
        4,
      ).getUint32(0);
      const actual = crc32(this.buffer, payloadStart, varint.value);
      if (actual !== expected) {
        this.emit(
          new FrameError(
            'ERR_CRC_MISMATCH',
            `CRC mismatch: expected 0x${expected.toString(16).padStart(8, '0')}, got 0x${actual
              .toString(16)
              .padStart(8, '0')}`,
            { expected, actual },
          ),
        );
        // The candidate magic itself could be a byte inside another frame's
        // corrupted payload: resume exactly one byte after it, so an embedded
        // well-formed frame can still be found and fully verified.
        this.discardBeforeScanStart(scanFrom);
        continue;
      }

      // Hand out an independent copy: the internal buffer is reused/shrunk.
      const payload = this.buffer.slice(payloadStart, payloadStart + varint.value);
      this.handlers.onFrame(payload);
      this.releaseBefore(frameEnd);
      scanFrom = this.pos;
    }
  }

  /**
   * Releases bytes that have been ruled out before `scanIndex` (the next
   * position at which a magic may start), then re-anchors both indices to the
   * surviving tail. Called after every rejected candidate so a long
   * corrupted payload is released one candidate at a time instead of being
   * held as history.
   */
  private discardBeforeScanStart(scanIndex: number): void {
    if (scanIndex <= this.pos) {
      return;
    }
    this.buffer.copyWithin(0, scanIndex, this.end);
    this.end -= scanIndex;
    this.pos = 0;
  }

  /** Drops every byte before `index` (buffer index), compacting or shrinking as needed. */
  private releaseBefore(index: number): void {
    this.pos = index;
    if (this.pos === this.end) {
      // Fully drained: release oversized buffers promptly, keep small ones.
      if (this.buffer.length > 64 * 1024) {
        this.buffer = new Uint8Array(64);
      }
      this.pos = 0;
      this.end = 0;
      return;
    }
    // Move the tail to the front once the dead prefix would dominate it,
    // so the held prefix never accumulates across chunks.
    const pending = this.end - this.pos;
    if (this.pos > pending) {
      this.buffer.copyWithin(0, this.pos, this.end);
      this.end = pending;
      this.pos = 0;
    }
  }

  private matchAt(index: number, length: number): boolean {
    for (let i = 0; i < length; i++) {
      if (this.buffer[index + i] !== this.magic[i]) {
        return false;
      }
    }
    return true;
  }

  private findMagic(from: number): number {
    const lastStart = this.end - this.magic.length;
    outer: for (let i = Math.max(from, this.pos); i <= lastStart; i++) {
      for (let j = 0; j < this.magic.length; j++) {
        if (this.buffer[i + j] !== this.magic[j]) {
          continue outer;
        }
      }
      return i;
    }
    return -1;
  }
}
