import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAGIC,
  FrameDecoder,
  FrameEncoder,
  encodeFrame,
  type DecodedFrame,
  type EndResult,
  type FrameError,
} from '../src/index.js';
import { encodeVarint } from '../src/varint.js';

interface Sink {
  frames: DecodedFrame[];
  errors: FrameError[];
  end: EndResult | null;
}

function makeDecoder(options?: ConstructorParameters<typeof FrameDecoder>[1]): {
  decoder: FrameDecoder;
  sink: Sink;
} {
  const sink: Sink = { frames: [], errors: [], end: null };
  const decoder = new FrameDecoder(
    {
      onFrame: (f) => sink.frames.push(f),
      onError: (e) => sink.errors.push(e),
    },
    options,
  );
  return { decoder, sink };
}

const encoder = new FrameEncoder();
const frame = (payload: Uint8Array) => encoder.encode(payload);

/** Concatenate byte arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
/**
 * Build a syntactically frame-shaped buffer with custom fields, so tests can
 * tamper with each region independently.
 */
function rawFrame(
  length: number | bigint | Uint8Array,
  payload: Uint8Array,
  crc: number | Uint8Array = crcOf(payload),
  magic: Uint8Array = DEFAULT_MAGIC,
): Uint8Array {
  const lenBytes =
    length instanceof Uint8Array ? length : encodeVarint(Number(length));
  const crcBytes =
    crc instanceof Uint8Array
      ? crc
      : Uint8Array.of((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  return concat(magic, lenBytes, payload, crcBytes);
}

/** rawFrame with an explicit magic; named for readability at call sites. */
function rawFrameCustom(
  magic: Uint8Array,
  length: number | Uint8Array,
  payload: Uint8Array,
  crc: number,
): Uint8Array {
  return rawFrame(length, payload, crc, magic);
}

function crcOf(payload: Uint8Array): number {
  // Local import-free helper kept in sync with the library under test.
  // Reached through encodeFrame indirectly elsewhere; compute via a full frame
  // decode-free approach using node:zlib-independent constant below.
  return crc32Reference(payload);
}

// Minimal local reference CRC so tampered frames carry arbitrary checksums
// without depending on the tested module's crc helper.
function crc32Reference(data: Uint8Array): number {
  const table = crc32Reference.table;
  let crc = 0xffffffff;
  for (const b of data) crc = (table[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
crc32Reference.table = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// ---------------------------------------------------------------------------

test('decoder: single frame delivered whole', () => {
  const { decoder, sink } = makeDecoder();
  decoder.write(frame(new TextEncoder().encode('one')));
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(sink.frames[0]!.payload, new TextEncoder().encode('one'));
  assert.deepEqual([...sink.errors], []);
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
});

test('decoder: byte-at-a-time feeding across magic, varint, payload and CRC', () => {
  const data = frame(new TextEncoder().encode('split everywhere'));
  const { decoder, sink } = makeDecoder();
  for (let i = 0; i < data.length; i++) {
    decoder.write(Uint8Array.of(data[i]!));
    // Frame can only be emitted once its final CRC byte has been seen.
    assert.equal(sink.frames.length, i === data.length - 1 ? 1 : 0);
  }
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(
    Buffer.from(sink.frames[0]!.payload).toString(),
    'split everywhere',
  );
  assert.deepEqual(sink.errors, []);
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
});

test('decoder: every field can be split between two chunks', () => {
  const data = frame(new TextEncoder().encode('boundary'));
  for (let cut = 1; cut < data.length - 1; cut++) {
    const { decoder, sink } = makeDecoder();
    decoder.write(data.subarray(0, cut));
    assert.equal(sink.frames.length, 0, `cut=${cut}`);
    decoder.write(data.subarray(cut));
    assert.equal(sink.frames.length, 1, `cut=${cut}`);
    assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'boundary', `cut=${cut}`);
    assert.deepEqual(sink.errors, [], `cut=${cut}`);
  }
});

test('decoder: multiple frames in one chunk', () => {
  const p1 = new TextEncoder().encode('first');
  const p2 = new TextEncoder().encode('second');
  const p3 = new TextEncoder().encode('third');
  const { decoder, sink } = makeDecoder();
  decoder.write(concat(frame(p1), frame(p2), frame(p3)));
  assert.deepEqual(sink.frames.map((f) => Buffer.from(f.payload).toString()), ['first', 'second', 'third']);
  assert.deepEqual(sink.errors, []);
});

test('decoder: arbitrary randomized chunk boundaries', () => {
  const payloads: Uint8Array[] = [];
  let stream: Uint8Array = new Uint8Array(0);
  let seed = 123456789;
  const rnd = () => {
    // xorshift32 deterministic PRNG
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < 40; i++) {
    const len = Math.floor(rnd() * 60);
    const p = new Uint8Array(len);
    for (let j = 0; j < len; j++) p[j] = Math.floor(rnd() * 256);
    payloads.push(p);
    stream = concat(stream, frame(p));
  }

  const { decoder, sink } = makeDecoder();
  let pos = 0;
  while (pos < stream.length) {
    const take = Math.min(stream.length - pos, 1 + Math.floor(rnd() * 7));
    decoder.write(stream.subarray(pos, pos + take));
    pos += take;
  }
  assert.equal(sink.frames.length, payloads.length);
  for (let i = 0; i < payloads.length; i++) {
    assert.deepEqual(sink.frames[i]!.payload, payloads[i]);
  }
  assert.deepEqual(sink.errors, []);
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
});

test('decoder: leading junk before first magic is skipped', () => {
  const junk = Uint8Array.of(0x00, 0x11, 0x22, DEFAULT_MAGIC[0]!, 0xff);
  const { decoder, sink } = makeDecoder();
  decoder.write(concat(junk, frame(new TextEncoder().encode('ok'))));
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'ok');
  assert.equal(sink.errors.length, 0);
});

test('decoder: pseudo magic inside corrupt payload does not emit; resyncs to next valid frame', () => {
  // Corrupt outer frame whose payload embeds a frame-shaped decoy:
  // magic | varint(1) | one payload byte | 4 CRC bytes that do NOT validate.
  // The decoder must not emit the decoy; only the genuine frame that follows.
  const decoyInner = concat(
    DEFAULT_MAGIC,
    encodeVarint(1),
    Uint8Array.of(0x5a),
    Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
  );
  const corrupt = rawFrame(decoyInner.length, decoyInner, crcOf(decoyInner) ^ 0xdeadbeef);
  const good = frame(new TextEncoder().encode('recovered'));

  const { decoder, sink } = makeDecoder();
  decoder.write(concat(corrupt, good));

  // Both the outer frame and the frame-shaped decoy inside its payload fail
  // CRC; neither yields a frame. Only the genuine trailing frame is delivered.
  assert.deepEqual(sink.errors.map((e) => e.code), ['crc-mismatch', 'crc-mismatch']);
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'recovered');
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
});

test('decoder: pseudo magic inside corrupt payload CAN start recovery when fully valid', () => {
  // The embedded frame is genuinely valid; the outer frame's CRC is bad. The
  // decoder must accept the inner frame after dropping the outer start byte.
  const inner = frame(new TextEncoder().encode('inner'));
  // Wrap inner bytes as the (declared, full-size) payload of an outer frame
  // with the wrong checksum.
  const outer = rawFrame(inner.length, inner, crcOf(inner) ^ 0x01020304);
  // Note: outer layout is magic|len|inner...|4 bytes; inner already ends in its
  // own CRC, so outer simply appends 4 bogus CRC bytes.
  const { decoder, sink } = makeDecoder();
  decoder.write(outer);
  assert.equal(sink.errors.length, 1);
  assert.equal(sink.errors[0]!.code, 'crc-mismatch');
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'inner');
});

test('decoder: declared length above limit is reported and decoder resyncs', () => {
  const { decoder, sink } = makeDecoder({ maxPayloadLength: 10 });
  const tooBig = rawFrame(11, new Uint8Array(11), 0);
  const good = frame(new TextEncoder().encode('fine'));
  decoder.write(concat(tooBig, good));
  assert.equal(sink.errors.length, 1);
  assert.equal(sink.errors[0]!.code, 'length-too-large');
  assert.equal(sink.errors[0]!.declaredLength, 11);
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'fine');
});

test('decoder: length exactly at the limit is accepted', () => {
  const { decoder, sink } = makeDecoder({ maxPayloadLength: 10 });
  decoder.write(frame(new Uint8Array(10)));
  assert.equal(sink.frames.length, 1);
  assert.equal(sink.frames[0]!.length, 10);
  assert.equal(sink.errors.length, 0);
});

test('decoder: varint overflow is reported and decoder resyncs', () => {
  const { decoder, sink } = makeDecoder({ maxPayloadLength: 1000 });
  // 2^53: digit 0x10 at shift 49, then zero byte terminator.
  const overflowLen = Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10, 0x00);
  const bad = concat(DEFAULT_MAGIC, overflowLen, new Uint8Array(5));
  const good = frame(new TextEncoder().encode('after-overflow'));
  decoder.write(concat(bad, good));
  const codes = sink.errors.map((e) => e.code);
  assert.ok(codes.includes('varint-overflow'), JSON.stringify(codes));
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'after-overflow');
});

test('decoder: >10-byte varint is reported as varint overflow', () => {
  const { decoder, sink } = makeDecoder();
  const longLen = new Uint8Array(11).fill(0x80);
  longLen[10] = 0x00;
  decoder.write(concat(DEFAULT_MAGIC, longLen, new TextEncoder().encode('zz')));
  assert.equal(sink.errors[0]!.code, 'varint-overflow');
});

test('decoder: CRC error on every payload bit flip, with recovery each time', () => {
  const goodPayloads: Uint8Array[] = [];
  const parts: Uint8Array[] = [];
  for (let i = 0; i < 8; i++) {
    const p = new Uint8Array(4);
    p[i % 4] = 1 << (i % 8);
    const broken = rawFrame(p.length, p, crcOf(p)); // correct shape, flip a payload bit below
    broken[DEFAULT_MAGIC.length + 1 + (i % 4)]! ^= 1 << (i % 8);
    parts.push(broken);
    goodPayloads.push(new TextEncoder().encode(`g${i}`));
    parts.push(frame(goodPayloads[i]!));
  }
  const { decoder, sink } = makeDecoder();
  decoder.write(concat(...parts));
  assert.equal(sink.errors.length, 8);
  assert.ok(sink.errors.every((e) => e.code === 'crc-mismatch'));
  assert.equal(sink.frames.length, 8);
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(sink.frames[i]!.payload, goodPayloads[i]);
  }
});

test('decoder: truncated endings are distinguished from clean ends', () => {
  const full = frame(new TextEncoder().encode('abcdefgh'));

  // Every truncation point from 1..length-1 must report a truncated frame.
  for (let cut = 1; cut < full.length; cut++) {
    const { decoder, sink } = makeDecoder();
    decoder.write(full.subarray(0, cut));
    const result = decoder.end();
    assert.equal(result.clean, false, `cut=${cut}`);
    assert.equal(sink.errors.length, 1, `cut=${cut}`);
    assert.equal(sink.errors[0]!.code, 'truncated-frame', `cut=${cut}`);
    assert.equal(result.pendingBytes, cut, `cut=${cut}`);
  }

  // Complete frame followed by nothing is clean.
  const ok = makeDecoder();
  ok.decoder.write(full);
  assert.deepEqual(ok.decoder.end(), { clean: true, pendingBytes: 0 });

  // Trailing junk with no partial magic is clean.
  const junk = makeDecoder();
  junk.decoder.write(Uint8Array.of(0x55, 0x66, 0x77));
  assert.equal(junk.decoder.end().clean, true);

  // A partial magic alone is a half frame.
  const partialMagic = makeDecoder();
  partialMagic.decoder.write(DEFAULT_MAGIC.subarray(0, 2));
  const r = partialMagic.decoder.end();
  assert.equal(r.clean, false);
  assert.equal(partialMagic.sink.errors[0]!.code, 'truncated-frame');
});

test('decoder: buffered prefixes are released; pending bytes stay bounded', () => {
  const { decoder } = makeDecoder();
  const f = frame(new Uint8Array(100));

  // Feed a large junk prefix; it must be discarded as magic scanning rejects it.
  decoder.write(new Uint8Array(5000).fill(0x00));
  assert.equal(decoder.pendingBytes, 0);

  decoder.write(f);
  assert.equal(decoder.pendingBytes, 0);

  // A declared-oversize frame raises the error from the header immediately;
  // it never waits for (or buffers "up to") the declared length, and the
  // following bytes are discarded during rescan.
  const limited = makeDecoder({ maxPayloadLength: 64 });
  const big = concat(DEFAULT_MAGIC, encodeVarint(100000), new Uint8Array(50));
  limited.decoder.write(big);
  assert.equal(limited.sink.errors[0]!.code, 'length-too-large');
  // All 50 payload-following bytes plus the header were junk to the rescanner.
  assert.equal(limited.decoder.pendingBytes, 0);

  // Feeding pure junk (a byte that never equals magic[0]) never accumulates
  // history, regardless of chunk size.
  for (let i = 0; i < 100; i++) {
    decoder.write(new Uint8Array(1000).fill(0x01));
    assert.equal(decoder.pendingBytes, 0);
  }

  // A declared length under the limit but never completed is bounded by the
  // limit, not by the declared length: feeding 200KB into a 64-limit decoder
  // after a bogus header keeps retention at a small frame's worth at most.
  for (let i = 0; i < 200; i++) {
    limited.decoder.write(new Uint8Array(1000).fill(0x01));
  }
  assert.equal(limited.decoder.pendingBytes, 0);
});

test('decoder: payload emitted to caller is independent of the input buffer', () => {
  const input = frame(Uint8Array.of(7, 8, 9));
  const { decoder, sink } = makeDecoder();
  decoder.write(input);
  input.fill(0); // mutate the caller's buffer after write
  assert.deepEqual([...sink.frames[0]!.payload], [7, 8, 9]);
});

test('decoder: empty payload frame', () => {
  const { decoder, sink } = makeDecoder();
  decoder.write(frame(new Uint8Array()));
  assert.equal(sink.frames.length, 1);
  assert.equal(sink.frames[0]!.length, 0);
  assert.deepEqual(sink.errors, []);
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
});

test('decoder: magic with a self-overlapping border (KMP fallback) stays in sync', () => {
  // Self-overlapping magic AA BB AA BB (KMP failure function [0,0,1,2]).
  const magic = Uint8Array.of(0xaa, 0xbb, 0xaa, 0xbb);
  const enc = new FrameEncoder({ magic });
  const good = enc.encode(new TextEncoder().encode('x'));
  // AA BB AA 00: after the mismatch at index 3, border "AA" must survive and
  // then die cleanly on 00 (no early full magic anywhere in the prefix).
  const prefix = Uint8Array.of(0xaa, 0xbb, 0xaa, 0x00);

  for (const mode of ['whole', 'bytes'] as const) {
    const { decoder, sink } = makeDecoder({ magic });
    const stream = concat(prefix, good);
    if (mode === 'whole') {
      decoder.write(stream);
    } else {
      for (const b of stream) decoder.write(Uint8Array.of(b));
    }
    assert.equal(sink.frames.length, 1, mode);
    assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'x', mode);
    assert.deepEqual(sink.errors, []);
    assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
  }
});

test('decoder: rescan honors a self-overlapping magic straddling a corrupt frame boundary', () => {
  // Magic AAA: after a CRC failure the corrupt frame tail ends in 'AA',
  // which is the length-2 border of the following valid magic 'AAA'.
  const magic = Uint8Array.of(0xaa, 0xaa, 0xaa);
  const enc = new FrameEncoder({ magic });
  const corrupt = rawFrameCustom(magic, 1, Uint8Array.of(0xaa, 0xaa), 0x11223344);
  const good = enc.encode(new TextEncoder().encode('q'));

  const { decoder, sink } = makeDecoder({ magic });
  decoder.write(concat(corrupt, good));
  assert.equal(sink.errors.length, 1);
  assert.equal(sink.errors[0]!.code, 'crc-mismatch');
  assert.equal(sink.frames.length, 1);
  assert.deepEqual([...sink.frames[0]!.payload], [0x71]);
});

test('decoder: reset() clears pending state', () => {
  const { decoder, sink } = makeDecoder();
  decoder.write(DEFAULT_MAGIC); // partial frame
  assert.ok(decoder.pendingBytes > 0);
  decoder.reset();
  assert.equal(decoder.pendingBytes, 0);
  decoder.write(frame(new TextEncoder().encode('post-reset')));
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'post-reset');
});

test('decoder: valid frame glued directly after a corrupt frame with no gap', () => {
  const bad = rawFrame(2, Uint8Array.of(0xaa, 0xbb), 0x11223344);
  const good = frame(new TextEncoder().encode('z'));
  const { decoder, sink } = makeDecoder();
  decoder.write(concat(bad, good));
  assert.equal(sink.errors.length, 1);
  assert.equal(sink.frames.length, 1);
  assert.deepEqual([...sink.frames[0]!.payload], [0x7a]);
});

test('decoder: rejects invalid options', () => {
  assert.throws(() => new FrameDecoder({}, { magic: new Uint8Array() }), RangeError);
  assert.throws(() => new FrameDecoder({}, { maxPayloadLength: -1 }), RangeError);
  assert.throws(() => new FrameDecoder({}, { maxPayloadLength: 1.5 }), RangeError);
});

test('decoder: fuzzed random garbage with sparse valid frames yields exactly those frames', () => {
  let seed = 0xabcdef01 >>> 0;
  const rnd = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0x100000000;
  };

  const expected: Uint8Array[] = [];
  let stream: Uint8Array = Uint8Array.of();
  for (let i = 0; i < 60; i++) {
    // Random garbage, biased so magic[0] appears often (exercises false leads).
    const junkLen = Math.floor(rnd() * 25);
    const junk = new Uint8Array(junkLen);
    for (let j = 0; j < junkLen; j++) {
      junk[j] = rnd() < 0.2 ? (DEFAULT_MAGIC[0] as number) : Math.floor(rnd() * 256);
    }
    const p = new Uint8Array(Math.floor(rnd() * 8));
    for (let j = 0; j < p.length; j++) p[j] = Math.floor(rnd() * 256);
    expected.push(p);
    stream = concat(stream, junk, frame(p));
  }

  const { decoder, sink } = makeDecoder();
  let pos = 0;
  while (pos < stream.length) {
    const take = Math.min(stream.length - pos, 1 + Math.floor(rnd() * 5));
    decoder.write(stream.subarray(pos, pos + take));
    pos += take;
  }
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
  assert.equal(sink.frames.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual(sink.frames[i]!.payload, expected[i]);
  }
});

test('decoder: garbage bytes never equal to magic[0] leave zero pending bytes', () => {
  const { decoder } = makeDecoder();
  const other = (DEFAULT_MAGIC[0] as number) ^ 0xff;
  for (let i = 0; i < 50; i++) {
    decoder.write(new Uint8Array(300).fill(other));
    assert.equal(decoder.pendingBytes, 0);
  }
});

test('decoder: thousands of byte-at-a-time frames do not accumulate history', () => {
  const COUNT = 2000;
  const { decoder, sink } = makeDecoder();
  const t0 = Date.now();
  for (let i = 0; i < COUNT; i++) {
    const data = frame(Uint8Array.of(i & 0xff, (i >> 8) & 0xff));
    for (const b of data) {
      decoder.write(Uint8Array.of(b));
      // A frame in flight is at most one frame; nothing from earlier frames
      // may remain once a frame closes.
      assert.ok(decoder.pendingBytes <= data.length);
    }
  }
  assert.ok(Date.now() - t0 < 10000, `too slow: ${Date.now() - t0}ms`);
  assert.equal(sink.frames.length, COUNT);
  assert.equal(sink.errors.length, 0);
  for (let i = 0; i < COUNT; i++) {
    assert.deepEqual([...sink.frames[i]!.payload], [i & 0xff, (i >> 8) & 0xff]);
  }
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
});

test('decoder: end() is idempotent and reset() starts a fresh stream', () => {
  const { decoder, sink } = makeDecoder();
  decoder.write(DEFAULT_MAGIC); // half frame
  const first = decoder.end();
  assert.equal(first.clean, false);
  const second = decoder.end();
  assert.equal(second.clean, false);
  assert.equal(sink.errors.length, 1); // truncated-frame reported only once

  decoder.reset();
  assert.deepEqual(decoder.end(), { clean: true, pendingBytes: 0 });
  decoder.write(frame(new TextEncoder().encode('fresh')));
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'fresh');
});

test('decoder: after an oversized header, a valid embedded frame still recovers correctly', () => {
  // Outer header declares a length above the limit, but its bytes already
  // contain a complete, valid inner frame. Recovery scans from the nearest
  // magic and — because the inner length AND CRC both hold — emits it. A
  // magic-shaped decoy whose CRC fails (see earlier test) is NOT emitted.
  const { decoder, sink } = makeDecoder({ maxPayloadLength: 8 });
  const inner = frame(new TextEncoder().encode('hi'));
  const outer = rawFrame(64, inner, 0); // declared length 64 > 8
  decoder.write(outer);
  assert.deepEqual(sink.errors.map((e) => e.code), ['length-too-large']);
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(Buffer.from(sink.frames[0]!.payload).toString(), 'hi');

  const good = frame(new TextEncoder().encode('ok'));
  decoder.write(good);
  assert.equal(sink.frames.length, 2);
  assert.deepEqual(Buffer.from(sink.frames[1]!.payload).toString(), 'ok');
});
