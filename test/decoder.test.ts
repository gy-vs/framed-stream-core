import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  crc32,
  DEFAULT_MAGIC,
  encodeFrame,
  FrameDecoder,
  FrameError,
} from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function framesOf(...payloads: Array<Uint8Array | string>): Uint8Array {
  return concat(
    payloads.map((p) => encodeFrame(typeof p === 'string' ? enc.encode(p) : p)),
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  // Unconditional copies: callers mutate the result, so it must never alias
  // an input frame's backing buffer.
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Splits data into every possible two-chunk cut; yields one stream per cut. */
function* cuts(data: Uint8Array): Generator<Uint8Array[]> {
  for (let i = 0; i <= data.length; i++) {
    yield [data.subarray(0, i), data.subarray(i)];
  }
}

function collect(): {
  push: (chunk: Uint8Array) => void;
  payloads: Uint8Array[];
  errors: FrameError[];
  strings: () => string[];
} {
  const payloads: Uint8Array[] = [];
  const errors: FrameError[] = [];
  const decoder = new FrameDecoder({
    onFrame: (p) => payloads.push(p),
    onError: (e) => errors.push(e),
  });
  return {
    push: (chunk) => decoder.push(chunk),
    payloads,
    errors,
    strings: () => payloads.map((p) => dec.decode(p)),
  };
}

/**
 * Builds a raw frame with arbitrary bytes, so corruptions can be injected.
 * Length is encoded as a minimal unsigned varint.
 */
function rawFrame(payload: Uint8Array, overrides: { length?: number; crc?: number } = {}): Uint8Array {
  const declaredLength = overrides.length ?? payload.length;

  const lengthBytes: number[] = [];
  let v = declaredLength;
  do {
    if (Math.floor(v / 128) === 0) {
      lengthBytes.push(v & 0x7f);
    } else {
      lengthBytes.push((v % 128) | 0x80);
    }
    v = Math.floor(v / 128);
  } while (v > 0);

  const checksum = overrides.crc ?? crc32(payload);
  const out = new Uint8Array(DEFAULT_MAGIC.length + lengthBytes.length + declaredLength + 4);
  let off = 0;
  out.set(DEFAULT_MAGIC, off);
  off += DEFAULT_MAGIC.length;
  out.set(lengthBytes, off);
  off += lengthBytes.length;
  out.set(payload, off);
  off += declaredLength;
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(off, checksum >>> 0);
  return out;
}

describe('FrameDecoder - basic delivery', () => {
  it('delivers a single complete frame', () => {
    const c = collect();
    c.push(framesOf('hello'));
    assert.deepEqual(c.strings(), ['hello']);
    assert.equal(c.errors.length, 0);
  });

  it('delivers several frames packed into one chunk', () => {
    const c = collect();
    c.push(framesOf('one', '', 'two', 'three'));
    assert.deepEqual(c.strings(), ['one', '', 'two', 'three']);
  });

  it('ignores leading garbage up to the first magic', () => {
    const c = collect();
    c.push(concat([Uint8Array.from([0, 1, 2, 3, 4]), framesOf('ok')]));
    assert.deepEqual(c.strings(), ['ok']);
  });

  it('ignores zero-length chunks', () => {
    const decoder = new FrameDecoder({ onFrame: () => assert.fail() });
    assert.doesNotThrow(() => decoder.push(new Uint8Array(0)));
  });

  it('accepts Buffer chunks (they are Uint8Array views)', () => {
    const c = collect();
    assert.doesNotThrow(() => c.push(Buffer.from(framesOf('buf'))));
    assert.deepEqual(c.strings(), ['buf']);
  });

  it('rejects non-Uint8Array chunks', () => {
    const decoder = new FrameDecoder({ onFrame: () => {} });
    assert.throws(() => decoder.push('xyz' as unknown as Uint8Array), TypeError);
    assert.throws(() => decoder.push(new Uint16Array(2) as unknown as Uint8Array), TypeError);
  });
});

describe('FrameDecoder - byte-by-byte input', () => {
  it('reassembles one frame fed one byte at a time (magic split)', () => {
    const c = collect();
    const frame = framesOf('streaming');
    for (const byte of frame) {
      c.push(Uint8Array.of(byte));
    }
    assert.deepEqual(c.strings(), ['streaming']);
    assert.equal(c.errors.length, 0);
  });

  it('reassembles a frame whose CRC is fed byte by byte', () => {
    const c = collect();
    const frame = framesOf('crc-tail');
    for (const byte of frame) {
      c.push(Uint8Array.of(byte));
    }
    assert.deepEqual(c.strings(), ['crc-tail']);
  });

  it('survives a magic split between two chunks for every cut', () => {
    const data = framesOf('cut');
    for (const [a, b] of cuts(data)) {
      const c = collect();
      c.push(a);
      c.push(b);
      assert.deepEqual(c.strings(), ['cut']);
    }
  });

  it('delivers two frames regardless of where the single chunk boundary falls', () => {
    const data = framesOf('aaaa', 'bbbb');
    for (const [a, b] of cuts(data)) {
      const c = collect();
      c.push(a);
      c.push(b);
      assert.deepEqual(c.strings(), ['aaaa', 'bbbb']);
      assert.equal(c.errors.length, 0);
    }
  });
});

describe('FrameDecoder - false magic and CRC failure resync', () => {
  it('treats a magic-like byte sequence in a payload as part of the frame', () => {
    const payload = concat([enc.encode('pre-'), DEFAULT_MAGIC, enc.encode('-post')]);
    const c = collect();
    c.push(framesOf(payload));
    assert.equal(c.payloads.length, 1);
    assert.deepEqual(c.payloads[0], payload);
  });

  it('ignores a false magic inside a corrupted payload when its CRC also fails', () => {
    // Outer frame is corrupted. Its payload contains an inner candidate
    // magic with a wrong CRC: the decoder must not deliver that frame even
    // though the magic and length look valid.
    const inner = rawFrame(enc.encode('decoy'), { crc: 0xdeadbeef });
    const outerPayload = concat([enc.encode('A'.repeat(10)), inner, enc.encode('B'.repeat(10))]);
    const outer = rawFrame(outerPayload, { crc: crc32(outerPayload) ^ 0x01 });

    const c = collect();
    c.push(concat([outer, framesOf('after')]));

    // Two rejected candidates: the outer frame and the embedded decoy.
    assert.equal(c.errors.length, 2);
    assert.equal(c.errors[0].code, 'ERR_CRC_MISMATCH');
    assert.equal(c.errors[1].code, 'ERR_CRC_MISMATCH');
    assert.deepEqual(c.strings(), ['after']);
  });

  it('recovers at an embedded candidate whose length AND CRC both validate', () => {
    // Per the framing contract, an embedded well-formed frame IS recovered.
    const good = framesOf('real-frame');
    const outerPayload = concat([enc.encode('junk-prefix-'), good, enc.encode('-tail')]);
    const outer = rawFrame(outerPayload, { crc: crc32(outerPayload) ^ 0x01 });

    const c = collect();
    c.push(outer);

    assert.equal(c.errors[0]?.code, 'ERR_CRC_MISMATCH');
    assert.deepEqual(c.strings(), ['real-frame']);
  });

  it('recovers embedded valid frames once a length-corrupted frame is fully buffered', () => {
    // Frame A has a 1-byte varint that is corrupted upward (2 -> 127), so the
    // decoder greedily waits. Once enough bytes arrive, the CRC fails and the
    // byte-wise resync discovers the intact frames embedded in that payload.
    const a = framesOf('AB');
    a[4] = 0x7f; // claim 127 payload bytes instead of 2
    const b = framesOf('B');
    const pad = new Uint8Array(127 - b.length); // fill the claimed payload region
    const tail = framesOf('TAIL');
    const stream = concat([a.subarray(0, 5), b, pad, tail]);

    const c = collect();
    c.push(stream);
    assert.ok(c.errors.some((e) => e.code === 'ERR_CRC_MISMATCH'));
    assert.deepEqual(c.strings(), ['B', 'TAIL']);
  });

  it('corrupting one payload byte causes ERR_CRC_MISMATCH but resyncs to the next frame', () => {
    const data = concat([framesOf('first-payload'), framesOf('second')]);
    // Flip a byte safely inside the first payload (after magic+varint header).
    data[4 + 1 + 2] ^= 0xff;
    const c = collect();
    c.push(data);
    assert.equal(c.errors.length, 1);
    assert.equal(c.errors[0].code, 'ERR_CRC_MISMATCH');
    assert.deepEqual(c.strings(), ['second']);
  });
});

describe('FrameDecoder - length and varint limits', () => {
  it('rejects an oversized declared length and resumes from the next frame', () => {
    const frames: Uint8Array[] = [];
    const errors: FrameError[] = [];
    const d = new FrameDecoder(
      {
        onFrame: (p) => frames.push(p),
        onError: (e) => errors.push(e),
      },
      { maxPayloadLength: 4 },
    );
    d.push(framesOf('too-long'));
    d.push(framesOf('ok'));

    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'ERR_LENGTH_EXCEEDED');
    assert.equal(errors[0].length, 8);
    assert.equal(errors[0].limit, 4);
    assert.deepEqual(frames.map((f) => dec.decode(f)), ['ok']);
  });  it('reports ERR_LENGTH_EXCEEDED without waiting for the oversized bytes', () => {
    const d = new FrameDecoder({
      onFrame: () => assert.fail('no frame expected'),
      onError: (e) => assert.equal(e.code, 'ERR_LENGTH_EXCEEDED'),
    });
    // magic + varint 300, but no payload bytes at all
    d.push(concat([DEFAULT_MAGIC, Uint8Array.from([0xac, 0x02])]));
  });

  it('rejects an overlong varint and recovers', () => {
    const bad = concat([DEFAULT_MAGIC, new Uint8Array(11).fill(0x80), new Uint8Array(1)]);
    const c = collect();
    c.push(concat([bad, framesOf('recovered')]));
    assert.ok(c.errors.some((e) => e.code === 'ERR_VARINT_OVERFLOW'));
    assert.deepEqual(c.strings(), ['recovered']);
  });

  it('rejects a varint encoding a value beyond MAX_SAFE_INTEGER and recovers', () => {
    const bad = concat([
      DEFAULT_MAGIC,
      Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    ]);
    const c = collect();
    c.push(concat([bad, framesOf('recovered')]));
    assert.ok(c.errors.some((e) => e.code === 'ERR_VARINT_OVERFLOW'));
    assert.deepEqual(c.strings(), ['recovered']);
  });

  it('rejects invalid constructor options', () => {
    assert.throws(() => new FrameDecoder(null as unknown as { onFrame: () => void }), TypeError);
    assert.throws(
      () => new FrameDecoder({ onFrame: () => {} }, { magic: new Uint8Array(0) }),
      TypeError,
    );
    assert.throws(
      () => new FrameDecoder({ onFrame: () => {} }, { maxPayloadLength: -1 }),
      TypeError,
    );
  });
});

describe('FrameDecoder - end of input', () => {
  it('clean end after complete frames', () => {
    const decoder = new FrameDecoder({ onFrame: () => {} });
    decoder.push(framesOf('a', 'b'));
    const result = decoder.finish();
    assert.deepEqual(result, { ok: true, remaining: 0 });
  });

  it('clean end with no data at all', () => {
    const decoder = new FrameDecoder({ onFrame: () => {} });
    assert.deepEqual(decoder.finish(), { ok: true, remaining: 0 });
  });

  it('reports a dangling magic as ERR_PARTIAL_FRAME', () => {
    const decoder = new FrameDecoder({ onFrame: () => {} });
    decoder.push(DEFAULT_MAGIC);
    const result = decoder.finish();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'ERR_PARTIAL_FRAME');
    assert.equal(result.error.remaining, DEFAULT_MAGIC.length);
  });

  it('reports magic + partial length as ERR_PARTIAL_FRAME', () => {
    const decoder = new FrameDecoder({ onFrame: () => {} });
    decoder.push(concat([DEFAULT_MAGIC, Uint8Array.of(0x80)]));
    const result = decoder.finish();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'ERR_PARTIAL_FRAME');
  });

  it('reports magic + length + partial payload as ERR_PARTIAL_FRAME', () => {
    const data = framesOf('full-payload');
    const decoder = new FrameDecoder({ onFrame: () => {} });
    decoder.push(data.subarray(0, data.length - 4 - 3)); // missing CRC and payload tail
    const result = decoder.finish();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'ERR_PARTIAL_FRAME');
  });

  it('reports a complete frame missing its CRC as ERR_PARTIAL_FRAME', () => {
    const data = framesOf('x');
    const decoder = new FrameDecoder({ onFrame: () => {} });
    decoder.push(data.subarray(0, data.length - 1));
    const result = decoder.finish();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'ERR_PARTIAL_FRAME');
  });

  it('reports random trailing bytes as ERR_TRAILING_BYTES', () => {
    const decoder = new FrameDecoder({ onFrame: () => {} });
    decoder.push(Uint8Array.from([0x10, 0x20, 0x30]));
    const result = decoder.finish();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'ERR_TRAILING_BYTES');
      assert.equal(result.error.remaining, 3);
    }
  });

  it('distinguishes clean vs partial for every cut of one frame', () => {
    const data = framesOf('edge');
    for (const [a, b] of cuts(data)) {
      const decoder = new FrameDecoder({ onFrame: () => {} });
      decoder.push(a);
      decoder.push(b);
      assert.deepEqual(decoder.finish(), { ok: true, remaining: 0 });
    }
    for (let n = 1; n < data.length; n++) {
      const decoder = new FrameDecoder({ onFrame: () => {} });
      decoder.push(data.subarray(0, n));
      const result = decoder.finish();
      // Only a prefix that reaches the magic qualifies as a partial frame.
      assert.equal(result.ok, false, `cut ${n} should be dirty`);
      if (result.ok) continue;
      assert.equal(
        result.error.code,
        n >= DEFAULT_MAGIC.length ? 'ERR_PARTIAL_FRAME' : 'ERR_TRAILING_BYTES',
      );
    }
  });

  it('can be reused after finish', () => {
    const out: string[] = [];
    const decoder = new FrameDecoder({ onFrame: (p) => out.push(dec.decode(p)) });
    decoder.push(DEFAULT_MAGIC);
    assert.equal(decoder.finish().ok, false);
    decoder.push(framesOf('again'));
    assert.deepEqual(decoder.finish(), { ok: true, remaining: 0 });
    assert.deepEqual(out, ['again']);
  });
});

describe('FrameDecoder - fuzz and memory', () => {
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('survives random chunking with random junk between frames', () => {
    const rand = prng(42);
    const messages = Array.from({ length: 40 }, (_, i) => `msg-${i}-${'x'.repeat((i * 7) % 200)}`);
    const parts: Uint8Array[] = [];
    for (const msg of messages) {
      // Bytes 0..127 can never start the 0x9d magic.
      const junk = new Uint8Array(Math.floor(rand() * 6));
      for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(rand() * 0x80);
      parts.push(junk);
      parts.push(framesOf(msg));
    }
    const stream = concat(parts);

    const out: string[] = [];
    const decoder = new FrameDecoder({ onFrame: (p) => out.push(dec.decode(p)) });
    let i = 0;
    while (i < stream.length) {
      const n = 1 + Math.floor(rand() * 19);
      decoder.push(stream.subarray(i, i + n));
      i += n;
    }
    assert.deepEqual(decoder.finish(), { ok: true, remaining: 0 });
    assert.deepEqual(out, messages);
  });

  it('survives random payload corruption and still delivers intact frames', () => {
    const rand = prng(7);
    const messages = Array.from({ length: 60 }, (_, i) => `f${i}`);
    const frames = messages.map((m) => encodeFrame(enc.encode(m)));
    let stream = concat(frames);

    // Flip roughly 2% of bytes, but only payload/CRC regions: damaging a
    // length varint is a different scenario (a genuinely ambiguous greedy
    // wait until the declared frame ends and CRC fails), covered separately.
    let offset = 0;
    for (const frame of frames) {
      const headerEnd = offset + DEFAULT_MAGIC.length + 1; // length varint is 1 byte
      const crcStart = offset + frame.length - 4;
      for (let i = headerEnd; i < crcStart; i++) {
        if (rand() < 0.02) stream[i] ^= 1 << Math.floor(rand() * 8);
      }
      offset += frame.length;
    }
    // Append an untouched sentinel frame after the damage; resync must
    // always reach it regardless of how badly the earlier frames were hit.
    stream = concat([stream, framesOf('sentinel')]);

    const out: string[] = [];
    const errors: FrameError[] = [];
    const decoder = new FrameDecoder({
      onFrame: (p) => out.push(dec.decode(p)),
      onError: (e) => errors.push(e),
    });
    let i = 0;
    while (i < stream.length) {
      const n = 1 + Math.floor(rand() * 13);
      decoder.push(stream.subarray(i, i + n));
      i += n;
    }
    assert.equal(decoder.finish().ok, true);
    assert.equal(out[out.length - 1], 'sentinel');
    assert.ok(errors.length > 0);
  });

  it('does not accumulate consumed prefixes while feeding huge frames byte by byte', () => {
    const payload = new Uint8Array(60_000);
    payload.fill(0x61);
    const frame = encodeFrame(payload);

    const decoder = new FrameDecoder({ onFrame: () => {} });
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      decoder.push(frame.subarray(i, i + 1));
      peak = Math.max(peak, decoder.bufferedBytes);
    }
    assert.equal(decoder.bufferedBytes, 0);
    // Held bytes stay within roughly one pending frame, never whole history.
    assert.ok(peak <= frame.length, `peak ${peak} exceeded frame size ${frame.length}`);
  });

  it('shrinks its allocation after a large frame is drained', () => {
    const decoder = new FrameDecoder({ onFrame: () => {} });
    decoder.push(encodeFrame(new Uint8Array(100_000)));
    assert.equal(decoder.bufferedBytes, 0);
    assert.ok(decoder.bufferCapacity <= 64 * 1024);
  });

  it('buffs no more than the pending tail while resyncing across many corrupt frames', () => {
    // 200 corrupted frames, each followed by a good one. A decoder that
    // retains scan history would grow without bound; ours stays bounded by
    // roughly one corrupted candidate plus the next good frame.
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      const bad = rawFrame(enc.encode(`bad-${i}`.padEnd(32, 'z')), {
        crc: (crc32(enc.encode(`bad-${i}`.padEnd(32, 'z'))) ^ 0xa5) >>> 0,
      });
      parts.push(bad, framesOf(`good-${i}`));
    }
    const stream = concat(parts);

    const decoder = new FrameDecoder({ onFrame: () => {}, onError: () => {} });
    let peak = 0;
    for (let i = 0; i < stream.length; i++) {
      decoder.push(stream.subarray(i, i + 1));
      peak = Math.max(peak, decoder.bufferedBytes);
    }
    assert.equal(decoder.finish().ok, true);
    // One candidate frame is 41 bytes; two of them pending is ample slack.
    assert.ok(peak < 200, `peak buffered bytes grew to ${peak}`);
  });

  it('hands out payloads independent of internal buffer reuse', () => {
    const received: Uint8Array[] = [];
    const decoder = new FrameDecoder({ onFrame: (p) => received.push(p) });
    decoder.push(framesOf('abc', 'def'));
    received[0][0] = 0x5a;
    assert.equal(dec.decode(received[1]), 'def');
    assert.equal(dec.decode(received[0]), 'Zbc');
  });

  it('delivers frames and errors in strict stream order', () => {
    const bad = rawFrame(enc.encode('bad'), { crc: 0xdeadbeef });
    const events: string[] = [];
    const decoder = new FrameDecoder({
      onFrame: (p) => events.push(`frame:${dec.decode(p)}`),
      onError: (e) => events.push(`error:${e.code}`),
    });
    decoder.push(framesOf('one'));
    decoder.push(bad);
    decoder.push(framesOf('two'));
    assert.deepEqual(events, [
      'frame:one',
      'error:ERR_CRC_MISMATCH',
      'frame:two',
    ]);
  });
});
