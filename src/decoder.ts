import { Crc32 } from './crc32.js';
import { CRC_SIZE, DEFAULT_MAGIC, DEFAULT_MAX_PAYLOAD } from './encoder.js';
import { VarintReader } from './varint.js';

/** Decoder error taxonomy. */
export type FrameErrorCode =
  | 'length-too-large'
  | 'varint-overflow'
  | 'crc-mismatch'
  | 'truncated-frame';

export interface FrameError {
  code: FrameErrorCode;
  /** Human-readable detail. */
  message: string;
  /** Declared payload length, present for `length-too-large`. */
  declaredLength?: number;
}

/** A successfully decoded frame. `payload` is an independent copy. */
export interface DecodedFrame {
  payload: Uint8Array;
  length: number;
}

export interface DecoderHandlers {
  onFrame?(frame: DecodedFrame): void;
  onError?(error: FrameError): void;
}

/** Result of {@link FrameDecoder.end}: distinguishes clean EOF from a half frame. */
export interface EndResult {
  /** True when no frame bytes (not even a partial magic) were pending. */
  clean: boolean;
  /** Number of bytes still buffered at end of input. */
  pendingBytes: number;
}

export interface DecoderOptions {
  magic?: Uint8Array;
  /** Reject frames whose declared payload length exceeds this (default 16 MiB). */
  maxPayloadLength?: number;
}

interface Chunk {
  data: Uint8Array;
  /** First retained offset within `data`. Only the head chunk can have > 0. */
  start: number;
}

type Phase = 'magic' | 'length' | 'payload' | 'crc';

/**
 * Incremental frame decoder.
 *
 * Data model: queued input chunks (copied once on `write`), plus three virtual
 * byte positions measured in a monotonic stream coordinate space:
 *   - `droppedVp`: start of the retained window (everything before is freed);
 *   - `candidateVp`: start of the magic candidate / frame being validated;
 *   - `cursorVp`: next byte to inspect (>= candidateVp >= droppedVp).
 *
 * Reads derive their chunk location from a position by walking chunks from the
 * window head, so the representation cannot desynchronize when chunks are
 * released. Confirmed prefixes are released immediately:
 *   - junk bytes in front of a candidate are dropped as they are rejected;
 *   - a fully validated frame is released the instant its CRC checks;
 *   - on any frame error only the frame's first byte is released and the whole
 *     window is rescanned, so a magic byte sequence embedded in a corrupt
 *     payload cannot yield a frame unless its own length and CRC also validate.
 *
 * Chunks are never concatenated: spent chunks are shifted out and a mostly
 * spent head is compacted, so retained memory is bounded by the frame in
 * flight plus the not-yet-inspected input — independent of stream history.
 */
export class FrameDecoder {
  private readonly magic: Uint8Array;
  private readonly maxPayloadLength: number;
  private readonly kmpNext: Int32Array;
  private readonly handlers: DecoderHandlers;

  private readonly chunks: Chunk[] = [];
  private droppedVp = 0;
  private candidateVp = 0;
  private cursorVp = 0;
  /**
   * Sequential scan pointer: the next byte to inspect is
   * chunks[scanCi].data[scanCo]. It only moves forward; {@link seekScan}
   * re-points it at `cursorVp` after chunks are released.
   */
  private scanCi = 0;
  private scanCo = 0;

  private phase: Phase = 'magic';
  private matched = 0;
  private lengthReader: VarintReader | null = null;
  private payloadLength = 0;
  private payloadRemaining = 0;
  private payloadStartVp = 0;
  private crc: Crc32 | null = null;
  private crcExpected = 0;
  private crcWire = 0;
  private crcRead = 0;
  private ended = false;
  private endClean = true;

  constructor(handlers: DecoderHandlers = {}, options: DecoderOptions = {}) {
    const magic = options.magic ?? DEFAULT_MAGIC;
    if (magic.length === 0) {
      throw new RangeError('magic must contain at least one byte');
    }
    const max = options.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD;
    if (!Number.isSafeInteger(max) || max < 0) {
      throw new RangeError('maxPayloadLength must be a non-negative safe integer');
    }
    this.magic = Uint8Array.from(magic);
    this.maxPayloadLength = max;
    this.handlers = handlers;
    this.kmpNext = buildKmpNext(this.magic);
  }

  /** Feed any number of bytes. Handlers fire synchronously, in stream order. */
  write(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    // Copy: callers may reuse or transfer their buffers after write() returns.
    this.chunks.push({ data: chunk.slice(), start: 0 });
    this.run();
  }

  /**
   * Mark end of input. A partial magic / varint / payload / CRC is reported via
   * `onError('truncated-frame')`; bytes that never matched a magic are trailing
   * junk and count as a clean end. Idempotent: repeated calls without new
   * `write()` return the same verdict and never re-emit the error.
   */
  end(): EndResult {
    if (this.ended) {
      return { clean: this.endClean, pendingBytes: this.availableBytes() };
    }
    let clean = true;
    if (this.phase !== 'magic' || this.matched > 0) {
      clean = false;
      this.emitError({
        code: 'truncated-frame',
        message: `input ended with an incomplete frame (${this.availableBytes()} byte(s) buffered)`,
      });
    }
    this.ended = true;
    this.endClean = clean;
    return { clean, pendingBytes: this.availableBytes() };
  }

  /** Drop all buffered state and restart at a fresh stream boundary. */
  reset(): void {
    this.chunks.length = 0;
    this.droppedVp = 0;
    this.candidateVp = 0;
    this.cursorVp = 0;
    this.scanCi = 0;
    this.scanCo = 0;
    this.ended = false;
    this.endClean = true;
    this.enterMagic();
  }

  /** Bytes currently retained (exposed for tests/diagnostics). */
  get pendingBytes(): number {
    return this.availableBytes();
  }

  // ------------------------------------------------------------------ engine

  private run(): void {
    while (true) {
      switch (this.phase) {
        case 'magic':
          if (!this.scanMagic()) return;
          break;
        case 'length':
          if (!this.readLength()) return;
          break;
        case 'payload':
          if (!this.readPayload()) return;
          break;
        case 'crc':
          if (!this.readCrc()) return;
          break;
      }
    }
  }

  /** @returns false when more input is needed */
  private scanMagic(): boolean {
    const m = this.magic;
    const next = this.kmpNext;
    let matched = this.matched;

    while (true) {
      const b = this.nextScanByte();
      if (b === undefined) {
        this.matched = matched;
        return false;
      }
      const byteVp = this.cursorVp;
      this.advanceScan(1);

      // Standard KMP transition on the just-consumed byte.
      while (matched > 0 && b !== (m[matched] as number)) {
        matched = next[matched - 1]!;
      }
      if (b === (m[matched] as number)) {
        matched++;
        // KMP invariant: current candidate begins `matched` bytes before the
        // byte just accepted (this updates it on fallbacks too).
        this.candidateVp = byteVp - (matched - 1);
      }

      if (matched === m.length) {
        // Commit the candidate: release everything before the frame start and
        // continue reading just after the magic.
        this.releaseUpTo(this.candidateVp);
        this.cursorVp = this.droppedVp + m.length;
        this.seekScan(this.cursorVp);
        this.matched = 0;
        this.enterLength();
        return true;
      }

      if (matched === 0) {
        // No candidate uses the consumed byte: it is confirmed junk. Advance
        // the window head past it, keeping the scan pointer in place.
        this.releaseUpTo(byteVp + 1);
        this.seekScan(this.cursorVp);
        this.candidateVp = this.cursorVp;
      }
    }
  }

  /** @returns false when more input is needed */
  private readLength(): boolean {
    let reader = this.lengthReader;
    if (!reader) {
      reader = new VarintReader();
      this.lengthReader = reader;
    }
    while (true) {
      const b = this.nextScanByte();
      if (b === undefined) return false;
      this.advanceScan(1);
      reader.push(b);
      const state = reader.state;
      if (state.error) {
        this.failAndResync({
          code: 'varint-overflow',
          message: `length varint is ${state.error} after ${state.bytes} byte(s)`,
        });
        return true;
      }
      if (!state.complete) continue;

      const length = state.value;
      if (length > this.maxPayloadLength) {
        this.failAndResync({
          code: 'length-too-large',
          message: `declared payload length ${length} exceeds limit ${this.maxPayloadLength}`,
          declaredLength: length,
        });
        return true;
      }

      this.payloadLength = length;
      this.payloadRemaining = length;
      this.payloadStartVp = this.cursorVp;
      this.crc = new Crc32();
      if (length === 0) {
        this.phase = 'crc';
        this.crcExpected = this.crc.finish();
        this.crcWire = 0;
        this.crcRead = 0;
      } else {
        this.phase = 'payload';
      }
      return true;
    }
  }

  /** @returns false when more input is needed */
  private readPayload(): boolean {
    const crc = this.crc!;
    let remaining = this.payloadRemaining;

    // Frame bytes stay retained until the CRC verdict; the scan pointer moves
    // over them. Contiguous within-chunk spans are CRC-fed without copying,
    // crossing chunk boundaries through the same pointer machinery as headers.
    while (remaining > 0) {
      const byte = this.nextScanByte();
      if (byte === undefined) break;
      const chunk = this.chunks[this.scanCi]!;
      const n = Math.min(chunk.data.length - this.scanCo, remaining);
      crc.update(chunk.data, this.scanCo, this.scanCo + n);
      this.advanceScan(n);
      remaining -= n;
    }

    this.payloadRemaining = remaining;
    if (remaining > 0) return false;

    this.crcExpected = crc.finish();
    this.crcWire = 0;
    this.crcRead = 0;
    this.phase = 'crc';
    return true;
  }

  /** @returns false when more input is needed */
  private readCrc(): boolean {
    let value = this.crcWire >>> 0;
    while (this.crcRead < CRC_SIZE) {
      const b = this.nextScanByte();
      if (b === undefined) {
        this.crcWire = value;
        return false;
      }
      this.advanceScan(1);
      value = ((value << 8) | b) >>> 0;
      this.crcRead++;
    }

    if (value !== this.crcExpected) {
      this.failAndResync({
        code: 'crc-mismatch',
        message: `CRC mismatch: frame declares 0x${value
          .toString(16)
          .padStart(8, '0')}, payload hashes to 0x${this.crcExpected.toString(16).padStart(8, '0')}`,
      });
      return true;
    }

    const payload = this.copyRange(this.payloadStartVp, this.payloadLength);
    this.emitFrame({ payload, length: this.payloadLength });

    // Whole frame confirmed: release it and restart at the following byte.
    this.releaseUpTo(this.cursorVp);
    this.seekScan(this.cursorVp);
    this.candidateVp = this.cursorVp;
    this.enterMagic();
    return true;
  }

  /** Report the frame error, release its first byte, then rescan the window. */
  private failAndResync(error: FrameError): void {
    this.emitError(error);
    // Window head is pinned at the corrupt frame's magic start. Release one
    // byte and rescan the whole remaining window from its head — including the
    // rest of the (now dead) magic, which KMP needs for self-overlapping magic
    // values. A magic-shaped candidate inside the payload is accepted only if
    // its own length and CRC validate.
    this.releaseUpTo(this.droppedVp + 1);
    this.cursorVp = this.droppedVp;
    this.seekScan(this.cursorVp);
    this.candidateVp = this.cursorVp;
    this.enterMagic();
  }

  private enterMagic(): void {
    this.phase = 'magic';
    this.matched = 0;
    this.lengthReader = null;
    this.payloadLength = 0;
    this.payloadRemaining = 0;
    this.payloadStartVp = 0;
    this.crc = null;
    this.crcExpected = 0;
    this.crcWire = 0;
    this.crcRead = 0;
  }

  private enterLength(): void {
    this.phase = 'length';
    this.lengthReader = null;
  }

  // ------------------------------------------------------------- data access

  private availableBytes(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.data.length - chunk.start;
    return total;
  }

  /** Byte under the sequential scan pointer, or undefined past buffered end. */
  private nextScanByte(): number | undefined {
    while (this.scanCi < this.chunks.length) {
      const chunk = this.chunks[this.scanCi]!;
      if (this.scanCo < chunk.start) this.scanCo = chunk.start;
      if (this.scanCo < chunk.data.length) {
        return chunk.data[this.scanCo] as number;
      }
      this.scanCi++;
      this.scanCo = this.chunks[this.scanCi]?.start ?? 0;
    }
    return undefined;
  }

  /** Advance the sequential scan pointer by `n` (must stay within buffered data). */
  private advanceScan(n: number): void {
    let left = n;
    while (left > 0) {
      const chunk = this.chunks[this.scanCi];
      if (!chunk) break;
      if (this.scanCo < chunk.start) this.scanCo = chunk.start;
      if (this.scanCo >= chunk.data.length) {
        this.scanCi++;
        this.scanCo = this.chunks[this.scanCi]?.start ?? 0;
        continue;
      }
      const step = Math.min(chunk.data.length - this.scanCo, left);
      this.scanCo += step;
      this.cursorVp += step;
      left -= step;
    }
  }

  /** Repoint the sequential scan pointer at virtual position `vp`. */
  private seekScan(vp: number): void {
    let rel = vp - this.droppedVp;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      const available = chunk.data.length - chunk.start;
      if (rel < available) {
        this.scanCi = i;
        this.scanCo = chunk.start + rel;
        return;
      }
      rel -= available;
    }
    this.scanCi = this.chunks.length;
    this.scanCo = 0;
  }

  /** Release every retained byte before virtual position `vp`. */
  private releaseUpTo(vp: number): void {
    let target = vp - this.droppedVp;
    while (target > 0 && this.chunks.length > 0) {
      const chunk = this.chunks[0]!;
      const available = chunk.data.length - chunk.start;
      if (available > target) {
        chunk.start += target;
        target = 0;
      } else {
        target -= available;
        this.chunks.shift();
      }
    }
    this.droppedVp = vp;

    // Compact a mostly spent head so its backing array is freed promptly.
    const head = this.chunks[0];
    if (head && head.start > 0 && head.start * 2 > head.data.length) {
      head.data = head.data.slice(head.start);
      head.start = 0;
    }
  }

  /** Copy `length` bytes at virtual position `startVp` into a fresh array. */
  private copyRange(startVp: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let rel = startVp - this.droppedVp;
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= length) break;
      const available = chunk.data.length - chunk.start;
      if (rel >= available) {
        rel -= available;
        continue;
      }
      const co = chunk.start + rel;
      const take = Math.min(chunk.data.length - co, length - offset);
      out.set(chunk.data.subarray(co, co + take), offset);
      offset += take;
      rel = 0;
    }
    return out;
  }

  // ------------------------------------------------------------- emit helpers

  private emitFrame(frame: DecodedFrame): void {
    this.handlers.onFrame?.({ payload: frame.payload, length: frame.length });
  }

  private emitError(error: FrameError): void {
    this.handlers.onError?.({ ...error });
  }
}

function buildKmpNext(magic: Uint8Array): Int32Array {
  const next = new Int32Array(magic.length);
  let k = 0;
  for (let i = 1; i < magic.length; i++) {
    while (k > 0 && magic[i] !== magic[k]) k = next[k - 1]!;
    if (magic[i] === magic[k]) k++;
    next[i] = k;
  }
  return next;
}
